// 从外部计时平台（xinjinho.com 的 ML01 成绩系统）读取已发布的成绩。
// 网站点“发布”之后公开接口才返回数据；这里只读已发布版本，不写入外部系统。
const BASE_URL = process.env.SCORE_REVIEW_EXTERNAL_BASE || 'https://www.xinjinho.com/score/api/ml01/public'
const CACHE_MS = Number(process.env.SCORE_REVIEW_EXTERNAL_CACHE_MS || 30 * 1000)
const FETCH_TIMEOUT_MS = Number(process.env.SCORE_REVIEW_EXTERNAL_TIMEOUT_MS || 6000)

const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value })
  return value
}

function clearCache() {
  cache.clear()
}

// 赛事名称比对：忽略空格、大小写、全半角差异，以及“（测试用）”这类括号后缀
function normalizeEventName(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[（(][^（）()]*[）)]/g, '')
    .replace(/[\p{P}\p{S}\s　]+/gu, '')
    .toLowerCase()
}

function yearsOf(text) {
  return [...new Set(String(text).match(/20\d{2}/g) || [])].sort().join(',')
}

// 最长公共子序列长度：较短名称里的字，按顺序能在较长名称里找到多少个
function commonSubsequenceLength(left, right) {
  const a = Array.from(left)
  const b = Array.from(right)
  const row = new Array(b.length + 1).fill(0)
  for (const char of a) {
    let previous = 0
    for (let index = 1; index <= b.length; index += 1) {
      const saved = row[index]
      row[index] = char === b[index - 1] ? previous + 1 : Math.max(row[index], row[index - 1])
      previous = saved
    }
  }
  return row[b.length]
}

