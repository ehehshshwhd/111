const STAGES = new Set(Array.from({ length: 20 }, (_, index) => `SS${index + 1}`))
const { validateEventId } = require('./event-id')

const env = String(process.env.SCORE_REVIEW_CLOUDBASE_ENV || process.env.CBR_ENV_ID || '').trim()
const accessKey = String(process.env.SCORE_REVIEW_CLOUDBASE_APIKEY || process.env.CLOUDBASE_API_KEY || process.env.CLOUDBASE_APIKEY || '').trim()
let database
let cloudClient
let collectionReady
let eventsCollectionReady
let publishedResultsCollectionReady
let publishHistoryCollectionReady
let permissionsCollectionsReady

const PERMISSION_STAGES = Array.from(STAGES)
const ENTRY_PERMISSION_KEYS = ['startTime', 'endTime', 'penalty']
const SUPER_ADMIN_PHONE = String(process.env.SCORE_REVIEW_SUPER_ADMIN_PHONE || '13729912574')
  .replace(/\D/g, '')
  .replace(/^86(?=1\d{10}$)/, '')

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function cleanGroupNames(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function cleanStageNames(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(value => String(value || '').trim().toUpperCase()).filter(stage => STAGES.has(stage)))]
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
}

function cleanGroupStageNames(value, allowedStages = STAGES) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = allowedStages instanceof Set ? allowedStages : new Set(cleanStageNames(allowedStages))
  const result = {}
  for (const [rawGroup, rawStages] of Object.entries(value)) {
    const group = String(rawGroup || '').trim()
    if (!group) continue
    result[group] = cleanStageNames(rawStages).filter(stage => allowed.has(stage))
  }
  return result
}

function cleanSignupOptions(value) {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    const option = item && typeof item === 'object' ? item : { name: item }
    return {
      ...option,
      name: String(option.name || '').trim().slice(0, 120),
      fee: String(option.fee || '').trim().slice(0, 80),
      quota: String(option.quota || '').trim().slice(0, 80),
      note: String(option.note || '').trim().slice(0, 500)
    }
  })
}

function cleanSectionTitles(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const defaults = {
    signup: '赛事报名',
    results: '查看成绩详情',
    info: '赛事信息',
    detail: '赛事详情',
    rules: '竞赛规则',
    awards: '奖项设置'
  }
  return Object.fromEntries([...Object.entries(source).filter(([key]) => !Object.prototype.hasOwnProperty.call(defaults, key)), ...Object.entries(defaults)].map(([key, fallback]) => [
    key,
    String(source[key] || fallback).trim().slice(0, 80) || fallback
  ]))
}

function cleanInfoLabels(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const defaults = {
    date: '比赛时间：',
    deadline: '报名截止：',
    location: '集合地址：',
    contactName: '联系人：',
    phone: '联系电话：',
    wechat: '微信号：'
  }
  return Object.fromEntries([...Object.entries(source).filter(([key]) => !Object.prototype.hasOwnProperty.call(defaults, key)), ...Object.entries(defaults)].map(([key, fallback]) => [
    key,
    String(source[key] == null ? fallback : source[key]).trim().slice(0, 40) || fallback
  ]))
}

function sanitizeRichHtml(value, maxLength = 30000) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:script|style|iframe|object|embed|form)[^>]*>/gi, '')
    .replace(/\s+on[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '')
    .slice(0, maxLength)
}

function cleanContentBlocks(value) {
  if (!Array.isArray(value)) return []
  const supported = new Set(['heading', 'paragraph', 'text', 'note', 'image', 'banner', 'divider', 'list', 'table'])
  const cleanCell = cell => {
    if (cell != null && !['string', 'number'].includes(typeof cell)) throw new Error('表格或列表单元格必须是文字或数字')
    const text = String(cell == null ? '' : cell)
    if (text.length > 1000) throw new Error('表格或列表单元格超过 1000 个字符')
    return text
  }
  if (value.length > 100) throw new Error('赛事正文超过 100 项，拒绝截断读取')
  return value.reduce((blocks, raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`赛事正文第 ${index + 1} 项格式无效`)
    const type = String(raw.type || '').trim().toLowerCase()
    if (!supported.has(type)) throw new Error(`赛事正文第 ${index + 1} 项类型不支持：${type || '空'}`)
    const block = { ...raw, type }
    if (type === 'heading' || type === 'paragraph' || type === 'text' || type === 'note') {
      const text = raw.text == null ? raw.content || '' : raw.text
      if (text != null && !['string', 'number'].includes(typeof text)) throw new Error(`赛事正文第 ${index + 1} 项文字格式无效`)
      block.text = String(text)
      if (block.text.length > 10000) throw new Error(`赛事正文第 ${index + 1} 项文字超过限制`)
      if (raw.html != null && typeof raw.html !== 'string') throw new Error(`赛事正文第 ${index + 1} 项富文本格式无效`)
      if (raw.html != null) block.html = sanitizeRichHtml(raw.html)
    } else if (type === 'image') {
      block.url = String(raw.url || '').trim()
      block.miniUrl = String(raw.miniUrl || '').trim()
      block.fileId = String(raw.fileId || '').trim()
    } else if (type === 'banner') {
      block.theme = ['02', '03'].includes(String(raw.theme)) ? String(raw.theme) : '02'
      block.text = String(raw.text || '')
      block.number = String(raw.number || '')
    } else if (type === 'list') {
      block.items = Array.isArray(raw.items)
        ? raw.items.map(cleanCell).filter(Boolean)
        : String(raw.text || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean)
      if (block.items.length > 200) throw new Error(`赛事正文第 ${index + 1} 项列表超过 200 行`)
    } else if (type === 'table') {
      block.title = String(raw.title || '')
      block.headers = Array.isArray(raw.headers) ? raw.headers.map(cleanCell) : []
      block.rows = Array.isArray(raw.rows)
        ? raw.rows.map(row => {
          if (!Array.isArray(row)) throw new Error(`赛事正文第 ${index + 1} 项表格行格式无效`)
          return row.map(cleanCell)
        })
        : []
      if (block.headers.length > 30 || block.rows.length > 200 || block.rows.some(row => row.length > 30)) throw new Error(`赛事正文第 ${index + 1} 项表格超过支持范围`)
    }
    blocks.push(block)
    return blocks
  }, [])
}

function getDatabase() {
  if (!env) throw new Error('未配置 SCORE_REVIEW_CLOUDBASE_ENV')
  if (!database) {
    const cloudbase = require('@cloudbase/node-sdk')
    const config = { env }
    if (accessKey) config.accessKey = accessKey
    cloudClient = cloudbase.init(config)
    database = cloudClient.database()
  }
  return database
}

function isMissingCollectionError(error) {
  const code = String(error && (error.code || error.errCode) || '').toUpperCase()
  const message = String(error && (error.errMsg || error.message) || error)
  return code.includes('DATABASE_COLLECTION_NOT_EXIST')
    || code === '-502005'
    || message.includes('-502005')
    || /collection.*(not exist|doesn't exist|不存在)/i.test(message)
}

function isMissingDocumentError(error) {
  const code = String(error && (error.code || error.errCode) || '').toUpperCase()
  const message = String(error && (error.errMsg || error.message) || error)
  return code === '-1'
    || code.includes('NOT_FOUND')
    || /document.*(not exist|doesn't exist|not found|不存在)/i.test(message)
}

function cleanEvent(input, id) {
  const source = input || {}
  const stageNames = cleanStageNames(source.stageNames)
  const allowedStages = stageNames.length ? stageNames : STAGES
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => key !== '_id')),
    id: validateEventId(id || source.id || ''),
    title: String(source.title || '').trim().slice(0, 160),
    dateStart: String(source.dateStart || '').slice(0, 20),
    dateEnd: String(source.dateEnd || '').slice(0, 20),
    date: String(source.date || '').trim().slice(0, 100),
    dateFull: String(source.dateFull || source.date || '').trim().slice(0, 100),
    location: String(source.location || '').trim().slice(0, 240),
    status: String(source.status || '报名中').trim().slice(0, 30),
    notice: String(source.notice || '').trim().slice(0, 240),
    detailText: String(source.detailText || '').trim().slice(0, 10000),
    rulesText: String(source.rulesText || '').trim().slice(0, 10000),
    awardsText: String(source.awardsText || '').trim().slice(0, 10000),
    // A complete, user-editable detail page. When configured, clients render
    // this document as the source of truth instead of composing legacy fields.
    detailPageHtml: sanitizeRichHtml(source.detailPageHtml || '', 60000),
    detailPageConfigured: source.detailPageConfigured === true,
    contentBlocks: cleanContentBlocks(source.contentBlocks),
    // Preserve whether blocks were configured so legacy records can seed the
    // template without overriding an intentionally empty page.
    contentBlocksConfigured: source.contentBlocksConfigured === true || Array.isArray(source.contentBlocks),
    registrationDeadline: String(source.registrationDeadline || '').trim().slice(0, 30),
    contactName: String(source.contactName || '').trim().slice(0, 80),
    contactPhone: String(source.contactPhone || '').trim().slice(0, 40),
    contactWechat: String(source.contactWechat || '').trim().slice(0, 80),
    registrationNote: String(source.registrationNote || '').trim().slice(0, 5000),
    signupOptions: cleanSignupOptions(source.signupOptions),
    sectionTitles: cleanSectionTitles(source.sectionTitles),
    infoLabels: cleanInfoLabels(source.infoLabels),
    coverUrl: String(source.coverUrl || '').trim().slice(0, 2000),
    coverFileId: String(source.coverFileId || '').trim().slice(0, 500),
    groups: cleanGroupNames(source.groups),
    visibleGroups: cleanGroupNames(source.visibleGroups),
    stageNames,
    groupStageNames: cleanGroupStageNames(source.groupStageNames, allowedStages),
    // The current race workflow is intentionally fixed to rally timing and
    // cumulative stage time. Keep the invariant at the storage boundary.
    scoringType: 'rally',
    rankingMode: 'total',
    registrationEnabled: source.registrationEnabled === true,
    workBackendEnabled: source.workBackendEnabled !== false,
    published: source.published !== false,
    templateEventId: source.templateEventId ? validateEventId(source.templateEventId) : '',
    publishedAt: source.publishedAt || null,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null
  }
}

