const auth = require('../../../utils/auth')
const container = require('../../../utils/cloud-container')
const { ALL_STAGES } = require('../../../utils/stages')

function normalizeEventId(value) {
  const id = String(value == null ? '' : value).trim()
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : ''
}

function readEventList(response) {
  let payload = response && response.data
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch (_) { throw new Error('赛事数据响应不是有效 JSON') }
  }
  if (!payload || payload.ok !== true || !Array.isArray(payload.events)) throw new Error('赛事数据响应不完整')
  const seen = new Set()
  payload.events.forEach((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error(`第 ${index + 1} 条赛事数据格式无效`)
    const id = String(event.id || event._id || '').trim()
    if (!id) throw new Error(`第 ${index + 1} 条赛事缺少 ID`)
    if (seen.has(id)) throw new Error(`赛事 ${id} 重复，未更新赛事列表`)
    seen.add(id)
  })
  return payload.events
}

function eventDate(event) {
  if (event.date) return String(event.date)
  const start = String(event.dateStart || '')
  const end = String(event.dateEnd || '')
  if (start && end) return `${start} ~ ${end}`
  return start || end
}

function eventSectionTitles(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const defaults = {
    signup: '赛事报名',
    results: '查看成绩详情',
    info: '赛事信息',
    detail: '赛事详情',
    rules: '竞赛规则',
    awards: '奖项设置'
  }
  return Object.keys(defaults).reduce((result, key) => {
    const text = String(source[key] || '').trim()
    result[key] = text || defaults[key]
    return result
  }, {})
}

function eventInfoLabels(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const defaults = { date: '比赛时间：', deadline: '报名截止：', location: '集合地址：', contactName: '联系人：', phone: '联系电话：', wechat: '微信号：' }
  return Object.keys(defaults).reduce((result, key) => {
    const text = String(source[key] == null ? defaults[key] : source[key]).trim()
    result[key] = text || defaults[key]
    return result
  }, {})
}

// The full-page editor publishes a single, already-formatted HTML document.
// Keep the client-side fallback conservative as well: rich-text should never
// execute scripts or event handlers received from a remote event record.
function normalizeDetailPageHtml(value) {
  return String(value == null ? '' : value)
    .slice(0, 300000)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(\s(?:href|src)\s*=\s*["'])\s*javascript:[^"']*(["'])/gi, '$1$2')
}

function normalizeDetailPageImageEntries(value) {
  const entries = []
  const add = (fileId, url) => {
    const id = String(fileId || '').trim()
    if (!id) return
    entries.push({ fileId: id.slice(0, 500), url: String(url || '').trim().slice(0, 2000) })
  }
  if (Array.isArray(value)) {
    value.forEach(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) add(item.fileId || item.fileID || item.id, item.url || item.src || item.miniUrl)
      else if (typeof item === 'string') add(item, '')
    })
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach(fileId => add(fileId, value[fileId]))
  }
  const seen = new Set()
  return entries.filter(item => !seen.has(item.fileId) && seen.add(item.fileId))
}

function detailPageCloudFileId(value) {
  const source = String(value || '').trim()
  return /^(?:cloud|wxcloud|cloudbase):\/\//i.test(source) ? source : ''
}

function detailPageImageIds(html) {
  const source = String(html || '')
  const ids = []
  const seen = new Set()
  const add = value => {
    const id = detailPageCloudFileId(value)
    if (id && !seen.has(id)) { seen.add(id); ids.push(id) }
  }
  const dataFilePattern = /\bdata-file-id\s*=\s*["']([^"']+)["']/gi
  const srcPattern = /\bsrc\s*=\s*["']([^"']+)["']/gi
  let match
  while ((match = dataFilePattern.exec(source))) add(match[1])
  while ((match = srcPattern.exec(source))) add(match[1])
  return ids
}