// 模糊匹配分数 0~1：去掉年份后，较短名称的字有多大比例按顺序出现在较长名称里。
// 例如"2026资兴汽车拉力赛"与"2026湖南资兴汽车拉力赛重磅来袭！"得 1；
// "2026资兴汽车拉力赛"与"2026郴州汽车拉力赛"只得 0.71，不会被当成同一场。
// 两边都写了年份但年份不同，直接判 0，避免把往年的赛事对上。
function eventNameSimilarity(left, right) {
  const a = normalizeEventName(left)
  const b = normalizeEventName(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const yearsA = yearsOf(a)
  const yearsB = yearsOf(b)
  if (yearsA && yearsB && yearsA !== yearsB) return 0
  const textA = a.replace(/20\d{2}/g, '')
  const textB = b.replace(/20\d{2}/g, '')
  const shorter = Array.from(textA).length <= Array.from(textB).length ? textA : textB
  const longer = shorter === textA ? textB : textA
  const length = Array.from(shorter).length
  if (length < 4) return 0
  return commonSubsequenceLength(shorter, longer) / length
}

const FUZZY_MATCH_THRESHOLD = 0.8

async function fetchJson(path, fetchImpl) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null
  try {
    const response = await fetchImpl(BASE_URL + path, controller ? { signal: controller.signal } : undefined)
    if (!response.ok) throw new Error(`外部成绩接口返回 ${response.status}`)
    return await response.json()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 毫秒转成小程序成绩表的时长文本，例如 98530 -> "1:38.530"
function formatDurationMs(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0))
  const millis = '.' + String(ms % 1000).padStart(3, '0')
  const seconds = Math.floor((ms % 60000) / 1000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const hours = Math.floor(ms / 3600000)
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${millis}`
  return `${minutes}:${String(seconds).padStart(2, '0')}${millis}`
}

// 罚时按分:秒.毫秒显示（不足一分钟时只显示秒.毫秒，例如 0:05.000），没有罚时留空
function penaltyText(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0))
  if (!ms) return ''
  const millis = '.' + String(ms % 1000).padStart(3, '0')
  const seconds = Math.floor((ms % 60000) / 1000)
  const minutes = Math.floor(ms / 60000)
  return `${minutes}:${String(seconds).padStart(2, '0')}${millis}`
}

function stageOrder(code) {
  const match = String(code || '').match(/(\d+)/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

// 找出与小程序赛事名称最接近的外部赛事：先找完全同名，再做模糊匹配。
// 分数不够高、或有两场分数并列最高时返回 null，宁可不显示也不把别人的成绩挂到这场赛事下。
async function findExternalEvent(eventName, fetchImpl = fetch) {
  const wanted = normalizeEventName(eventName)
  if (!wanted) return null
  let list = cacheGet('events')
  if (!list) {
    const payload = await fetchJson('/events', fetchImpl)
    // 线上接口返回 { items: [...] }，这里同时兼容 events 字段，避免字段改名后失效
    const items = payload && (Array.isArray(payload.events) ? payload.events : (Array.isArray(payload.items) ? payload.items : []))
    list = cacheSet('events', items)
  }
  const candidates = list.filter(item => item && item.id)
  const exact = candidates.filter(item => normalizeEventName(item.name) === wanted)
  if (exact.length) return exact.length === 1 ? exact[0] : null
  const scored = candidates
    .map(item => ({ item, score: eventNameSimilarity(eventName, item.name) }))
    .filter(entry => entry.score >= FUZZY_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
  if (!scored.length) return null
  if (scored.length > 1 && scored[1].score === scored[0].score) return null
  return scored[0].item
}

function rankOf(row, categoryId) {
  const ranks = row && row.category_ranks
  if (ranks && categoryId != null && ranks[categoryId] != null) return Number(ranks[categoryId])
  return row && row.rank != null ? Number(row.rank) : null
}

// 把外部赛事的已发布成绩转换成小程序成绩表使用的快照结构
async function buildSnapshot(eventId, externalEventId, fetchImpl = fetch) {
  const detail = await fetchJson(`/events/${encodeURIComponent(externalEventId)}`, fetchImpl)
  const stages = (Array.isArray(detail && detail.stages) ? detail.stages : [])
    .filter(stage => stage && stage.id && Number(stage.published_version) > 0)
    .sort((a, b) => stageOrder(a.code) - stageOrder(b.code) || String(a.code).localeCompare(String(b.code)))
  if (!stages.length) return null

  const categories = Array.isArray(detail && detail.categories) ? detail.categories : []
  const categoryName = Object.fromEntries(categories.map(item => [String(item.id), String(item.name || item.short || item.id)]))

  // 各赛段已发布成绩：车号 -> 赛段 -> 用时/罚时
  const stagePayloads = []
  for (const stage of stages) {
    const payload = await fetchJson(`/events/${encodeURIComponent(externalEventId)}/stages/${encodeURIComponent(stage.id)}`, fetchImpl)
    if (payload && payload.published !== false && Array.isArray(payload.rows)) {
      stagePayloads.push({ code: String(stage.code || ''), rows: payload.rows })
    }
  }
  if (!stagePayloads.length) return null

  // 总成绩：网站会把漏赛段补成“规则时间”后再排名，排名以它为准
  let overallRows = []
  try {
    const overall = await fetchJson(`/events/${encodeURIComponent(externalEventId)}/overall`, fetchImpl)
    if (overall && overall.published !== false && Array.isArray(overall.rows)) overallRows = overall.rows
  } catch (error) {
    console.warn('读取外部总成绩失败，仅按已发布赛段计算', error && error.message || error)
  }

  const competitors = new Map() // group \u0000 carNumber -> 条目
  const ensure = (group, carNumber) => {
    const key = `${group}\u0000${carNumber}`
    if (!competitors.has(key)) competitors.set(key, { group, carNumber, driver: '', coDriver: '', stageTimes: {}, totalMs: 0, rank: null, fromOverall: false })
    return competitors.get(key)
  }

  for (const { code, rows } of stagePayloads) {
    if (!code) continue
    for (const row of rows) {
      const carNumber = String(row && row.bib || '').trim()
      if (!carNumber) continue
      const categoryIds = Array.isArray(row.categories) && row.categories.length ? row.categories.map(String) : ['']
      const penalty = penaltyText(row.penalty_ms)
      const duration = formatDurationMs(row.total_ms != null ? row.total_ms : Number(row.time_ms || 0) + Number(row.penalty_ms || 0))
      for (const categoryId of categoryIds) {
        const group = categoryId ? (categoryName[categoryId] || categoryId) : '未分组'
        const item = ensure(group, carNumber)
        // 车手、领航员名字：赛段成绩里可能被网站按设置隐去，总成绩里再补一次
        if (row.name) item.driver = String(row.name).trim()
        if (row.co_driver) item.coDriver = String(row.co_driver).trim()
        item.stageTimes[code] = { startTime: '', endTime: '', penalty, duration }
      }
    }
  }

  for (const row of overallRows) {
    const carNumber = String(row && row.bib || '').trim()
    if (!carNumber) continue
    const categoryIds = Array.isArray(row.categories) && row.categories.length ? row.categories.map(String) : ['']
    for (const categoryId of categoryIds) {
      const group = categoryId ? (categoryName[categoryId] || categoryId) : '未分组'
      const item = ensure(group, carNumber)
      if (row.name) item.driver = String(row.name).trim()
      if (row.co_driver) item.coDriver = String(row.co_driver).trim()
      item.totalMs = Number(row.total_ms || 0)
      item.rank = rankOf(row, categoryId)
      item.fromOverall = true
    }
  }

  const groups = []
  for (const item of competitors.values()) {
    if (!groups.includes(item.group)) groups.push(item.group)
    if (!item.fromOverall) item.totalMs = Object.values(item.stageTimes).reduce((sum, stage) => {
      const parts = String(stage.duration || '').split(':')
      const seconds = parts.length === 3
        ? Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
        : Number(parts[0]) * 60 + Number(parts[1])
      return sum + Math.round((seconds || 0) * 1000)
    }, 0)
  }
  if (!groups.length) return null

  const rows = []
  for (const group of groups) {
    const list = [...competitors.values()]
      .filter(item => item.group === group)
      .sort((a, b) => (a.rank == null ? 1e9 : a.rank) - (b.rank == null ? 1e9 : b.rank)
        || a.totalMs - b.totalMs
        || a.carNumber.localeCompare(b.carNumber, undefined, { numeric: true }))
    let previousMs = null
    let previousRank = 0
    list.forEach((item, index) => {
      const total = formatDurationMs(item.totalMs)
      // 网站给了名次就用它的；没给就按总用时排（并列名次相同）
      if (item.rank == null) {
        if (item.totalMs !== previousMs) previousRank = index + 1
        previousMs = item.totalMs
      }
      rows.push({
        id: `${eventId}-${group}-${item.carNumber}`,
        carNumber: item.carNumber,
        group,
        driver: item.driver,
        coDriver: item.coDriver,
        stageTimes: item.stageTimes,
        bestScore: total,
        totalScore: total,
        validScore: total,
        rank: item.rank == null ? previousRank : item.rank
      })
    })
  }

  const stageNames = stagePayloads.map(item => item.code).filter(Boolean)
  const groupStageNames = Object.fromEntries(groups.map(group => [
    group,
    [...new Set(rows.filter(row => row.group === group).flatMap(row => Object.keys(row.stageTimes)))]
  ]))
  return {
    ok: true,
    eventId,
    source: 'xinjinho',
    externalEventId,
    publishedAt: new Date().toISOString(),
    rankingMode: 'total',
    groups,
    stageNames,
    groupStageNames,
    rowCount: rows.length,
    rows
  }
}

// 返回外部已发布成绩快照；没有同名赛事、没有已发布赛段或读取失败时返回 null，由调用方回退到本系统成绩
async function getExternalResults(eventId, eventName, fetchImpl = fetch) {
  if (String(process.env.SCORE_REVIEW_EXTERNAL_RESULTS || '').trim() === '0') return null
  try {
    const external = await findExternalEvent(eventName, fetchImpl)
    if (!external) return null
    const key = `snapshot:${eventId}:${external.id}`
    const cached = cacheGet(key)
    if (cached) return cached
    const snapshot = await buildSnapshot(eventId, external.id, fetchImpl)
    return snapshot ? cacheSet(key, snapshot) : null
  } catch (error) {
    console.warn('读取外部已发布成绩失败，改用本系统成绩', error && error.message || error)
    return null
  }
}

module.exports = {
  BASE_URL,
  normalizeEventName,
  eventNameSimilarity,
  formatDurationMs,
  findExternalEvent,
  buildSnapshot,
  getExternalResults,
  clearCache
}