function validateEventInput(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const allowedBlockTypes = new Set(['heading', 'paragraph', 'text', 'note', 'image', 'banner', 'divider', 'list', 'table'])
  const checkTextType = (value, label) => {
    if (value != null && !['string', 'number'].includes(typeof value)) throw new Error(`${label}必须是文字或数字，不能自动转换后保存`)
  }
  const checkLength = (value, max, label) => {
    checkTextType(value, label)
    if (value != null && String(value).length > max) throw new Error(`${label}最多 ${max} 个字符，请拆分后再保存，避免内容被截断`)
  }
  const fieldLimits = [
    ['title', 160, '赛事名称'], ['dateStart', 20, '开始日期'], ['dateEnd', 20, '结束日期'],
    ['date', 100, '顶部日期'], ['dateFull', 100, '比赛时间'], ['location', 240, '地点'],
    ['status', 30, '赛事状态'], ['notice', 240, '公告'], ['detailText', 10000, '赛事详情'],
    ['rulesText', 10000, '比赛规则'], ['awardsText', 10000, '奖项设置'],
    ['detailPageHtml', 60000, '完整赛事详情'],
    ['registrationDeadline', 30, '报名截止日期'], ['contactName', 80, '联系人'],
    ['contactPhone', 40, '联系电话'], ['contactWechat', 80, '联系微信'],
    ['registrationNote', 5000, '报名说明'], ['coverUrl', 2000, '封面地址'], ['coverFileId', 500, '封面文件 ID']
  ]
  fieldLimits.forEach(([key, max, label]) => checkLength(source[key], max, label))
  for (const key of ['groups', 'visibleGroups', 'signupOptions', 'contentBlocks', 'stageNames']) {
    if (source[key] != null && !Array.isArray(source[key])) throw new Error(`${key} 格式无效，请刷新页面后重试`)
  }
  if (source.groupStageNames != null && (typeof source.groupStageNames !== 'object' || Array.isArray(source.groupStageNames))) {
    throw new Error('组别赛段设置格式无效，请刷新页面后重试')
  }
  for (const key of ['stageNames', 'groupStageNames']) {
    if (source[key] == null) continue
    const entries = key === 'stageNames'
      ? source.stageNames.map((stage, index) => [`赛段 ${index + 1}`, stage])
      : Object.entries(source.groupStageNames).flatMap(([group, values]) => {
        if (!Array.isArray(values)) throw new Error(`组别“${group}”的赛段设置格式无效`)
        return values.map(stage => [`组别“${group}”赛段`, stage])
      })
    entries.forEach(([label, stage]) => {
      if (!STAGES.has(String(stage || '').trim().toUpperCase())) throw new Error(`${label}包含不支持的赛段：${stage}`)
    })
  }
  if (source.visibleGroups && Array.isArray(source.groups)) {
    const groups = new Set(source.groups.map(value => String(value || '').trim()))
    const unknown = source.visibleGroups.find(value => !groups.has(String(value || '').trim()))
    if (unknown) throw new Error(`发布组别“${unknown}”不在赛事组别列表中`)
  }
  for (const key of ['groups', 'visibleGroups']) {
    if (!Array.isArray(source[key])) continue
    const seen = new Set()
    source[key].forEach((value, index) => {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 第 ${index + 1} 项必须是非空组别名称`)
      const name = value.trim()
      if (seen.has(name)) throw new Error(`${key} 中组别“${name}”重复`)
      seen.add(name)
    })
  }
  for (const [key, max] of Object.entries({ groups: 100, visibleGroups: 100, signupOptions: 100, contentBlocks: 100 })) {
    if (Array.isArray(source[key]) && source[key].length > max) throw new Error(`${key} 最多支持 ${max} 项，请拆分后再保存`)
  }
  for (const [key, max] of Object.entries({ sectionTitles: 80, infoLabels: 40 })) {
    const values = source[key]
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      for (const [name, value] of Object.entries(values)) checkLength(value, max, `${key}.${name}`)
    }
  }
  if (Array.isArray(source.groups)) source.groups.forEach((value, index) => checkLength(value, 100, `组别 ${index + 1}`))
  if (Array.isArray(source.visibleGroups)) source.visibleGroups.forEach((value, index) => checkLength(value, 100, `发布组别 ${index + 1}`))
  if (Array.isArray(source.signupOptions)) source.signupOptions.forEach((item, index) => {
    if (item != null && typeof item !== 'object') checkTextType(item, `报名项 ${index + 1}`)
    if (item != null && typeof item === 'object' && Array.isArray(item)) throw new Error(`报名项 ${index + 1} 格式无效`)
    const option = item && typeof item === 'object' ? item : { name: item }
    ;[['name', 120], ['fee', 80], ['quota', 80], ['note', 500]].forEach(([key, max]) => checkLength(option[key], max, `报名项 ${index + 1} ${key}`))
    if (!String(option.name || '').trim()) throw new Error(`报名项 ${index + 1} 缺少名称`)
  })
  if (Array.isArray(source.contentBlocks)) source.contentBlocks.forEach((block, index) => {
    const label = `正文第 ${index + 1} 项`
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error(`${label}格式无效`)
    const type = String(block.type || '').toLowerCase()
    if (!allowedBlockTypes.has(type)) throw new Error(`${label}类型“${type || '空'}”不支持，请检查后再保存`)
    if (['heading', 'paragraph', 'text', 'note'].includes(type)) { checkLength(block.text == null ? block.content : block.text, 10000, `${label}文字`); checkLength(block.html, 30000, `${label}富文本`) }
    if (type === 'image') {
      [['url', 2000], ['miniUrl', 2000], ['fileId', 500]].forEach(([key, max]) => checkLength(block[key], max, `${label}图片${key}`))
      if (!String(block.url || '').trim() && !String(block.miniUrl || '').trim() && !String(block.fileId || '').trim()) throw new Error(`${label}图片尚未上传`)
    }
    if (type === 'banner') {
      [['text', 1000], ['number', 20]].forEach(([key, max]) => checkLength(block[key], max, `${label}${key}`))
      checkTextType(block.theme, `${label}样式`)
    }
    if (type === 'list') {
      if (block.items != null && !Array.isArray(block.items)) throw new Error(`${label}列表格式无效`)
      checkLength(block.text, 200000, `${label}列表文字`)
      const items = Array.isArray(block.items) ? block.items : String(block.text || '').split(/\r?\n/)
      if (items.length > 200) throw new Error(`${label}列表最多支持 200 项`)
      items.forEach((item, itemIndex) => checkLength(item, 1000, `${label}列表第 ${itemIndex + 1} 项`))
    }
    if (type === 'table') {
      checkLength(block.title, 300, `${label}表格标题`)
      if (block.headers != null && !Array.isArray(block.headers)) throw new Error(`${label}表格表头格式无效`)
      if (block.rows != null && (!Array.isArray(block.rows) || block.rows.some(row => !Array.isArray(row)))) throw new Error(`${label}表格行格式无效`)
      if (Array.isArray(block.headers) && block.headers.length > 30) throw new Error(`${label}表格最多支持 30 列`)
      if (Array.isArray(block.rows) && block.rows.length > 200) throw new Error(`${label}表格最多支持 200 行`)
      if (Array.isArray(block.rows) && block.rows.some(row => row.length > 30)) throw new Error(`${label}表格最多支持 30 列`)
      const headers = Array.isArray(block.headers) ? block.headers : []
      const cells = (Array.isArray(block.rows) ? block.rows : []).reduce((all, row) => all.concat(Array.isArray(row) ? row : []), [])
      ;[...headers, ...cells].forEach((cell, cellIndex) => checkLength(cell, 1000, `${label}表格单元格 ${cellIndex + 1}`))
    }
  })
  if (source.groupStageNames && typeof source.groupStageNames === 'object' && !Array.isArray(source.groupStageNames)) {
    const entries = Object.entries(source.groupStageNames)
    if (entries.length > 100) throw new Error('每场赛事最多配置 100 个组别')
    entries.forEach(([name], index) => checkLength(name, 100, `组别 ${index + 1}`))
  }
  if (source.sectionTitles != null && (!source.sectionTitles || typeof source.sectionTitles !== 'object' || Array.isArray(source.sectionTitles))) throw new Error('赛事分区标题格式无效')
  if (source.infoLabels != null && (!source.infoLabels || typeof source.infoLabels !== 'object' || Array.isArray(source.infoLabels))) throw new Error('赛事信息标签格式无效')
  if (source.sectionTitles && typeof source.sectionTitles === 'object') Object.entries(source.sectionTitles).forEach(([key, value]) => {
    if (!['signup', 'results', 'info', 'detail', 'rules', 'awards'].includes(key)) throw new Error(`不支持的赛事分区标题：${key}`)
    checkLength(value, 80, `分区标题 ${key}`)
  })
  if (source.infoLabels && typeof source.infoLabels === 'object') Object.entries(source.infoLabels).forEach(([key, value]) => {
    if (!['date', 'deadline', 'location', 'contactName', 'phone', 'wechat'].includes(key)) throw new Error(`不支持的赛事信息标签：${key}`)
    checkLength(value, 40, `信息标签 ${key}`)
  })
}

async function ensureEventsCollection(db) {
  if (!eventsCollectionReady) {
    eventsCollectionReady = (async () => {
      try {
        await db.collection('events').limit(1).get()
      } catch (error) {
        if (!isMissingCollectionError(error)) throw error
        try { await db.createCollection('events') } catch { await db.collection('events').limit(1).get() }
      }
    })().catch(error => {
      eventsCollectionReady = null
      throw error
    })
  }
  return eventsCollectionReady
}

async function listEvents(options = {}) {
  const db = getDatabase()
  await ensureEventsCollection(db)
  // CloudBase caps a single query at 1,000 records. Paginate so older events
  // remain visible instead of silently disappearing after the first page.
  const records = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const result = await db.collection('events').skip(offset).limit(pageSize).get()
    const page = result.data || []
    records.push(...page)
    if (page.length < pageSize) break
  }
  records.forEach((record, index) => {
    try { validateEventInput(record) }
    catch (error) { throw new Error(`云端第 ${index + 1} 个赛事数据不完整：${error.message}`) }
  })
  const events = records.map(record => cleanEvent(record, record.id || record._id))
    // A deleted event remains in the database for audit/history and to keep
    // its scores isolated, but it must disappear from every public/admin
    // picker that asks for published events.
    .filter(event => event.id && !event.deletedAt && (!options.publishedOnly || event.published))
    .sort((a, b) => new Date(b.publishedAt || b.createdAt || 0).getTime() - new Date(a.publishedAt || a.createdAt || 0).getTime()
      || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
  const eventIds = new Set()
  for (const event of events) {
    if (eventIds.has(event.id)) throw new Error(`云端赛事 ID 重复：${event.id}；请先清理重复赛事后再读取`)
    eventIds.add(event.id)
  }
  const fileIds = [...new Set(events.flatMap(event => [event.coverFileId, ...event.contentBlocks.map(block => block.type === 'image' ? block.fileId : '')]).filter(Boolean))]
  if (fileIds.length) {
    const urlById = new Map()
    const batchSize = 50
    const concurrency = 5
    for (let offset = 0; offset < fileIds.length; offset += batchSize * concurrency) {
      const batches = Array.from({ length: concurrency }, (_, index) => fileIds.slice(offset + index * batchSize, offset + (index + 1) * batchSize)).filter(batch => batch.length)
      // A stale/deleted image must not make the whole events endpoint fail.
      // Keep the event and any still-valid URLs; the mini-program can retry a
      // file ID independently when it receives the record.
      const results = await Promise.allSettled(batches.map(batch => cloudClient.getTempFileURL({ fileList: batch.map(fileID => ({ fileID, maxAge: 3600 })) })))
      results.filter(result => result.status === 'fulfilled').flatMap(result => result.value && result.value.fileList || []).forEach(item => {
        if (item.tempFileURL) urlById.set(item.fileID, item.tempFileURL)
      })
    }
    events.forEach(event => {
      if (event.coverFileId && urlById.get(event.coverFileId)) event.coverUrl = urlById.get(event.coverFileId)
      event.contentBlocks.forEach(block => {
        const refreshedUrl = block.type === 'image' && block.fileId && urlById.get(block.fileId)
        if (refreshedUrl) { block.url = refreshedUrl; if (!block.miniUrl) block.miniUrl = refreshedUrl }
      })
    })
  }
  return events
}

// Soft-delete an event.  Scores, published snapshots and media are kept so a
// mistaken removal does not destroy the audit trail or affect another event;
// all public reads are filtered by deletedAt above.
async function deleteEvent(eventId) {
  const id = validateEventId(eventId)
  if (['preview', 'default'].includes(id)) throw new Error('赛事 ID 无效：不能删除本地预览或默认赛事')
  const db = getDatabase()
  await ensureEventsCollection(db)
  const result = await db.collection('events').where({ id }).limit(2).get()
  if (result.data && result.data.length > 1) throw new Error(`云端赛事 ID 重复：${id}；未删除任何赛事`)
  const record = result.data && result.data[0]
  if (!record || !record._id) throw new Error('没有找到该赛事，未删除任何数据')
  if (record.deletedAt) {
    return { id, deleted: true, deletedAt: record.deletedAt }
  }
  const deletedAt = new Date()
  await db.collection('events').doc(record._id).update({ published: false, deletedAt, updatedAt: deletedAt })
  const verified = await db.collection('events').where({ id }).limit(2).get()
  if (!verified.data || verified.data.length !== 1 || !verified.data[0].deletedAt || verified.data[0].published !== false) {
    throw new Error('赛事删除后云端回读核对失败，请刷新确认赛事状态')
  }
  return { id, deleted: true, deletedAt: verified.data[0].deletedAt }
}

async function saveEvent(input) {
  validateEventInput(input)
  const existingId = input && input.id != null && input.id !== '' ? validateEventId(input.id) : ''
  const db = getDatabase()
  await ensureEventsCollection(db)
  const now = new Date()
  const id = existingId || `event-${now.getTime()}-${require('node:crypto').randomBytes(4).toString('hex')}`
  const event = cleanEvent(input, id)
  const isDraft = input && input.saveMode === 'draft'
  if (!isDraft && !event.title) throw new Error('请填写赛事名称')
  if (!isDraft && (!event.dateStart || !event.dateEnd)) throw new Error('请填写赛事开始和结束日期')
  if (!isDraft && !event.location) throw new Error('请填写赛事地点')
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > 700 * 1024) throw new Error('赛事详情超过 CloudBase 单文档安全大小，请减少正文文字/图片数量后再保存')
  const query = await db.collection('events').where({ id }).limit(2).get()
  if (query.data && query.data.length > 1) throw new Error(`云端赛事 ID 重复：${id}；未继续保存以避免覆盖错误赛事`)
  let previous = query.data && query.data[0]
  // Older documents used the CloudBase document ID as the public event ID.
  // Update that document in place rather than inserting a duplicate event.
  if (!previous && existingId) {
    try {
      const legacy = await db.collection('events').doc(existingId).get()
      previous = legacy && legacy.data && (Array.isArray(legacy.data) ? legacy.data[0] : legacy.data)
    } catch (error) {
      if (!/not exist|不存在|document.*found/i.test(String(error && (error.message || error.errMsg) || error))) throw error
    }
  }
  const asDate = value => {
    if (!value) return now
    const date = value instanceof Date ? value : new Date(value)
    return Number.isFinite(date.getTime()) ? date : now
  }
  const publishedAt = event.published ? asDate(previous && previous.publishedAt) : null
  const createdAt = asDate(previous && previous.createdAt)
  const data = { ...(previous || {}), ...event, id, publishedAt, updatedAt: now, createdAt }
  delete data._id
  if (previous) await db.collection('events').doc(previous._id).update(data)
  else await db.collection('events').add(data)
  const verified = await db.collection('events').where({ id }).limit(2).get()
  if (verified.data && verified.data.length > 1) throw new Error(`赛事写入后发现重复 ID：${id}；请先清理重复记录`)
  const saved = verified.data && verified.data[0]
  if (!saved) throw new Error('赛事写入后云端回读失败，请刷新确认后再操作')
  const confirmed = cleanEvent(saved, saved.id || saved._id)
  const transferFields = Object.keys(event).filter(key => !['createdAt', 'updatedAt', 'publishedAt'].includes(key))
  const expectedTransfer = Object.fromEntries(transferFields.map(key => [key, event[key]]))
  const confirmedTransfer = Object.fromEntries(transferFields.map(key => [key, confirmed[key]]))
  if (confirmed.id !== id || stableStringify(confirmedTransfer) !== stableStringify(expectedTransfer)) throw new Error('赛事写入后回读内容与提交不一致，请刷新确认')
  return confirmed
}

async function uploadEventCover({ fileName, mimeType, data }) {
  if (!/^image\/(jpeg|png|webp)$/.test(String(mimeType || ''))) throw new Error('封面只支持 JPG、PNG 或 WebP 图片')
  const base64 = String(data || '').replace(/^data:image\/(?:jpeg|png|webp);base64,/i, '')
  const file = Buffer.from(base64, 'base64')
  if (!file.length || file.length > 5 * 1024 * 1024) throw new Error('图片大小需在 5MB 以内')
  getDatabase()
  const safeName = String(fileName || 'cover').replace(/[^a-z0-9._-]/gi, '_').slice(-80)
  const cloudPath = `events/covers/${Date.now()}-${require('node:crypto').randomBytes(4).toString('hex')}-${safeName}`
  const uploaded = await cloudClient.uploadFile({ cloudPath, fileContent: file })
  const urls = await cloudClient.getTempFileURL({ fileList: [{ fileID: uploaded.fileID, maxAge: 3600 }] })
  return { coverFileId: uploaded.fileID, coverUrl: urls.fileList && urls.fileList[0] && urls.fileList[0].tempFileURL || '' }
}

async function getEventCoverTempUrl(fileId) {
  const id = String(fileId || '').trim()
  if (!id) throw new Error('封面文件 ID 为空')
  getDatabase()
  const result = await cloudClient.getTempFileURL({ fileList: [{ fileID: id, maxAge: 3600 }] })
  const item = result && Array.isArray(result.fileList) ? result.fileList[0] : null
  if (!item || !item.tempFileURL) throw new Error('封面文件不存在或已被删除')
  return item.tempFileURL
}

async function uploadEventAsset({ fileName, mimeType, data }) {
  if (!/^image\/(jpeg|png|webp)$/.test(String(mimeType || ''))) throw new Error('图片只支持 JPG、PNG 或 WebP')
  const base64 = String(data || '').replace(/^data:image\/(?:jpeg|png|webp);base64,/i, '')
  const file = Buffer.from(base64, 'base64')
  if (!file.length || file.length > 5 * 1024 * 1024) throw new Error('图片大小需在 5MB 以内')
  getDatabase()
  const safeName = String(fileName || 'event-image').replace(/[^a-z0-9._-]/gi, '_').slice(-80)
  const cloudPath = 'events/content/' + Date.now() + '-' + require('node:crypto').randomBytes(4).toString('hex') + '-' + safeName
  const uploaded = await cloudClient.uploadFile({ cloudPath, fileContent: file })
  const urls = await cloudClient.getTempFileURL({ fileList: [{ fileID: uploaded.fileID, maxAge: 3600 }] })
  return { fileId: uploaded.fileID, url: urls.fileList && urls.fileList[0] && urls.fileList[0].tempFileURL || '' }
}

function normalizePermissionPhone(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 15)
}

function isSuperAdminPhone(value) {
  const phone = normalizePermissionPhone(value)
  return phone === SUPER_ADMIN_PHONE || phone === `86${SUPER_ADMIN_PHONE}`
}

function normalizePermissionStages(value) {
  if (!Array.isArray(value)) return PERMISSION_STAGES.slice()
  return [...new Set(value.map(item => String(item || '').toUpperCase()).filter(stage => STAGES.has(stage)))].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
}

function normalizeEntryPermissions(value, role = 'staff') {
  if (role === 'admin') return { startTime: true, endTime: true, penalty: true }
  const source = value && typeof value === 'object' ? value : {}
  return Object.fromEntries(ENTRY_PERMISSION_KEYS.map(key => [key, source[key] !== false]))
}

function permissionView(record, role) {
  return {
    id: String(record && (record._id || record.id) || ''),
    phoneNumber: normalizePermissionPhone(record && record.phoneNumber),
    countryCode: String(record && record.countryCode || '86').slice(0, 6),
    label: String(record && record.label || '').trim().slice(0, 30),
    enabled: record ? record.enabled !== false : false,
    role,
    isSuperAdmin: isSuperAdminPhone(record && record.phoneNumber),
    stagePermissions: role === 'admin' ? PERMISSION_STAGES.slice() : normalizePermissionStages(record && record.stagePermissions),
    entryPermissions: normalizeEntryPermissions(record && record.entryPermissions, role),
    createdAt: record && record.createdAt || null,
    updatedAt: record && record.updatedAt || null
  }
  if (Array.isArray(source.groups)) source.groups.forEach((value, index) => {
    if (!String(value || '').trim()) throw new Error(`组别 ${index + 1} 不能为空`)
  })
  if (Array.isArray(source.visibleGroups)) source.visibleGroups.forEach((value, index) => {
    if (!String(value || '').trim()) throw new Error(`发布组别 ${index + 1} 不能为空`)
  })
}

async function ensurePermissionsCollections(db) {
  if (!permissionsCollectionsReady) {
    permissionsCollectionsReady = Promise.all(['admin_users', 'staff_users'].map(async name => {
      try {
        await db.collection(name).limit(1).get()
      } catch (error) {
        if (!isMissingCollectionError(error)) throw error
        try { await db.createCollection(name) } catch { await db.collection(name).limit(1).get() }
      }
    })).catch(error => {
      permissionsCollectionsReady = null
      throw error
    })
  }
  return permissionsCollectionsReady
}

async function permissionRows(db, collection, phoneNumber, countryCode) {
  const query = db.collection(collection)
  if (phoneNumber) {
    const result = await query.where({ phoneNumber, countryCode }).limit(20).get()
    return result.data || []
  }
  const result = await query.limit(200).get()
  return result.data || []
}

async function listPermissions() {
  const db = getDatabase()
  await ensurePermissionsCollections(db)
  const [admins, staff] = await Promise.all([permissionRows(db, 'admin_users'), permissionRows(db, 'staff_users')])
  const sortRows = rows => rows.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
  return {
    admins: sortRows(admins).map(item => permissionView(item, 'admin')),
    staff: sortRows(staff).map(item => permissionView(item, 'staff'))
  }
}

function assertPermissionInput(input) {
  const phoneNumber = normalizePermissionPhone(input && input.phoneNumber)
  if (phoneNumber.length < 5) throw new Error('请输入正确的手机号')
  const role = String(input && input.role || 'staff').toLowerCase() === 'admin' ? 'admin' : 'staff'
  const stagePermissions = normalizePermissionStages(input && input.stagePermissions)
  if (role === 'staff' && stagePermissions.length === 0) throw new Error('工作人员至少需要一个赛段权限')
  return { phoneNumber, role, stagePermissions, countryCode: String(input && input.countryCode || '86').slice(0, 6), label: String(input && input.label || '').trim().slice(0, 30), entryPermissions: normalizeEntryPermissions(input && input.entryPermissions, role) }
}

async function upsertPermission(input) {
  const db = getDatabase()
  await ensurePermissionsCollections(db)
  const normalized = assertPermissionInput(input)
  if (isSuperAdminPhone(normalized.phoneNumber)) {
    if (normalized.role !== 'admin') throw new Error('最高管理员不能改为工作人员')
    return listPermissions()
  }
  const adminMatches = await permissionRows(db, 'admin_users', normalized.phoneNumber, normalized.countryCode)
  if (adminMatches.length && normalized.role !== 'admin') throw new Error('管理员不能降级为工作人员')
  const collection = normalized.role === 'admin' ? 'admin_users' : 'staff_users'
  const otherCollection = normalized.role === 'admin' ? 'staff_users' : 'admin_users'
  const now = new Date()
  const data = { phoneNumber: normalized.phoneNumber, countryCode: normalized.countryCode, label: normalized.label, enabled: true, stagePermissions: normalized.stagePermissions, entryPermissions: normalized.entryPermissions, updatedAt: now }
  const existing = await permissionRows(db, collection, normalized.phoneNumber, normalized.countryCode)
  if (existing.length) await db.collection(collection).doc(existing[0]._id).update(data)
  else await db.collection(collection).add({ ...data, createdAt: now })
  const duplicates = await permissionRows(db, otherCollection, normalized.phoneNumber, normalized.countryCode)
  await Promise.all(duplicates.map(item => db.collection(otherCollection).doc(item._id).remove()))
  return listPermissions()
}

async function updatePermission(input) {
  const db = getDatabase()
  await ensurePermissionsCollections(db)
  const role = String(input && input.role || 'staff').toLowerCase() === 'admin' ? 'admin' : 'staff'
  const id = String(input && input.id || '').trim()
  if (!id) throw new Error('权限记录不存在')
  const collection = role === 'admin' ? 'admin_users' : 'staff_users'
  const result = await db.collection(collection).doc(id).get()
  const record = result.data
  if (!record) throw new Error('权限记录不存在')
  if (isSuperAdminPhone(record.phoneNumber)) throw new Error('最高管理员不能停用')
  await db.collection(collection).doc(id).update({ enabled: input && input.enabled !== false, updatedAt: new Date() })
  return listPermissions()
}

async function deletePermission(input) {
  const db = getDatabase()
  await ensurePermissionsCollections(db)
  const role = String(input && input.role || 'staff').toLowerCase() === 'admin' ? 'admin' : 'staff'
  const id = String(input && input.id || '').trim()
  if (!id) throw new Error('权限记录不存在')
  const collection = role === 'admin' ? 'admin_users' : 'staff_users'
  const result = await db.collection(collection).doc(id).get()
  const record = result.data
  if (!record) throw new Error('权限记录不存在')
  if (isSuperAdminPhone(record.phoneNumber)) throw new Error('最高管理员不能移除')
  await db.collection(collection).doc(id).remove()
  return listPermissions()
}

function cleanRows(rows) {
  if (!Array.isArray(rows)) throw new Error('成绩列表格式无效')
  if (rows.length > 1000) throw new Error('每个赛段最多保存 1000 条成绩，云端数据超过限制，已停止读取以免显示不完整')
  const seenCars = new Set()
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`第 ${index + 1} 条成绩格式无效`)
    const rawCar = String(row.carNumber || row.car || '')
    const carNumber = rawCar.replace(/[^0-9a-z]/gi, '').toUpperCase()
    if (!carNumber) throw new Error(`第 ${index + 1} 条成绩没有有效车号`)
    if (carNumber.length > 12) throw new Error(`第 ${index + 1} 条成绩车号超过 12 位`)
    if (seenCars.has(carNumber)) throw new Error(`车号 ${carNumber} 在云端重复，已停止读取以免数据错配`)
    seenCars.add(carNumber)
    for (const [field, max] of Object.entries({ id: 80, group: 100, groupName: 100, teamName: 100, driver: 80, name: 80, stage1: 24, stage2: 24, stage3: 24, validScore: 24, startTime: 24, start: 24, endTime: 24, finish: 24, penaltyTotal: 16, penalty: 16, segmentDuration: 24, totalDuration: 24, duration: 24, uploader: 80, uploadedAt: 80, note: 500 })) {
      if (row[field] != null && String(row[field]).length > max) throw new Error(`第 ${index + 1} 条成绩的 ${field} 超出长度限制`)
    }
    if (row.penaltyInputs != null && !Array.isArray(row.penaltyInputs)) throw new Error(`第 ${index + 1} 条成绩罚时格式无效`)
    if (Array.isArray(row.penaltyInputs) && row.penaltyInputs.length > 10) throw new Error(`第 ${index + 1} 条成绩罚时项目超过 10 项`)
    if (Array.isArray(row.penaltyInputs)) row.penaltyInputs.forEach((item, penaltyIndex) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 条成绩第 ${penaltyIndex + 1} 项罚时格式无效`)
      if (String(item.id || '').length > 80 || String(item.value || '').length > 12) throw new Error(`第 ${index + 1} 条成绩第 ${penaltyIndex + 1} 项罚时超出长度限制`)
    })
    const checkText = (value, field, max) => {
      const text = String(value || '')
      if (text.length > max) throw new Error(`第 ${index + 1} 条成绩的 ${field} 超出长度限制`)
      return text
    }
    const custom = { ...row }
    ;['_id', '_openid', 'openid', 'eventId', 'stage', 'revision', 'createdAt', 'updatedAt', 'updatedBy', 'updatedByPhone', 'updatedByRole'].forEach(key => delete custom[key])
    return {
    ...custom,
    id: checkText(row.id || `web-${index}`, 'id', 80),
    carNumber,
    group: checkText((row.group || row.groupName || row.teamName || '').trim(), 'group', 100),
    teamName: checkText((row.teamName || row.groupName || row.group || '').trim(), 'teamName', 100),
    driver: checkText((row.driver || row.name || '').trim(), 'driver', 80),
    stage1: checkText(row.stage1, 'stage1', 24),
    stage2: checkText(row.stage2, 'stage2', 24),
    stage3: checkText(row.stage3, 'stage3', 24),
    validScore: checkText(row.validScore, 'validScore', 24),
    imported: row && row.imported === true,
    importedStage: checkText(row.importedStage, 'importedStage', 24),
    startTime: checkText(row.startTime || row.start, 'startTime', 24),
    endTime: checkText(row.endTime || row.finish, 'endTime', 24),
    penaltyInputs: Array.isArray(row && row.penaltyInputs) ? row.penaltyInputs.map((item, penaltyIndex) => ({
      ...item,
      id: checkText(item.id || `penalty-${penaltyIndex}`, 'penalty id', 80),
      value: checkText(item.value, 'penalty value', 12)
    })) : [],
    penaltyTotal: checkText(row.penaltyTotal || row.penalty, 'penaltyTotal', 16),
    segmentDuration: checkText(row.segmentDuration || row.duration, 'segmentDuration', 24),
    totalDuration: checkText(row.totalDuration || row.duration, 'totalDuration', 24),
    durationManual: row && row.durationManual === true,
    uploader: checkText(row.uploader, 'uploader', 80),
    uploadedAt: checkText(row.uploadedAt, 'uploadedAt', 80),
    note: checkText(row.note, 'note', 500),
    status: ['approved', 'returned', 'pending'].includes(String(row && row.status || '').toLowerCase())
      ? String(row.status).toLowerCase()
      : 'pending'
    }
  })
}