function replaceDetailPageImageUrls(html, urls) {
  const source = String(html || '')
  return source.replace(/<img\b[^>]*>/gi, tag => {
    const dataIdMatch = tag.match(/\bdata-file-id\s*=\s*["']([^"']+)["']/i)
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)
    const miniSrcMatch = tag.match(/\bdata-mini-src\s*=\s*["']([^"']+)["']/i)
    const fileId = detailPageCloudFileId(dataIdMatch && dataIdMatch[1] || srcMatch && srcMatch[1])
    const url = (fileId && urls && urls.get(fileId)) || (miniSrcMatch && miniSrcMatch[1])
    if (!url) return tag.replace(/\s+data-mini-src\s*=\s*["'][^"']*["']/i, '')
    const escapedUrl = url.replace(/["&<>]/g, char => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]))
    const withoutSrc = tag.replace(/\s+src\s*=\s*["'][^"']*["']/i, '').replace(/\s+data-file-id\s*=\s*["'][^"']*["']/i, '').replace(/\s+data-mini-src\s*=\s*["'][^"']*["']/i, '')
    return withoutSrc.replace(/\s*\/?>$/, '') + ` src="${escapedUrl}" />`
  })
}

// The web editor emits the results CTA as an anchor with the
// `event-action-results` marker.  Rich-text does not forward anchor taps to
// page handlers, so split that one marker out and render the native button at
// the same point in the scroll view.  The editor's marker normally sits in a
// single action-row wrapper; unwrap that wrapper while splitting so neither
// rich-text fragment contains an unmatched tag.
function splitDetailPageResults(html) {
  const source = String(html || '')
  const marker = /<a\b[^>]*class\s*=\s*["'][^"']*\bevent-action-results\b[^"']*["'][^>]*>[\s\S]*?<\/a\s*>/i
  const match = marker.exec(source)
  if (!match) return { html: source, before: source, after: '', hasResultsAction: false, resultsLabel: '', actionPosition: 'append' }
  const start = match.index
  const end = start + match[0].length
  const resultsLabel = match[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const prefix = source.slice(0, start)
  const suffix = source.slice(end)
  const wrapper = prefix.match(/<([a-z][\w:-]*)\b[^>]*class\s*=\s*["'][^"']*(?:action-row|mini-preview-action-row)[^"']*["'][^>]*>\s*$/i)
  const closing = suffix.match(/^\s*<\/([a-z][\w:-]*)\s*>/i)
  if (wrapper && closing && wrapper[1].toLowerCase() === closing[1].toLowerCase()) {
    const wrapperStart = wrapper.index
    return {
      html: source,
      before: prefix.slice(0, wrapperStart),
      after: suffix.slice(closing[0].length),
      hasResultsAction: true,
      resultsLabel,
      actionPosition: 'inline'
    }
  }
  // Without a recognizable action-row wrapper, keep the complete HTML intact
  // and put the native CTA after it. Splitting arbitrary authored markup could
  // leave unbalanced tags on either side of the WXML button.
  return { html: source, before: source, after: '', hasResultsAction: false, resultsLabel: '', actionPosition: 'append' }
}

function normalizeDetailPageParts(value) {
  const html = normalizeDetailPageHtml(value)
  return { html, ...splitDetailPageResults(html) }
}

function normalizeContentBlocks(value) {
  if (!Array.isArray(value)) return []
  if (value.length > 100) throw new Error('赛事正文超过 100 项，拒绝不完整显示')
  const supportedTypes = new Set(['heading', 'paragraph', 'text', 'note', 'image', 'banner', 'divider', 'list', 'table'])
  return value.reduce((blocks, block, index) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error(`赛事正文第 ${index + 1} 项格式无效`)
    const type = String(block.type || '').trim().toLowerCase()
    if (!supportedTypes.has(type)) throw new Error(`赛事正文第 ${index + 1} 项类型不支持：${type || '空'}`)

    const textValue = block.text == null ? (block.content == null ? '' : block.content) : block.text
    if (textValue != null && !['string', 'number'].includes(typeof textValue)) throw new Error(`赛事正文第 ${index + 1} 项文字格式无效`)
    const text = typeof textValue === 'string' ? textValue : String(textValue)
    const toCellText = cell => {
      if (cell == null) return ''
      if (typeof cell === 'string' || typeof cell === 'number') return String(cell)
      throw new Error(`赛事正文第 ${index + 1} 项列表/表格单元格格式无效`)
    }
    if (Array.isArray(block.items) && block.items.length > 200) throw new Error(`赛事正文第 ${index + 1} 项列表超过 200 行`)
    if (Array.isArray(block.headers) && block.headers.length > 30) throw new Error(`赛事正文第 ${index + 1} 项表格超过 30 列`)
    if (Array.isArray(block.rows) && (block.rows.length > 200 || block.rows.some(row => !Array.isArray(row) || row.length > 30))) throw new Error(`赛事正文第 ${index + 1} 项表格超过支持范围`)
    if (['heading', 'paragraph', 'text', 'note'].includes(type) && text.length > 10000) throw new Error(`赛事正文第 ${index + 1} 项文字超过限制`)
    const items = Array.isArray(block.items)
      ? block.items.map(toCellText).filter(item => item !== '')
      : (type === 'list' ? text.split(/\r?\n/).map(item => item.trim()).filter(Boolean) : [])
    const headers = Array.isArray(block.headers) ? block.headers.map(toCellText) : []
    const rows = Array.isArray(block.rows)
      ? block.rows.map(row => Array.isArray(row) ? row.map(toCellText) : []).filter(row => row.length)
      : []
    const url = String(block.miniUrl || block.url || '')

    const normalized = {
      ...block,
      key: String(block.id || index),
      type,
      text,
      html: typeof block.html === 'string' ? block.html.slice(0, 30000) : '',
      align: ['left', 'center', 'right', 'justify'].includes(String(block.align)) ? String(block.align) : 'left',
      bold: block.bold === true,
      listStyle: block.listStyle === 'ordered' ? 'ordered' : 'unordered',
      items,
      headers,
      rows,
      title: String(block.title || ''),
      src: url,
      fileId: String(block.fileId || '')
    }
    if (type === 'banner') {
      normalized.theme = ['02', '03'].includes(String(block.theme)) ? String(block.theme) : '02'
      normalized.number = String(block.number || '').slice(0, 20)
    }
    blocks.push(normalized)
    return blocks
  }, [])
}

function normalizeSignupOptions(value) {
  if (!Array.isArray(value)) return []
  if (value.length > 100) throw new Error('报名选项超过 100 项，拒绝不完整显示')
  if (value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('报名选项格式无效')
  return value.map(item => {
    const name = String(item.name || '').trim()
    const fee = String(item.fee || '').trim()
    const quota = String(item.quota || '').trim()
    const note = String(item.note || '').trim()
    return {
      ...item,
      displayText: `${name}${fee ? ` ${fee}` : ''}${quota ? `（名额：${quota}）` : ''}${note ? `（${note}）` : ''}`
    }
  })
}

Page({
  data: {
    id: 'suiping',
    // Keep the first render fully defined. WeChat's view layer can fail its
    // initial patch when a large WXML tree reads properties from null.
    event: {
      id: 'suiping', title: '', date: '', status: '', notice: '', dateFull: '', location: '', signup: [], sectionTitles: eventSectionTitles(),
      infoLabels: eventInfoLabels(), contentBlocks: [], detailPageConfigured: false, detailPageHtml: '',
      detailPageBeforeHtml: '', detailPageAfterHtml: '', detailPageHasResultsAction: false, detailPageResultsLabel: ''
    },
    prizeTables: [], event2PrizeTables: [], event3PrizeTables: [],
    liked: false, likeCount: 0, commentCount: 0, shareCount: 0, viewCount: 0,
    detailReady: false, interactionBusy: false,
    commentVisible: false, commentText: '', comments: [],
    resultsSheetVisible: false, scoreViewVisible: false, scoreGroups: [], selectedScore: null,
    scoreLoading: true, scoreLoadError: false,
    canAccessWork: false, eventConfigReady: false, eventCloudReady: false, eventConfigError: ''
  },
  onLoad(query) {
    query = query || {}
    const requestedId = query.id || 'suiping'
    const id = normalizeEventId(requestedId)
    const event = this.makeEvent(id)
    // Keep the first render small. Prize tables are only needed by the long
    // race-detail section, which is currently kept lazy on real devices.
    const event2Labels = ['1、专业组奖金设置', '2、公开组奖金设置', '3、UTV组奖金设置', '4、新秀组奖金设置', '5、女子组奖金设置']
    const event3Labels = ['1、改装组奖金设置', '2、量产组奖金设置']
    this.setData({
      id,
      event,
      prizeTables: [],
      // Keep each section heading attached to its table so the WXML can
      // render the heading immediately before the corresponding table.
      event2PrizeTables: event2Labels.map(label => ({ title: label, headers: [], rows: [], subtotals: [] })),
      event3PrizeTables: event3Labels.map(label => ({ title: label, headers: [], rows: [], subtotals: [] })),
      detailReady: id === 'suiping',
      scoreGroups: [], eventConfigReady: false,
      eventConfigError: id ? '' : '赛事标识无效，无法读取赛事详情或工作后台。'
    })
    // The long race-detail tree previously mounted in a delayed setData call.
    // On real devices that second large patch can crash WebView rendering
    // (setChanges), leaving only the native navigation bar visible. Keep the
    // detail tree lazy until it is split into smaller sections.
    this._detailTimer = null
    if (id) {
      this.recordViewOpen(id)
      this.loadWorkAccess()
      this.loadPublishedEvent(id)
      this.loadPublishedResults(id)
    } else {
      this.safeSetData({ eventConfigReady: true, canAccessWork: false, scoreLoading: false, scoreLoadError: true })
    }
    if (query.fromShare) this.recordShareOpen(query.fromShare)
  },
  loadPublishedEvent(id) {
    const requestId = (this._eventRequestId || 0) + 1
    this._eventRequestId = requestId
    this.safeSetData({ eventConfigError: '', eventCloudReady: false, canAccessWork: false })
    container.call('/api/public/events').then(readEventList).then(events => {
      if (this.__unloaded || this._eventRequestId !== requestId) return
      const record = events.find(item => String(item && (item.id || item._id) || '') === String(id))
      if (!record) {
        // A successful cloud response is authoritative. Do not resurrect the
        // built-in suiping page after an administrator unpublishes/deletes it.
        // The old page remains available only when the network request itself
        // fails (see catch below), so an offline user can still view cached UI.
        this.safeSetData({
          event: { ...(this.data.event || {}), id: String(id), title: '', date: '', location: '', status: '', signup: [], contentBlocks: [] },
          detailReady: false,
          eventConfigReady: true,
          eventCloudReady: false,
          canAccessWork: false,
          eventConfigError: '没有找到这场赛事，可能已下架或暂未发布。'
        })
        return
      }
      const base = this.data.event || {}
      const detailPage = normalizeDetailPageParts(replaceDetailPageImageUrls(record.detailPageHtml, new Map()))
      const publishedEvent = {
        ...base,
        // Retain custom fields sent by the web event editor so future mini-
        // program features can consume them without the detail page stripping
        // them during normalization.
        ...record,
        id: String(record.id || record._id),
        // Dynamic signupOptions replace the legacy static signup rows; keeping
        // both fields would render the registration section twice.
        signup: [],
        title: String(record.title || base.title || '赛事详情'),
        date: eventDate(record) || base.date || '',
        dateFull: String(record.dateFull || eventDate(record) || base.dateFull || ''),
        dateStart: String(record.dateStart || ''),
        dateEnd: String(record.dateEnd || ''),
        location: String(record.location || base.location || ''),
        status: String(record.status || base.status || ''),
        notice: record.notice == null ? '' : String(record.notice || ''),
        sectionTitles: eventSectionTitles(record.sectionTitles || base.sectionTitles),
        infoLabels: eventInfoLabels(record.infoLabels || base.infoLabels),
        detailText: String(record.detailText || ''),
        rulesText: String(record.rulesText || ''),
        awardsText: String(record.awardsText || ''),
        detailPageConfigured: record.detailPageConfigured === true && !!detailPage.html,
        detailPageHtml: detailPage.html,
        detailPageBeforeHtml: detailPage.before,
        detailPageAfterHtml: detailPage.after,
        detailPageHasResultsAction: detailPage.hasResultsAction,
        detailPageResultsLabel: detailPage.resultsLabel,
        detailPageImages: normalizeDetailPageImageEntries(record.detailPageImages),
        contentBlocks: record.contentBlocksConfigured === true || (record.contentBlocksConfigured !== false && Array.isArray(record.contentBlocks))
          ? normalizeContentBlocks(Array.isArray(record.contentBlocks) ? record.contentBlocks : [])
          : (String(record.id || record._id) === 'suiping' ? normalizeContentBlocks(require('./event-template').contentBlocks) : []),
        registrationDeadline: String(record.registrationDeadline || ''),
        contactName: String(record.contactName || ''),
        contactPhone: String(record.contactPhone || ''),
        contactWechat: String(record.contactWechat || ''),
        registrationNote: String(record.registrationNote || ''),
        signupOptions: normalizeSignupOptions(record.signupOptions),
        registrationEnabled: record.registrationEnabled === true,
        workBackendEnabled: record.workBackendEnabled !== false,
        groups: Array.isArray(record.groups) ? record.groups : [],
        visibleGroups: Array.isArray(record.visibleGroups) ? record.visibleGroups : [],
        groupStageNames: record.groupStageNames && typeof record.groupStageNames === 'object' && !Array.isArray(record.groupStageNames) ? record.groupStageNames : {},
        stageNames: Array.isArray(record.stageNames) ? record.stageNames : [],
        scoringType: String(record.scoringType || 'rally'),
        rankingMode: record.rankingMode === 'total' ? 'total' : 'best',
        coverFileId: String(record.coverFileId || ''),
        coverUrl: String(record.coverUrl || ''),
        publishedAt: record.publishedAt || null,
        isDynamic: true,
        isGeneric: true
      }
      if (publishedEvent.id === 'suiping') this.safeSetData({ detailReady: false })
      this.safeSetData({ eventConfigReady: true, eventCloudReady: true })
      if (!publishedEvent.workBackendEnabled) this.safeSetData({ canAccessWork: false })
      // Publish the full record before resolving temporary image URLs. The
      // cover and body image requests can finish in either order.
      this.safeSetData({ event: publishedEvent })
      this.resolveEventCover(publishedEvent)
      this.resolveEventContentImages(publishedEvent)
      this.resolveEventDetailPageImages(publishedEvent)
      this.loadWorkAccess()
    }).catch(error => {
      // Legacy detail content can remain visible offline, but work access
      // stays closed until the current cloud event has been verified.
      console.warn('读取赛事详情失败，继续显示内置内容', error)
      if (String(id) === 'suiping') {
        this.safeSetData({ eventConfigReady: true, eventConfigError: '云端赛事读取失败，当前显示的是小程序内置旧版内容。请重试确认最新赛事数据。' })
        this.loadWorkAccess()
      } else {
        this.safeSetData({ eventConfigReady: true, eventConfigError: '赛事详情读取失败，请检查网络后重试。' })
      }
    })
  },
  loadPublishedResults(eventId) {
    const requestId = (this._scoreRequestId || 0) + 1
    this._scoreRequestId = requestId
    const path = '/api/public/results?eventId=' + encodeURIComponent(String(eventId || ''))
    container.call(path).then(response => {
      let payload = response && response.data
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload) } catch (_) { payload = null }
      }
      if (this.__unloaded || this._scoreRequestId !== requestId) return
      if (!payload || payload.ok !== true || String(payload.eventId || '') !== String(eventId || '')) {
        this.safeSetData({ scoreGroups: [], scoreLoading: false, scoreLoadError: true })
        return
      }
      const stageNames = Array.isArray(payload.stageNames)
        ? payload.stageNames.map(name => String(name || '').trim()).filter(Boolean)
        : []
      if (stageNames.length !== (Array.isArray(payload.stageNames) ? payload.stageNames.length : 0)) throw new Error('已发布成绩包含无效赛段名称')
      const groupNames = Array.isArray(payload.groups)
        ? payload.groups.map(group => String(group && typeof group === 'object' ? group.name || group.group || '' : group || '').trim()).filter(Boolean)
        : []
      if (groupNames.length !== (Array.isArray(payload.groups) ? payload.groups.length : 0)) throw new Error('已发布成绩包含无效组别')
      const rows = Array.isArray(payload.rows) ? payload.rows : []
      if (payload.rowCount != null && Number(payload.rowCount) !== rows.length) throw new Error(`已发布成绩只返回 ${rows.length}/${payload.rowCount} 条`)
      if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !String(row.carNumber || '').trim() || !String(row.group || '').trim())) throw new Error('已发布成绩存在缺车号或缺组别的记录')
      const groups = groupNames.map(name => ({
        name,
        stages: stageNames.filter(stage => rows.some(row => String(row && row.group || '') === name && row.stageTimes && row.stageTimes[stage])).concat(['总成绩']),
        expanded: false
      }))
      this._publishedResults = {
        eventId: String(eventId),
        groups: groupNames,
        stageNames,
        rankingMode: payload.rankingMode === 'total' ? 'total' : 'best',
        rows
      }
      this.safeSetData({ scoreGroups: groups, scoreLoading: false, scoreLoadError: false })
    }).catch(error => {
      if (this.__unloaded || this._scoreRequestId !== requestId) return
      console.warn('读取已发布成绩失败', error)
      this._publishedResults = null
      this.safeSetData({ scoreGroups: [], scoreLoading: false, scoreLoadError: true })
    })
  },
  resolveEventCover(event) {
    if (!event.coverFileId || !wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
      if (event.coverFileId && !event.coverUrl) this.markEventAssetFailure('封面')
      this.safeSetData({ event })
      return
    }
    wx.cloud.getTempFileURL({ fileList: [event.coverFileId] }).then(response => {
      const file = response && response.fileList && response.fileList[0]
      const current = this.data.event || event
      const coverUrl = file && file.status === 0 && file.tempFileURL || current.coverUrl || ''
      if (!coverUrl) this.markEventAssetFailure('封面')
      this.safeSetData({ event: { ...current, coverUrl } })
    }).catch(error => {
      console.warn('赛事详情封面加载失败', error)
      if (!event.coverUrl) this.markEventAssetFailure('封面')
      this.safeSetData({ event })
    })
  },
  resolveEventContentImages(event) {
    const blocks = Array.isArray(event && event.contentBlocks) ? event.contentBlocks : []
    const fileIds = [...new Set(blocks.filter(block => block && block.type === 'image' && block.fileId).map(block => block.fileId))]
    if (!fileIds.length) return
    if (!wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
      if (blocks.some(block => block && block.type === 'image' && block.fileId && !block.url && !block.miniUrl)) this.markEventAssetFailure('赛事正文图片')
      return
    }
    const batches = []
    for (let index = 0; index < fileIds.length; index += 50) batches.push(fileIds.slice(index, index + 50))
    Promise.all(batches.map(batch => Promise.resolve().then(() => wx.cloud.getTempFileURL({ fileList: batch })).catch(error => {
      console.warn('赛事正文图片分批加载失败', error)
      return { fileList: [] }
    }))).then(responses => {
      const files = responses.reduce((all, response) => all.concat(response && response.fileList || []), [])
      const urls = new Map(blocks
        .filter(block => block && block.type === 'image' && block.fileId && (block.url || block.miniUrl))
        .map(block => [block.fileId, block.url || block.miniUrl]))
      files.forEach(file => {
        if (file && file.status === 0 && file.tempFileURL) urls.set(file.fileID, file.tempFileURL)
      })
      const missing = fileIds.filter(fileId => !urls.has(fileId) && !blocks.some(block => block && block.type === 'image' && block.fileId === fileId && (block.url || block.miniUrl)))
      if (missing.length) this.markEventAssetFailure(`${missing.length} 张赛事正文图片`)
      const nextBlocks = (this.data.event && Array.isArray(this.data.event.contentBlocks) ? this.data.event.contentBlocks : blocks)
        .map(block => urls.has(block.fileId) ? { ...block, src: urls.get(block.fileId) } : block)
      this.safeSetData({ event: { ...(this.data.event || event), contentBlocks: nextBlocks } })
    }).catch(error => console.warn('赛事正文图片加载失败', error))
  },
  resolveEventDetailPageImages(event) {
    if (!event || event.detailPageConfigured !== true || !event.detailPageHtml) return
    const declared = normalizeDetailPageImageEntries(event.detailPageImages)
    const fileIds = [...new Set(declared.map(item => item.fileId).concat(detailPageImageIds(event.detailPageHtml)))]
    if (!fileIds.length) return
    if (!wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
      this.markEventAssetFailure('赛事正文图片')
      return
    }
    const batches = []
    for (let index = 0; index < fileIds.length; index += 50) batches.push(fileIds.slice(index, index + 50))
    Promise.all(batches.map(batch => Promise.resolve().then(() => wx.cloud.getTempFileURL({ fileList: batch })).catch(error => {
      console.warn('整页赛事图片分批加载失败', error)
      return { fileList: [] }
    }))).then(responses => {
      const files = responses.reduce((all, response) => all.concat(response && response.fileList || []), [])
      const urls = new Map(declared
        .filter(item => item.fileId && item.url)
        .map(item => [item.fileId, item.url]))
      files.forEach(file => {
        if (file && file.fileID && file.status === 0 && file.tempFileURL) urls.set(file.fileID, file.tempFileURL)
      })
      const missing = fileIds.filter(fileId => !urls.has(fileId) && !declared.some(item => item.fileId === fileId && item.url))
      if (missing.length) this.markEventAssetFailure(`${missing.length} 张赛事正文图片`)
      const current = this.data.event || event
      const html = replaceDetailPageImageUrls(current.detailPageHtml || event.detailPageHtml, urls)
      const detailPage = normalizeDetailPageParts(html)
      this.safeSetData({ event: {
        ...current,
        detailPageHtml: detailPage.html,
        detailPageBeforeHtml: detailPage.before,
        detailPageAfterHtml: detailPage.after,
        detailPageHasResultsAction: detailPage.hasResultsAction,
        detailPageResultsLabel: detailPage.resultsLabel
      } })
    }).catch(error => console.warn('整页赛事图片加载失败', error))
  },
  markEventAssetFailure(label) {
    const message = `${label}读取失败，赛事文字已加载，但图片可能未完整显示。请检查云存储文件和权限后重试。`
    const current = String(this.data.eventConfigError || '')
    if (!current.includes(message)) this.safeSetData({ eventConfigError: current ? `${current} ${message}` : message })
  },
  safeSetData(payload, callback) {
    if (this.__unloaded || !this.setData) return
    try {
      this.setData(payload, callback)
    } catch (error) {
      console.warn('赛事详情视图更新失败', error)
    }
  },
  retryPublishedEvent() {
    this.loadPublishedEvent(this.data.id)
  },
  onShow() {
    if (!this.data.event || !this.data.event.id) return
    this.loadWorkAccess()
  },
  hasWorkAccess(user) {
    if (!user) return false
    const configuredStages = this.data.event && this.data.event.stageNames
    const eventStages = Array.isArray(configuredStages) ? configuredStages.filter(stage => ALL_STAGES.includes(stage)) : []
    if (!eventStages.length) return false
    if (user.isAdmin || user.role === 'admin' || user.role === 'superadmin') return true
    if (!(user.isStaff || user.role === 'staff')) return false
    const allowedStages = Array.isArray(user.stagePermissions) ? user.stagePermissions : []
    return eventStages.some(stage => allowedStages.includes(stage))
  },
  goBack() { wx.navigateBack({ delta: 1 }) },
  showNotice() {
    const notice = String(this.data.event && this.data.event.notice || '').trim()
    if (!notice) return wx.showToast({ title: '暂无赛事公告', icon: 'none' })
    wx.showModal({ title: '赛事公告', content: notice, showCancel: false })
  },
  openResults() {
    wx.setNavigationBarTitle({ title: '成绩详情' })
    this.setData({ resultsSheetVisible: true, scoreViewVisible: false, selectedScore: null })
  },
  closeResults() {
    wx.setNavigationBarTitle({ title: '赛事详情' })
    this.setData({ resultsSheetVisible: false, scoreViewVisible: false, selectedScore: null })
  },
  backToScoreGroups() {
    wx.setNavigationBarTitle({ title: '成绩详情' })
    this.setData({ scoreViewVisible: false, selectedScore: null })
  },
  stopSheetTap() {},
  toggleScoreGroup(event) {
    const index = Number(event.currentTarget.dataset.index)
    const group = this.data.scoreGroups[index]
    if (!group) return
    // Only update the tapped group. Re-sending all groups makes the sheet feel
    // sluggish on lower-end devices.
    this.setData({ ['scoreGroups[' + index + '].expanded']: !group.expanded })
  },
  openScore(event) {
    const groupIndex = Number(event.currentTarget.dataset.groupIndex)
    const stageIndex = Number(event.currentTarget.dataset.stageIndex)
    const group = this.data.scoreGroups[groupIndex]
    if (!group || !group.stages[stageIndex]) return
    const stageName = group.stages[stageIndex]
    const snapshot = this._publishedResults
    const rows = snapshot ? snapshot.rows.filter(row => String(row && row.group || '') === group.name) : []
    const isTotal = stageName === '总成绩'
    const stageNames = isTotal ? group.stages.filter(name => name !== '总成绩') : [stageName]
    const scoreRows = rows.map(row => {
      const stageValues = stageNames.map(name => {
        const stage = row.stageTimes && row.stageTimes[name] || {}
        return {
          name,
          startTime: this.displayScoreValue(stage.startTime),
          endTime: this.displayScoreValue(stage.endTime),
          penalty: this.displayScoreValue(stage.penalty),
          duration: this.displayScoreValue(stage.duration)
        }
      })
      return {
        id: String(row.id || row.carNumber || Math.random()),
        carNumber: String(row.carNumber || ''),
        group: String(row.group || ''),
        rank: row.rank === undefined || row.rank === null ? '' : String(row.rank),
        stageValues,
        validScore: this.displayScoreValue(row.validScore || (snapshot.rankingMode === 'total' ? row.totalScore : row.bestScore)),
        selectedDuration: isTotal ? '' : this.displayScoreValue(row.stageTimes && row.stageTimes[stageName] && row.stageTimes[stageName].duration)
      }
    })
    wx.setNavigationBarTitle({ title: '成绩表' })
    this.setData({
      scoreViewVisible: true,
      selectedScore: {
        groupName: group.name,
        stageName,
        isTotal,
        rankingMode: snapshot && snapshot.rankingMode || 'best',
        rows: scoreRows
      }
    })
  },
  displayScoreValue(value) {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return String(value)
  },
  loadWorkAccess() {
    const requestId = (this._workAccessRequestId || 0) + 1
    this._workAccessRequestId = requestId
    const cached = auth.getUser()
    // 权限必须以云端最新结果为准，不能用旧缓存先显示工作后台入口。
    this.safeSetData({ canAccessWork: false })
    if (!cached) return
    auth.refreshRole().then(user => {
      if (this.__unloaded || this._workAccessRequestId !== requestId) return
      if (!this.data.event || !this.data.event.id || !this.data.eventConfigReady) return
      const verifiedEvent = normalizeEventId(this.data.id)
        && String(this.data.event.id) === String(this.data.id)
        && this.data.eventCloudReady
      this.safeSetData({ canAccessWork: !!(verifiedEvent && this.data.event.workBackendEnabled !== false && this.hasWorkAccess(user)) })
    }).catch(() => {
      if (this.__unloaded || this._workAccessRequestId !== requestId) return
      this.safeSetData({ canAccessWork: false })
    })
  },
  openWorkBackend() {
    const user = auth.getUser()
    if (!user) {
      wx.showToast({ title: '请先登录工作人员账户', icon: 'none' })
      return
    }
    auth.refreshRole().then(current => {
      if (!normalizeEventId(this.data.id) || !this.data.eventConfigReady || !this.data.eventCloudReady || String(this.data.event && this.data.event.id || '') !== String(this.data.id)) {
        this.safeSetData({ canAccessWork: false })
        wx.showToast({ title: '未能验证当前赛事，无法进入工作后台', icon: 'none' })
        return
      }
      if (this.data.event && this.data.event.workBackendEnabled === false) {
        wx.showToast({ title: '本赛事暂未开放工作后台', icon: 'none' })
        return
      }
      if (!this.hasWorkAccess(current)) {
        this.safeSetData({ canAccessWork: false })
        wx.showToast({ title: '当前账户没有工作权限', icon: 'none' })
        return
      }
      wx.navigateTo({ url: '/pages/work/work?eventId=' + encodeURIComponent(this.data.id) })
    }).catch(() => {
      this.safeSetData({ canAccessWork: false })
      wx.showToast({ title: '工作权限校验失败，请重试', icon: 'none' })
    })
  },
  publishMoment() { wx.showToast({ title: '登录后可发布动态', icon: 'none' }) },
  callInteraction(action, data) {
    auth.init()
    if (!wx.cloud) return Promise.reject(new Error('云开发未初始化'))
    return wx.cloud.callFunction({
      name: 'account',
      data: Object.assign({ action, eventId: this.data.id }, data || {})
    }).then(response => {
      const result = response && response.result
      if (!result || !result.ok) throw new Error(result && result.message || '互动服务暂时不可用')
      return result
    })
  },
  applyInteractionStats(result) {
    if (this.__unloaded) return
    const stats = result && result.stats || {}
    this.safeSetData({
      liked: !!stats.liked,
      likeCount: Number(stats.likeCount) || 0,
      commentCount: Number(stats.commentCount) || 0,
      shareCount: Number(stats.shareCount) || 0,
      viewCount: Number(stats.viewCount) || 0,
      comments: result.comments || this.data.comments
    })
  },
  loadInteractionStats(eventId) {
    const viewToken = this.__viewToken
    this.callInteraction('getEventStats', { eventId }).then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
    }).catch(error => {
      console.warn('读取赛事互动记录失败', error)
    })
  },
  recordViewOpen(eventId) {
    const viewToken = this.__viewToken
    this.callInteraction('recordViewOpen', { eventId }).then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
    }).catch(error => {
      console.warn('记录赛事浏览人数失败', error)
    })
  },
  recordShareOpen(source) {
    const viewToken = this.__viewToken
    this.callInteraction('recordShareOpen', { source }).then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
    }).catch(error => {
      console.warn('记录分享打开失败', error)
    })
  },
  toggleLike() {
    if (this.__unloaded || this._likeBusy) return
    this._likeBusy = true
    const previous = {
      liked: this.data.liked,
      likeCount: this.data.likeCount
    }
    const nextLiked = !previous.liked
    const nextLikeCount = Math.max(0, previous.likeCount + (nextLiked ? 1 : -1))
    // Update the visible state before the network round trip so a slow cloud
    // function does not make the tap appear to be ignored.
    this.safeSetData({ liked: nextLiked, likeCount: nextLikeCount })
    const viewToken = this.__viewToken
    this.callInteraction('toggleLike').then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
      wx.showToast({ title: result.stats.liked ? '已点赞' : '已取消点赞', icon: 'none' })
    }).catch(error => {
      if (!this.__unloaded && viewToken === this.__viewToken) this.safeSetData(previous)
      wx.showToast({ title: error.message || '点赞失败，请重试', icon: 'none' })
    })
      .then(() => { this._likeBusy = false })
  },
  openComments() {
    this.setData({ commentVisible: true })
    this.loadInteractionStats(this.data.id)
  },
  closeComments() {
    this.setData({ commentVisible: false })
  },
  stopCommentTap() {},
  onCommentInput(event) {
    this.setData({ commentText: event.detail.value || '' })
  },
  submitComment() {
    const content = (this.data.commentText || '').trim()
    if (!content) {
      wx.showToast({ title: '请输入评论内容', icon: 'none' })
      return
    }
    const viewToken = this.__viewToken
    this.callInteraction('addComment', { content }).then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
      this.safeSetData({ commentText: '' })
      wx.showToast({ title: '评论已发布', icon: 'none' })
    }).catch(error => wx.showToast({ title: error.message || '评论失败，请重试', icon: 'none' }))
  },
  onShareAppMessage() {
    const event = this.data.event || {}
    return { title: event.title || '赛事详情', path: '/subpackages/events/detail/detail?id=' + (this.data.id || 'suiping') + '&fromShare=message' }
  },
  onShareTimeline() {
    const event = this.data.event || {}
    return { title: event.title || '赛事详情', query: 'id=' + (this.data.id || 'suiping') + '&fromShare=timeline' }
  },
  onUnload() {
    this.__unloaded = true
    this.__viewToken = (this.__viewToken || 0) + 1
    if (this._detailTimer) clearTimeout(this._detailTimer)
  },
  makeEvent(id) {
    const eventInfo = {
      suiping: {
        title: '2026中国·遂平嵖岈山首届汽车越野嘉年华《赛事预报》',
        date: '2026-07-17',
        dateFull: '2026-08-23 ~ 2026-08-30',
        notice: '',
        status: '已完赛',
        location: '河南省-驻马店市-遂平县 （报到地点待定）',
        sectionTitles: eventSectionTitles(),
        infoLabels: eventInfoLabels(),
        signup: [
          '集合赛公开A组  ¥ 1/辆（已报0辆）',
          '集合赛公开B组  ¥ 1/辆（已报0辆）',
          '集合赛公开C组  ¥ 1/辆（已报0辆）',
          '集合赛公开D组  ¥ 1/辆（已报0辆）',
          '场地赛专业组  ¥ 1/人（已报0人）',
          '场地赛公开组  ¥ 1/人（已报0人）',
          '场地赛UVT组  ¥ 1/人（已报0人）',
          '场地赛新秀组  ¥ 1/人（已报0人）',
          '场地赛女子组  ¥ 1/人（已报0人）',
          '攀爬赛改装组  ¥ 1/人（已报0人）',
          '攀爬赛量产组  ¥ 1/人（已报0人）'
        ]
      }
    }
    const current = eventInfo[id]
    if (current) return { id, ...current, isGeneric: false, isDynamic: false }
    return {
      id,
      title: '赛事详情',
      date: '',
      dateFull: '',
      notice: '',
      status: '',
      location: '',
      signup: [],
      sectionTitles: eventSectionTitles(),
      infoLabels: eventInfoLabels(),
      detailText: '',
      rulesText: '',
      awardsText: '',
      contentBlocks: [],
      registrationDeadline: '',
      contactName: '',
      contactPhone: '',
      contactWechat: '',
      registrationNote: '',
      signupOptions: [],
      registrationEnabled: false,
      workBackendEnabled: true,
      coverFileId: '',
      coverUrl: '',
      isGeneric: true,
      isDynamic: false
    }
  },
  makeScoreGroups() {
    const stages = ALL_STAGES.concat(['总成绩'])
    return ['四驱组', 'N4组', '两驱组', '1.6组', 'POLO杯', '新人组', '“王者归来”组', '巾帼杯', '四驱俱乐部杯', '两驱俱乐部杯', '厂商杯', '飞车王']
      .map(name => ({ name, stages, expanded: false }))
  },
  makePrizeTables() {
    const rows = (values) => values.map((value, index) => [`第${['一','二','三','四','五','六','七','八','九','十'][index]}名`, value])
    const stage = (title, theme, columns, totals) => {
      const max = Math.max.apply(null, columns.map((column) => column.length))
      const tableRows = Array.from({ length: max }, (_, index) => columns.reduce((cells, column) => cells.concat(column[index] || ['--', '--']), []))
      return { title, theme, headers: ['排位赛奖金', '预赛奖金', '决赛奖金'], columns, rows: tableRows, totals, subtotals: totals }
    }
    return [
      {
        order: 4,
        type: 'open-groups',
        title: '坦克汽车（定向集结赛）奖金设置 19.2万元',
        theme: 'blue',
        groups: ['公开A组', '公开B组', '公开C组', '公开D组'],
        rows: [
          ['第一名','20000','第一名','20000','第一名','20000','第一名','20000'],
          ['第二名','10000','第二名','10000','第二名','10000','第二名','10000'],
          ['第三名','5000','第三名','5000','第三名','5000','第三名','5000'],
          ['第四名','4000','第四名','4000','第四名','4000','第四名','4000'],
          ['第五名','3000','第五名','3000','第五名','3000','第五名','3000'],
          ['第六名','2000','第六名','2000','第六名','2000','第六名','2000'],
          ['第七名','1000','第七名','1000','第七名','1000','第七名','1000'],
          ['第八名','1000','第八名','1000','第八名','1000','第八名','1000'],
          ['第九名','1000','第九名','1000','第九名','1000','第九名','1000'],
          ['第十名','1000','第十名','1000','第十名','1000','第十名','1000']
        ],
        subtotals: ['小计：48000元','小计：48000元','小计：48000元','小计：48000元']
      },
      stage('场地越野赛（专业组）奖金设置 11.5万元', 'orange', [rows(['5000','3000','1000']), rows(['10000','5000','4000','3000','2000','1000']), rows(['30000','20000','10000','6000','5000','4000','3000','2000','1000'])], ['小计：9000元','小计：25000元','小计：81000元']),
      stage('场地越野赛（公开组）奖金设置 8.5万元', 'maroon', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['20000','10000','7000','6000','5000','4000','3000','2000','1000'])], ['小计：6000元','小计：21000元','小计：58000元']),
      stage('场地越野赛（UTV组）奖金设置 8.5万元', 'green', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['20000','10000','7000','6000','5000','4000','3000','2000','1000'])], ['合计：6000元','合计：21000元','合计：58000元']),
      stage('场地越野赛（新秀组）奖金设置 6.3万元', 'yellow', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['10000','8000','6000','4000','3000','2000','1000','1000','1000'])], ['合计：6000元','合计：21000元','合计：36000元']),
      stage('场地越野赛（女子组）奖金设置 5.2万元', 'purple', [rows(['3000','2000','1000']), rows(['5000','4000','3000','2000','1000']), rows(['10000','6000','5000','4000','3000','2000','1000'])], ['小计：6000元','小计：15000元','小计：31000元']),
      stage('城市攀爬赛（改装组）奖金设置 8.5万元', 'charcoal', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['20000','10000','7000','6000','5000','4000','3000','2000','1000'])], ['小计：6000元','小计：21000元','小计：58000元']),
      stage('城市攀爬赛（量产组）奖金设置 6.3万元', 'yellow', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['10000','8000','6000','4000','3000','2000','1000','1000','1000'])], ['小计：6000元','小计：21000元','小计：36000元'])
    ]
  }
})



