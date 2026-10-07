const STAGES = new Set(Array.from({ length: 9 }, (_, index) => `SS${index + 1}`))

const env = String(process.env.SCORE_REVIEW_CLOUDBASE_ENV || '').trim()
let database
let collectionReady

function getDatabase() {
  if (!env) throw new Error('未配置 SCORE_REVIEW_CLOUDBASE_ENV')
  if (!database) {
    const cloudbase = require('@cloudbase/node-sdk')
    database = cloudbase.init({ env }).database()
  }
  return database
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

module.exports = { enabled: Boolean(env), env, get, put }