function parseDurationMs(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (!match) return null
  return Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number((match[4] || '').padEnd(3, '0'))
}

function parsePenaltyMs(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text || text === '0') return 0
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const clock = text.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (clock) return Number(clock[1]) * 3600000 + Number(clock[2]) * 60000 + Number(clock[3]) * 1000 + Number((clock[4] || '').padEnd(3, '0'))
  let total = 0
  let match
  const unitPattern = /(\d+(?:\.\d+)?)\s*(h|小时|m|min|分钟|s|秒)/g
  while ((match = unitPattern.exec(text))) {
    const amount = Number(match[1])
    total += match[2] === 'h' || match[2] === '小时' ? amount * 3600000
      : match[2] === 'm' || match[2] === 'min' || match[2] === '分钟' ? amount * 60000
        : amount * 1000
  }
  return Math.round(total)
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value < 0) return ''
  const hours = Math.floor(value / 3600000)
  const minutes = Math.floor(value % 3600000 / 60000)
  const seconds = Math.floor(value % 60000 / 1000)
  const millis = Math.round(value % 1000)
  return `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

function resultTimes(row) {
  if (row.durationManual === true) {
    const manualSegment = parseDurationMs(row.segmentDuration)
    if (manualSegment !== null) {
      const manualPenalty = parsePenaltyMs(row.penaltyTotal)
      return { elapsed: manualSegment, effective: manualSegment + manualPenalty }
    }
  }
  const start = parseDurationMs(row.startTime)
  const end = parseDurationMs(row.endTime)
  const penalty = parsePenaltyMs(row.penaltyTotal)
  if (start !== null && end !== null) {
    let elapsed = end - start
    if (elapsed < 0) elapsed += 24 * 3600000
    return { elapsed, effective: elapsed + penalty }
  }

  const segment = parseDurationMs(row.segmentDuration)
  if (segment !== null) return { elapsed: segment, effective: segment + penalty }

  // Older imports sometimes contain only totalDuration. Treat it as the
  // penalty-inclusive value, while retaining a separate displayed stage time.
  const total = parseDurationMs(row.totalDuration)
  if (total !== null) return { elapsed: Math.max(0, total - penalty), effective: total }
  return null
}

async function ensurePublishedResultsCollection(db) {
  if (!publishedResultsCollectionReady) {
    publishedResultsCollectionReady = (async () => {
      try {
        await db.collection('published_results').limit(1).get()
      } catch (error) {
        if (!isMissingCollectionError(error)) throw error
        try { await db.createCollection('published_results') } catch { await db.collection('published_results').limit(1).get() }
      }
    })().catch(error => {
      publishedResultsCollectionReady = null
      throw error
    })
  }
  return publishedResultsCollectionReady
}

async function ensurePublishHistoryCollection(db) {
  if (!publishHistoryCollectionReady) {
    publishHistoryCollectionReady = (async () => {
      try { await db.collection('publish_history').limit(1).get() } catch (error) {
        if (!isMissingCollectionError(error)) throw error
        try { await db.createCollection('publish_history') } catch { await db.collection('publish_history').limit(1).get() }
      }
    })().catch(error => { publishHistoryCollectionReady = null; throw error })
  }
  return publishHistoryCollectionReady
}

function publicationSummary(snapshot) {
  return {
    eventId: snapshot.eventId,
    publishedAt: snapshot.publishedAt,
    rankingMode: snapshot.rankingMode,
    groups: snapshot.groups,
    stageNames: snapshot.stageNames,
    groupStageNames: snapshot.groupStageNames,
    rowCount: snapshot.rowCount
  }
}

async function listPublishHistory(eventId) {
  const id = validateEventId(eventId)
  const current = await getPublishedResults(id)
  const db = getDatabase()
  await ensurePublishHistoryCollection(db)
  const history = []
  // Equality-only queries need no composite index. Read all pages rather than
  // silently treating the default query limit as the full history.
  for (let offset = 0; ; offset += 100) {
    const page = await db.collection('publish_history').where({ eventId: id }).skip(offset).limit(100).get()
    const entries = Array.isArray(page.data) ? page.data : []
    history.push(...entries.map(publicationSummary))
    if (entries.length < 100) break
  }
  if (current.publishedAt && !history.some(item => item.publishedAt === current.publishedAt)) history.push(publicationSummary(current))
  history.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
  return { eventId: id, current, history }
}

async function ensureCollection(db) {
  if (!collectionReady) {
    collectionReady = (async () => {
      try {
        await db.collection('work_records').limit(1).get()
      } catch (error) {
        if (!isMissingCollectionError(error)) throw error
        try { await db.createCollection('work_records') } catch { await db.collection('work_records').limit(1).get() }
      }
    })().catch(error => {
      collectionReady = null
      throw error
    })
  }
  return collectionReady
}

function validate(eventId, stage) {
  if (!STAGES.has(stage)) throw new Error('赛段无效')
  return { eventId: validateEventId(eventId), stage }
}

async function get(eventId, stage) {
  const pair = validate(eventId, String(stage || '').toUpperCase())
  const db = getDatabase()
  await ensureCollection(db)
  // Keep this query to an equality filter so it works without a custom
  // composite index.  There should be one document per event/stage; asking
  // for two still lets us detect duplicate records without hiding them.
  const result = await db.collection('work_records').where(pair).limit(2).get()
  if (result.data && result.data.length > 1) throw new Error(`云端成绩记录重复：${pair.eventId}/${pair.stage}；请先清理重复记录`)
  const record = result.data && result.data[0]
  return {
    rows: record ? cleanRows(record.rows) : [],
    count: record ? record.rows.length : 0,
    revision: Number.isSafeInteger(Number(record && record.revision)) && Number(record && record.revision) >= 0 ? Number(record.revision) : 0,
    updatedAt: record && record.updatedAt || null,
    updatedByPhone: record && record.updatedByPhone || ''
  }
}

// Return one entry for every configured stage so the web "上传批次" view can
// show what has actually reached CloudBase.  Empty stages are included on
// purpose: an empty stage is still a usable batch that may be waiting for an
// uploader, and omitting it makes the dashboard look as if the stage is not
// configured.
async function listUploadBatches(eventId) {
  const id = validateEventId(eventId)
  const db = getDatabase()
  await ensureCollection(db)
  const results = await Promise.all(Array.from(STAGES).map(async stage => {
    const result = await db.collection('work_records').where({ eventId: id, stage }).limit(2).get()
    if (result.data && result.data.length > 1) throw new Error(`云端成绩记录重复：${id}/${stage}；请先清理重复记录`)
    const record = result.data && result.data[0]
    const rows = record ? cleanRows(record.rows) : []
    return {
      eventId: id,
      stage,
      batchId: record && record._id || null,
      count: rows.length,
      revision: Number.isSafeInteger(Number(record && record.revision)) && Number(record && record.revision) >= 0 ? Number(record.revision) : 0,
      updatedAt: record && record.updatedAt || null,
      updatedBy: record && (record.updatedByPhone || record.updatedBy) || null,
      statuses: rows.reduce((summary, row) => {
        const status = String(row.status || 'pending')
        summary[status] = (summary[status] || 0) + 1
        return summary
      }, {})
    }
  }))
  // Mini-program uploads write an audit document to work_uploads after all
  // stage documents commit. Keep that audit stream separate from the current
  // stage snapshots; a missing collection is an explicit empty state rather
  // than a fabricated batch.
  const uploads = []
  let uploadLogAvailable = true
  try {
    for (let offset = 0; ; offset += 100) {
      let query = db.collection('work_uploads').where({ eventId: id })
      if (typeof query.skip === 'function') query = query.skip(offset)
      query = query.limit(100)
      const page = await query.get()
      const entries = Array.isArray(page.data) ? page.data : []
      uploads.push(...entries.map(item => ({
        id: item._id || null,
        eventId: id,
        uploader: item.uploaderPhone || item.openid || '工作人员',
        role: item.role || 'staff',
        stageCount: Number(item.stageCount) || 0,
        rowCount: Number(item.rowCount) || 0,
        records: Array.isArray(item.records) ? item.records.map(record => ({ stage: String(record.stage || '').toUpperCase(), rowCount: Number(record.rowCount) || 0 })) : [],
        uploadedAt: item.uploadedAt || null
      })))
      if (entries.length < 100) break
    }
  } catch (error) {
    if (!isMissingCollectionError(error)) throw error
    uploadLogAvailable = false
  }
  uploads.sort((a, b) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime())
  return { eventId: id, batches: results, uploads, uploadLogAvailable }
}

async function check() {
  const db = getDatabase()
  await ensureCollection(db)
  await ensureEventsCollection(db)
  return true
}

async function put(eventId, stage, inputRows, expectedRevision) {
  const pair = validate(eventId, String(stage || '').toUpperCase())
  const db = getDatabase()
  await ensureCollection(db)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('成绩版本无效，请刷新赛段后重试')
  if (typeof db.runTransaction !== 'function') throw new Error('云数据库事务不可用，未写入成绩；请检查云端 SDK 后重试')
  if (!Array.isArray(inputRows) || inputRows.length > 1000) throw new Error('每个赛段最多保存 1000 条成绩')
  inputRows.forEach((row, index) => {
    const label = `第 ${index + 1} 条成绩`
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label}格式无效`)
    for (const [field, max] of Object.entries({ id: 80, carNumber: 12, car: 12, group: 100, groupName: 100, teamName: 100, driver: 80, name: 80, startTime: 24, start: 24, endTime: 24, finish: 24, penaltyTotal: 16, penalty: 16, segmentDuration: 24, totalDuration: 24, duration: 24, uploader: 80, uploadedAt: 80, note: 500 })) {
      if (row[field] != null && String(row[field]).length > max) throw new Error(`${label}${field}超出 ${max} 个字符，请检查后重试`)
    }
    if (Array.isArray(row.penaltyInputs)) {
      if (row.penaltyInputs.length > 10) throw new Error(`${label}罚时项目最多 10 项`)
      row.penaltyInputs.forEach((item, itemIndex) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label}第 ${itemIndex + 1} 项罚时格式无效`)
        if (String(item.id || '').length > 80 || String(item.value || '').length > 12) throw new Error(`${label}第 ${itemIndex + 1} 项罚时超出长度限制`)
      })
    }
  })
  const rows = cleanRows(inputRows)
  if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > 700 * 1024) throw new Error('当前赛段成绩超过 CloudBase 单文档安全大小，请分段检查后重试')
  const revision = expectedRevision + 1
  const docId = `work_${require('node:crypto').createHash('sha256').update(`${pair.eventId}::${pair.stage}`).digest('hex').slice(0, 40)}`
  // CloudBase transactions only support single-document operations. Resolve
  // the existing record outside the transaction, then re-read that exact
  // document inside it so the revision check and write remain atomic.
  const existingResult = await db.collection('work_records').where(pair).limit(2).get()
  if (existingResult.data && existingResult.data.length > 1) throw new Error(`云端成绩记录重复：${pair.eventId}/${pair.stage}；未继续保存以避免覆盖错误记录`)
  const existing = existingResult.data && existingResult.data[0]
  const recordId = existing && existing._id || docId
  await db.runTransaction(async transaction => {
    const collection = transaction.collection('work_records')
    let previous = null
    try {
      const currentResult = await collection.doc(recordId).get()
      previous = currentResult && currentResult.data || null
    } catch (error) {
      if (!isMissingDocumentError(error)) throw error
    }
    const previousRevision = Number(previous && previous.revision)
    const actualRevision = Number.isSafeInteger(previousRevision) && previousRevision >= 0 ? previousRevision : 0
    if (actualRevision !== expectedRevision) throw new Error(`成绩已被其他设备修改（云端版本 ${actualRevision}，本地版本 ${expectedRevision}），本次未覆盖云端数据；请刷新后重新编辑`)
    const now = new Date()
    const data = { ...pair, rows, revision, updatedAt: now, updatedBy: 'web-admin', updatedByPhone: '网页管理员', updatedByRole: 'admin' }
    if (previous) await collection.doc(recordId).update(data)
    else await collection.doc(recordId).set({ ...data, createdAt: now })
    const readback = await collection.doc(recordId).get()
    const confirmed = readback && readback.data
    if (!confirmed || Number(confirmed.revision || 0) !== revision || stableStringify(cleanRows(confirmed.rows)) !== stableStringify(rows)) throw new Error('云端事务内回读核对失败，未确认成绩已保存')
  })
  const verified = await get(pair.eventId, pair.stage)
  const latest = await db.collection('work_records').where(pair).limit(2).get()
  if (latest.data && latest.data.length > 1) throw new Error(`成绩写入后发现重复记录：${pair.eventId}/${pair.stage}；请先清理重复记录`)
  const confirmed = latest.data && latest.data[0]
  if (verified.count !== rows.length || stableStringify(verified.rows) !== stableStringify(rows) || Number(confirmed && confirmed.revision || 0) !== revision) throw new Error(`云端回读核对失败：只确认 ${verified.count}/${rows.length} 条，数据未标记为保存成功`)
  return { count: rows.length, revision, verified: true }
}

async function approveAllScores(eventId) {
  const id = validateEventId(eventId)
  const db = getDatabase()
  await ensureCollection(db)
  const result = await db.collection('work_records').where({ eventId: id }).limit(STAGES.size + 1).get()
  const records = Array.isArray(result.data) ? result.data : []
  if (records.length > STAGES.size) throw new Error(`云端赛事 ${id} 存在重复或异常赛段记录，未执行批量审核`)
  if (!records.length) return { eventId: id, approvedCount: 0, stageCount: 0, stages: [] }
  if (typeof db.runTransaction !== 'function') throw new Error('云数据库事务不可用，未审核成绩；请检查云端 SDK 后重试')

  const now = new Date()
  let approvedCount = 0
  const approvedStages = []
  for (const record of records) {
    const recordId = String(record && record._id || '')
    const stage = String(record && record.stage || '').toUpperCase()
    if (!recordId || !STAGES.has(stage)) throw new Error('云端成绩记录缺少有效文档 ID 或赛段')
    await db.runTransaction(async transaction => {
      const collection = transaction.collection('work_records')
      let current = null
      try {
        const read = await collection.doc(recordId).get()
        current = read && read.data || null
      } catch (error) {
        if (!isMissingDocumentError(error)) throw error
      }
      if (!current) return
      if (String(current.eventId || '') !== id || String(current.stage || '').toUpperCase() !== stage) throw new Error(`云端成绩记录归属异常：${stage}`)
      const rows = cleanRows(current.rows || []).map(row => ({ ...row, status: 'approved' }))
      const previousRevision = Number(current.revision)
      const revision = Number.isSafeInteger(previousRevision) && previousRevision >= 0 ? previousRevision + 1 : 1
      await collection.doc(recordId).update({
        rows,
        revision,
        updatedAt: now,
        updatedBy: 'web-admin',
        updatedByPhone: '网页管理员',
        updatedByRole: 'admin',
        approvedAt: now,
        approvedBy: 'web-admin'
      })
      approvedCount += rows.length
      approvedStages.push(stage)
    })
  }
  return { eventId: id, approvedCount, stageCount: approvedStages.length, stages: approvedStages.sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))) }
}

function cleanPublishedResults(record, eventId = '') {
  const source = record || {}
  if (record && !Array.isArray(source.rows)) throw new Error('云端已发布成绩格式损坏：缺少成绩列表')
  const rows = Array.isArray(source.rows) ? source.rows : []
  if (source.rowCount != null && Number(source.rowCount) !== rows.length) throw new Error(`云端已发布成绩不完整：读取 ${rows.length}/${source.rowCount} 条`)
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !String(row.carNumber || '').trim() || !String(row.group || '').trim()) throw new Error(`云端已发布成绩第 ${index + 1} 条格式无效`)
    if (!row.stageTimes || typeof row.stageTimes !== 'object' || Array.isArray(row.stageTimes)) throw new Error(`云端已发布成绩第 ${index + 1} 条赛段数据无效`)
  })
  const stageNames = Array.isArray(source.stageNames) ? cleanStageNames(source.stageNames) : []
  return {
    ok: true,
    eventId: String(source.eventId || eventId || ''),
    publishedAt: source.publishedAt || null,
    rankingMode: 'total',
    groups: cleanGroupNames(source.groups),
    stageNames,
    groupStageNames: cleanGroupStageNames(source.groupStageNames, stageNames.length ? stageNames : STAGES),
    rowCount: rows.length,
    rows
  }
}

async function getPublishedResults(eventId) {
  const id = validateEventId(eventId)
  const db = getDatabase()
  await ensureEventsCollection(db)
  const eventResult = await db.collection('events').where({ id }).limit(2).get()
  if (eventResult.data && eventResult.data.length > 1) throw new Error(`云端赛事 ID 重复：${id}；未读取成绩`)
  const event = eventResult.data && eventResult.data[0]
  if (event && (event.deletedAt || event.published === false)) throw new Error('该赛事已删除，成绩暂不可访问')
  await ensurePublishedResultsCollection(db)
  const result = await db.collection('published_results').where({ eventId: id }).limit(2).get()
  if (result.data && result.data.length > 1) throw new Error(`云端已发布成绩存在重复快照：${id}；请先清理后再读取`)
  return cleanPublishedResults(result.data && result.data[0], id)
}

async function publishResults(eventId, visibleGroups, rankingMode, requestedGroupStageNames) {
  const id = validateEventId(eventId)
  const db = getDatabase()
  await ensureEventsCollection(db)
  await ensureCollection(db)
  await ensurePublishedResultsCollection(db)
  const eventResult = await db.collection('events').where({ id }).limit(2).get()
  if (eventResult.data && eventResult.data.length > 1) throw new Error(`云端赛事 ID 重复：${id}；未发布成绩以避免关联错误赛事`)
  const storedEvent = eventResult.data && eventResult.data[0]
  if (!storedEvent) throw new Error('没有找到该赛事，请先保存并发布赛事信息')
  if (storedEvent.deletedAt || storedEvent.published === false) throw new Error('该赛事已删除，不能继续发布成绩')
  const event = cleanEvent(storedEvent, storedEvent.id || storedEvent._id)
  const hasRequestedGroupStageNames = requestedGroupStageNames && typeof requestedGroupStageNames === 'object' && !Array.isArray(requestedGroupStageNames) && Object.keys(requestedGroupStageNames).length > 0
  if (hasRequestedGroupStageNames) {
    for (const [group, stages] of Object.entries(requestedGroupStageNames)) {
      if (!Array.isArray(stages) || stages.some(stage => !STAGES.has(String(stage || '').trim().toUpperCase()))) {
        throw new Error(`组别“${group}”的发布赛段无效，仅支持 SS1–SS20`)
      }
    }
  }
  const sourceGroupStageNames = hasRequestedGroupStageNames ? requestedGroupStageNames : event.groupStageNames
  const requestedGroups = cleanGroupNames(Array.isArray(visibleGroups) ? visibleGroups : event.visibleGroups)
  // Older events predate group metadata. Let the first explicit publication
  // configure their group list instead of forcing the admin to recreate them.
  // The web checklist can include groups found on imported/legacy score rows.
  // Persist explicitly selected names too, so they are not silently discarded
  // when an older event has incomplete group metadata.
  const availableGroups = cleanGroupNames([
    ...cleanGroupNames(event.groups),
    ...requestedGroups,
    ...Object.keys(sourceGroupStageNames || {})
  ])
  const groups = requestedGroups.filter(group => availableGroups.includes(group))
  if (!Array.isArray(visibleGroups) && !groups.length) throw new Error('请先配置本场赛事的可展示组别')
  const mode = 'total'
  const selectedGroups = new Set(groups)
  const configuredStages = event.stageNames.length ? new Set(event.stageNames) : STAGES
  const groupStageNames = cleanGroupStageNames(sourceGroupStageNames, configuredStages)
  const hasGroupStageConfig = hasRequestedGroupStageNames || Object.keys(event.groupStageNames).length > 0
  const stagesToRead = hasGroupStageConfig
    ? new Set(groups.flatMap(group => groupStageNames[group] || []))
    : configuredStages
  const stageEntries = await Promise.all([...stagesToRead].map(async stage => [stage, await get(id, stage)]))
  const byCar = new Map()
  const stagesWithData = new Set()
  let approvedWithoutGroup = 0
  const invalidApprovedRows = []

  for (const [stage, record] of stageEntries) {
    for (const row of record.rows) {
      if (row.status !== 'approved') continue
      if (!selectedGroups.size) continue
      if (!row.group) { approvedWithoutGroup += 1; continue }
      if (!selectedGroups.has(row.group)) continue
      if (hasGroupStageConfig && !(groupStageNames[row.group] || []).includes(stage)) continue
      const times = resultTimes(row)
      if (!times || times.effective <= 0) {
        invalidApprovedRows.push(`${stage} 车号 ${row.carNumber}`)
        continue
      }
      const carNumber = row.carNumber
      if (!byCar.has(carNumber)) byCar.set(carNumber, { carNumber, group: row.group, stageTimes: {} })
      const competitor = byCar.get(carNumber)
      // A competitor number is unique within an event. If a row was accidentally
      // assigned to two groups, keep its first approved assignment consistently.
      if (competitor.group !== row.group) throw new Error(`车号 ${carNumber} 在不同赛段被分到“${competitor.group}”和“${row.group}”，请先统一组别再发布`)
      const previous = competitor.stageTimes[stage]
      if (!previous || times.effective < previous._effectiveMs) {
        competitor.stageTimes[stage] = {
          startTime: row.startTime,
          endTime: row.endTime,
          penalty: row.penaltyTotal,
          duration: formatDurationMs(times.elapsed),
          _durationMs: times.elapsed,
          _effectiveMs: times.effective
        }
      }
      stagesWithData.add(stage)
    }
  }
  if (invalidApprovedRows.length) throw new Error(`以下已通过成绩缺少有效用时，未发布：${invalidApprovedRows.slice(0, 20).join('、')}${invalidApprovedRows.length > 20 ? ` 等 ${invalidApprovedRows.length} 条` : ''}`)
  const stageNames = [...stagesWithData].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
  const grouped = new Map(groups.map(group => [group, []]))
  for (const competitor of byCar.values()) {
    const entries = Object.entries(competitor.stageTimes)
      .map(([stage, item]) => ({ stage, item, ms: item._durationMs }))
      .sort((a, b) => Number(a.stage.slice(2)) - Number(b.stage.slice(2)))
    if (!entries.length) continue
    const totalMs = entries.reduce((sum, entry) => sum + entry.item._effectiveMs, 0)
    const bestMs = Math.min(...entries.map(entry => entry.item._effectiveMs))
    const validMs = mode === 'total' ? totalMs : bestMs
    for (const item of Object.values(competitor.stageTimes)) {
      delete item._durationMs
      delete item._effectiveMs
    }
    grouped.get(competitor.group).push({
      id: `${id}-${competitor.carNumber}`,
      carNumber: competitor.carNumber,
      group: competitor.group,
      stageTimes: competitor.stageTimes,
      bestScore: formatDurationMs(bestMs),
      totalScore: formatDurationMs(totalMs),
      validScore: formatDurationMs(validMs),
      _validMs: validMs
    })
  }

  const rows = []
  for (const group of groups) {
    const ordered = (grouped.get(group) || []).sort((a, b) => a._validMs - b._validMs || a.carNumber.localeCompare(b.carNumber, undefined, { numeric: true }))
    let previousMs = null
    let previousRank = 0
    ordered.forEach((row, index) => {
      if (row._validMs !== previousMs) previousRank = index + 1
      previousMs = row._validMs
      const { _validMs, ...publicRow } = row
      rows.push({ ...publicRow, rank: previousRank })
    })
  }

  const publishedGroups = groups.filter(group => grouped.get(group) && grouped.get(group).length)
  const publishedGroupStageNames = Object.fromEntries(publishedGroups.map(group => [
    group,
    cleanStageNames((grouped.get(group) || []).flatMap(row => Object.keys(row.stageTimes)))
  ]))
  const publishedAt = new Date().toISOString()
  const snapshot = {
    eventId: id,
    publishedAt,
    rankingMode: mode,
    groups: publishedGroups,
    stageNames,
    groupStageNames: publishedGroupStageNames,
    rowCount: rows.length,
    rows
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 700 * 1024) throw new Error('发布后的成绩超过 CloudBase 单文档安全大小；请减少参赛成绩或分组后再发布')
  const persistedGroupStageNames = hasGroupStageConfig ? groupStageNames : event.groupStageNames
  const persistedVisibleGroups = hasGroupStageConfig ? groups : publishedGroups
  if (JSON.stringify(cleanGroupNames(event.groups)) !== JSON.stringify(availableGroups)
    || JSON.stringify(cleanGroupNames(event.visibleGroups)) !== JSON.stringify(persistedVisibleGroups)
    || JSON.stringify(event.groupStageNames) !== JSON.stringify(persistedGroupStageNames)) {
    await db.collection('events').doc(storedEvent._id).update({
      groups: availableGroups,
      visibleGroups: persistedVisibleGroups,
      groupStageNames: persistedGroupStageNames,
      updatedAt: new Date()
    })
  }
  const existing = await db.collection('published_results').where({ eventId: id }).limit(2).get()
  if (existing.data && existing.data.length > 1) throw new Error(`云端已发布成绩存在重复快照：${id}；未覆盖任何快照`)
  if (existing.data && existing.data.length) await db.collection('published_results').doc(existing.data[0]._id).update(snapshot)
  else await db.collection('published_results').add(snapshot)
  const confirmed = await getPublishedResults(id)
  if (confirmed.rowCount !== rows.length || confirmed.publishedAt !== publishedAt
    || stableStringify(confirmed.rows) !== stableStringify(rows)
    || stableStringify(confirmed.groups) !== stableStringify(publishedGroups)
    || stableStringify(confirmed.stageNames) !== stableStringify(stageNames)
    || stableStringify(confirmed.groupStageNames) !== stableStringify(publishedGroupStageNames)
    || confirmed.rankingMode !== mode) throw new Error(`成绩已写入但云端回读内容与本次发布不一致，请刷新小程序成绩核对`)
  const savedEventResult = await db.collection('events').where({ id }).limit(2).get()
  if (savedEventResult.data && savedEventResult.data.length > 1) throw new Error(`成绩已发布但赛事 ID 重复：${id}；请先清理重复记录`)
  const savedEvent = savedEventResult.data && savedEventResult.data[0]
  if (!savedEvent
    || stableStringify(cleanGroupNames(savedEvent.groups)) !== stableStringify(availableGroups)
    || stableStringify(cleanGroupNames(savedEvent.visibleGroups)) !== stableStringify(persistedVisibleGroups)
    || stableStringify(cleanGroupStageNames(savedEvent.groupStageNames, configuredStages)) !== stableStringify(cleanGroupStageNames(persistedGroupStageNames, configuredStages))) {
    throw new Error('成绩已发布，但赛事组别设置回读不一致，请刷新核对')
  }
  const historyId = `publish_${require('node:crypto').createHash('sha256').update(`${id}::${publishedAt}`).digest('hex').slice(0, 40)}`
  let historySaved = true
  try {
    await ensurePublishHistoryCollection(db)
    await db.collection('publish_history').doc(historyId).set({ ...publicationSummary(confirmed), publishedBy: '网页管理员' })
  } catch (error) {
    historySaved = false
    console.error('成绩已发布，但发布历史保存失败:', error && error.message || error)
  }
  return { ...confirmed, rowCount: rows.length, unassignedRowCount: approvedWithoutGroup, historySaved }
}

module.exports = {
  enabled: Boolean(env),
  env,
  authConfigured: Boolean(accessKey || (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY)),
  authMode: accessKey
    ? 'api-key'
    : (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY ? 'runtime-credentials' : 'missing'),
  check,
  validateEventId,
  get,
  listUploadBatches,
  put,
  approveAllScores,
  normalizeRows: cleanRows,
  getPublishedResults,
  listPublishHistory,
  publishResults,
  listEvents,
  saveEvent,
  uploadEventCover,
  getEventCoverTempUrl,
  uploadEventAsset,
  deleteEvent,
  listPermissions,
  upsertPermission,
  updatePermission,
  deletePermission
}
