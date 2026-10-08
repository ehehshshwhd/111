const STAGES = new Set(Array.from({ length: 9 }, (_, index) => `SS${index + 1}`))

const env = String(process.env.SCORE_REVIEW_CLOUDBASE_ENV || process.env.CBR_ENV_ID || '').trim()
const accessKey = String(process.env.SCORE_REVIEW_CLOUDBASE_APIKEY || process.env.CLOUDBASE_API_KEY || process.env.CLOUDBASE_APIKEY || '').trim()
let database
let cloudClient
let collectionReady
let eventsCollectionReady

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

function cleanEvent(input, id) {
  const source = input || {}
  return {
    id: String(id || source.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 80),
    title: String(source.title || '').trim().slice(0, 160),
    dateStart: String(source.dateStart || '').slice(0, 20),
    dateEnd: String(source.dateEnd || '').slice(0, 20),
    date: String(source.date || '').trim().slice(0, 100),
    dateFull: String(source.dateFull || source.date || '').trim().slice(0, 100),
    location: String(source.location || '').trim().slice(0, 240),
    status: String(source.status || '报名中').trim().slice(0, 30),
    notice: String(source.notice || '').trim().slice(0, 240),
    detailText: String(source.detailText || '').trim().slice(0, 10000),
    coverUrl: String(source.coverUrl || '').trim().slice(0, 2000),
    coverFileId: String(source.coverFileId || '').trim().slice(0, 500),
    published: source.published !== false,
    templateEventId: String(source.templateEventId || '').slice(0, 80),
    publishedAt: source.publishedAt || null,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null
  }
}

async function ensureEventsCollection(db) {
  if (!eventsCollectionReady) {
    eventsCollectionReady = (async () => {
      try {
        await db.collection('events').limit(1).get()
      } catch (error) {
        const message = String(error && (error.errMsg || error.message) || error)
        if (!message.includes('-502005')) throw error
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
  const result = await db.collection('events').limit(200).get()
  const events = (result.data || []).map(record => cleanEvent(record, record.id || record._id))
    .filter(event => event.id && (!options.publishedOnly || event.published))
    .sort((a, b) => new Date(b.publishedAt || b.createdAt || 0).getTime() - new Date(a.publishedAt || a.createdAt || 0).getTime()
      || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
  const fileIds = [...new Set(events.map(event => event.coverFileId).filter(Boolean))]
  if (fileIds.length) {
    const urls = await cloudClient.getTempFileURL({ fileList: fileIds.map(fileID => ({ fileID, maxAge: 3600 })) })
    const urlById = new Map((urls.fileList || []).map(item => [item.fileID, item.tempFileURL]))
    events.forEach(event => {
      if (event.coverFileId && urlById.get(event.coverFileId)) event.coverUrl = urlById.get(event.coverFileId)
    })
  }
  return events
}

async function saveEvent(input) {
  const db = getDatabase()
  await ensureEventsCollection(db)
  const now = new Date()
  const existingId = String(input && input.id || '').trim()
  const id = existingId || `event-${now.getTime()}-${require('node:crypto').randomBytes(4).toString('hex')}`
  const event = cleanEvent(input, id)
  if (!event.title) throw new Error('请填写赛事名称')
  if (!event.dateStart || !event.dateEnd) throw new Error('请填写赛事开始和结束日期')
  if (!event.location) throw new Error('请填写赛事地点')
  const query = await db.collection('events').where({ id }).limit(1).get()
  const previous = query.data && query.data[0]
  const asDate = value => {
    if (!value) return now
    const date = value instanceof Date ? value : new Date(value)
    return Number.isFinite(date.getTime()) ? date : now
  }
  const publishedAt = event.published ? asDate(previous && previous.publishedAt) : null
  const createdAt = asDate(previous && previous.createdAt)
  const data = { ...event, publishedAt, updatedAt: now, createdAt }
  if (previous) await db.collection('events').doc(previous._id).update(data)
  else await db.collection('events').add(data)
  return { ...event, publishedAt: publishedAt && publishedAt.toISOString(), updatedAt: now.toISOString(), createdAt: createdAt.toISOString() }
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

function cleanRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.slice(0, 1000).map((row, index) => ({
    id: String(row && row.id || `web-${index}`).slice(0, 80),
    carNumber: String(row && (row.carNumber || row.car) || '').replace(/[^0-9a-z]/gi, '').toUpperCase().slice(0, 12),
    startTime: String(row && (row.startTime || row.start) || '').slice(0, 24),
    endTime: String(row && (row.endTime || row.finish) || '').slice(0, 24),
    penaltyInputs: Array.isArray(row && row.penaltyInputs) ? row.penaltyInputs.slice(0, 10).map((item, penaltyIndex) => ({
      id: String(item && item.id || `penalty-${penaltyIndex}`).slice(0, 80),
      value: String(item && item.value || '').slice(0, 12)
    })) : [],
    penaltyTotal: String(row && (row.penaltyTotal || row.penalty) || '').slice(0, 16),
    segmentDuration: String(row && (row.segmentDuration || row.duration) || '').slice(0, 24),
    totalDuration: String(row && (row.totalDuration || row.duration) || '').slice(0, 24)
  })).filter(row => row.carNumber)
}

async function ensureCollection(db) {
  if (!collectionReady) {
    collectionReady = (async () => {
      try {
        await db.collection('work_records').limit(1).get()
      } catch (error) {
        const message = String(error && (error.errMsg || error.message) || error)
        if (!message.includes('-502005')) throw error
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
  return { eventId: String(eventId || 'default').slice(0, 100), stage }
}

async function get(eventId, stage) {
  const db = getDatabase()
  const pair = validate(eventId, String(stage || '').toUpperCase())
  await ensureCollection(db)
  const result = await db.collection('work_records').where(pair).orderBy('updatedAt', 'desc').limit(1).get()
  const record = result.data && result.data[0]
  return {
    rows: cleanRows(record && record.rows),
    updatedAt: record && record.updatedAt || null,
    updatedByPhone: record && record.updatedByPhone || ''
  }
}

async function check() {
  const db = getDatabase()
  await db.collection('work_records').limit(1).get()
  return true
}

async function put(eventId, stage, inputRows) {
  const db = getDatabase()
  const pair = validate(eventId, String(stage || '').toUpperCase())
  await ensureCollection(db)
  const rows = cleanRows(inputRows)
  const existing = await db.collection('work_records').where(pair).limit(1).get()
  const now = new Date()
  const data = { ...pair, rows, updatedAt: now, updatedBy: 'web-admin', updatedByPhone: '网页管理员', updatedByRole: 'admin' }
  if (existing.data && existing.data.length) {
    await db.collection('work_records').doc(existing.data[0]._id).update(data)
  } else {
    await db.collection('work_records').add({ ...data, createdAt: now })
  }
  return { count: rows.length }
}

module.exports = {
  enabled: Boolean(env),
  env,
  authConfigured: Boolean(accessKey || (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY)),
  authMode: accessKey
    ? 'api-key'
    : (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY ? 'runtime-credentials' : 'missing'),
  check,
  get,
  put,
  listEvents,
  saveEvent,
  uploadEventCover
}
