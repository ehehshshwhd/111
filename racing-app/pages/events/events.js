const container = require('../../utils/cloud-container')

const RETIRED_EVENT_IDS = new Set(['dabieshan', 'linxi'])
// 本地缓存：切换 tab 时先用缓存渲染，后台静默刷新
const CACHE_TTL_MS = 60 * 1000 // 1 分钟内不重复请求

function readEventList(response) {
  let payload = response && response.data
  if (typeof payload === 'string') {
    payload = JSON.parse(payload)
  }
  const events = payload && payload.events
  if (!Array.isArray(events)) throw new Error('云端赛事列表格式错误')
  return events
}

function eventDate(event) {
  if (event.date) return String(event.date)
  const start = String(event.dateStart || '')
  const end = String(event.dateEnd || '')
  if (start && end) return `${start} ~ ${end}`
  return start || end
}

function timestamp(value) {
  if (!value) return 0
  const result = new Date(value).getTime()
  return Number.isFinite(result) ? result : 0
}

function mapPublishedEvents(publishedEvents) {
  return publishedEvents
    .filter(event => event && (event.id || event._id)
      && !RETIRED_EVENT_IDS.has(String(event.id || event._id)))
    .map(event => {
      const id = String(event.id || event._id)
      return {
        id,
        title: String(event.title || '赛事详情'),
        date: eventDate(event),
        location: String(event.location || ''),
        status: String(event.status || ''),
        notice: event.notice == null ? '' : String(event.notice || ''),
        coverFileId: String(event.coverFileId || ''),
        coverUrl: String(event.coverUrl || ''),
        detailText: String(event.detailText || ''),
        publishedAt: event.publishedAt || null,
        kind: 'custom'
      }
    })
    .sort((left, right) => timestamp(right.publishedAt) - timestamp(left.publishedAt)
      || timestamp(right.createdAt) - timestamp(left.createdAt))
}

// 上一次成功换到的封面地址按文件 ID 记住，签名请求偶发失败时仍能显示封面
const coverUrlCache = Object.create(null)

function resolveCoverUrls(events, attempt = 0) {
  if (!wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') return Promise.resolve(events)
  const fileIds = Array.from(new Set(events.map(event => event.coverFileId).filter(Boolean)))
  if (!fileIds.length) return Promise.resolve(events)
  return wx.cloud.getTempFileURL({ fileList: fileIds }).then(response => {
    const urls = Object.create(null)
    ;(response && response.fileList || []).forEach(file => {
      if (file && file.fileID && file.tempFileURL) {
        urls[file.fileID] = file.tempFileURL
        coverUrlCache[file.fileID] = file.tempFileURL
      }
    })
    return events.map(event => event.coverUrl || !event.coverFileId
      ? event
      : { ...event, coverUrl: urls[event.coverFileId] || coverUrlCache[event.coverFileId] || '' })
  }).catch(error => {
    if (attempt < 1) return resolveCoverUrls(events, attempt + 1)
    console.warn('赛事封面加载失败', error)
    return events.map(event => event.coverUrl || !event.coverFileId
      ? event
      : { ...event, coverUrl: coverUrlCache[event.coverFileId] || '' })
  })
}

function isTransientEventLoadError(error) {
  const code = String(error && (error.errCode || error.code) || '').toUpperCase()
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code)) return true
  const message = String(error && (error.errMsg || error.message) || '').toLowerCase()
  return /timed? ?out|timeout|network|socket|econnreset|econnrefused|enetunreach|ehostunreach|eai_again|connection reset|connection refused|request:fail|云托管请求失败（5\d\d）|服务暂时不可用/.test(message)
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function fetchPublishedEvents(attempt = 0) {
  return container.call('/api/public/events').then(readEventList).then(resolveCoverUrls).catch(error => {
    if (attempt >= 2 || !isTransientEventLoadError(error)) throw error
    return wait(200 * (attempt + 1)).then(() => fetchPublishedEvents(attempt + 1))
  })
}

Page({
  data: { events: [], loading: true, error: '' },

  onShow() {
    const bar = this.getTabBar && this.getTabBar()
    if (bar) bar.setData({ selected: 0 })

    const now = Date.now()
    const age = now - (this._cacheTime || 0)
    const hasCache = this.data.events.length > 0

    if (hasCache && age < CACHE_TTL_MS) {
      // 缓存还新鲜，直接用，不发请求
      return
    }

    if (hasCache) {
      // 有旧缓存先显示，后台静默刷新（不显示 loading）
      this._silentRefresh()
    } else {
      // 首次加载，显示 loading
      this.loadPublishedEvents()
    }
  },

  loadPublishedEvents() {
    const requestId = (this._eventsRequestId || 0) + 1
    this._eventsRequestId = requestId
    this.setData({ loading: true, error: '' })
    return fetchPublishedEvents().then(events => {
      if (this._eventsRequestId !== requestId) return
      this._cacheTime = Date.now()
      this.setData({ events: mapPublishedEvents(events), loading: false, error: '' })
    }).catch(error => {
      if (this._eventsRequestId !== requestId) return
      console.warn('读取已发布赛事失败', error)
      this.setData({ loading: false, error: '赛事加载失败，请重试' })
    })
  },

  _silentRefresh() {
    const requestId = (this._eventsRequestId || 0) + 1
    this._eventsRequestId = requestId
    fetchPublishedEvents().then(events => {
      if (this._eventsRequestId !== requestId) return
      this._cacheTime = Date.now()
      this.setData({ events: mapPublishedEvents(events), error: '' })
    }).catch(error => {
      // 静默刷新失败时不显示错误，用户看到的还是旧缓存
      console.warn('赛事静默刷新失败', error)
    })
  },

  openEvent(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/subpackages/events/detail/detail?id=' + encodeURIComponent(id) })
  }
})
