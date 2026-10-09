const STAGES = new Set(Array.from({ length: 9 }, (_, index) => `SS${index + 1}`))

const env = String(process.env.SCORE_REVIEW_CLOUDBASE_ENV || process.env.CBR_ENV_ID || '').trim()
const accessKey = String(process.env.SCORE_REVIEW_CLOUDBASE_APIKEY || process.env.CLOUDBASE_API_KEY || process.env.CLOUDBASE_APIKEY || '').trim()
let database
let cloudClient
let collectionReady
let eventsCollectionReady
let publishedResultsCollectionReady
let permissionsCollectionsReady

const PERMISSION_STAGES = Array.from(STAGES)
const ENTRY_PERMISSION_KEYS = ['startTime', 'endTime', 'penalty']
const SUPER_ADMIN_PHONE = String(process.env.SCORE_REVIEW_SUPER_ADMIN_PHONE || '13729912574')
  .replace(/\D/g, '')
  .replace(/^86(?=1\d{10}$)/, '')

function cleanGroupNames(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100)
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
  for (const [rawGroup, rawStages] of Object.entries(value).slice(0, 100)) {
    const group = String(rawGroup || '').trim().slice(0, 100)
    if (!group) continue
    result[group] = cleanStageNames(rawStages).filter(stage => allowed.has(stage))
  }
  return result
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

function cleanEvent(input, id) {
  const source = input || {}
  const stageNames = cleanStageNames(source.stageNames)
  const allowedStages = stageNames.length ? stageNames : STAGES
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
    rulesText: String(source.rulesText || '').trim().slice(0, 10000),
    awardsText: String(source.awardsText || '').trim().slice(0, 10000),
    coverUrl: String(source.coverUrl || '').trim().slice(0, 2000),
    coverFileId: String(source.coverFileId || '').trim().slice(0, 500),
    groups: cleanGroupNames(source.groups),
    visibleGroups: cleanGroupNames(source.visibleGroups),
    stageNames,
    groupStageNames: cleanGroupStageNames(source.groupStageNames, allowedStages),
    scoringType: String(source.scoringType || 'rally').toLowerCase() === 'points' ? 'points' : 'rally',
    rankingMode: String(source.rankingMode || 'best').toLowerCase() === 'total' ? 'total' : 'best',
    registrationEnabled: source.registrationEnabled === true,
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
}

async function ensurePermissionsCollections(db) {
  if (!permissionsCollectionsReady) {
    permissionsCollectionsReady = Promise.all(['admin_users', 'staff_users'].map(async name => {
      try {
        await db.collection(name).limit(1).get()
      } catch (error) {
        const message = String(error && (error.errMsg || error.message) || error)
        if (!message.includes('-502005') && !/collection.*(not exist|doesn't exist|不存在)/i.test(message)) throw error
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
  if (!Array.isArray(rows)) return []
  return rows.slice(0, 1000).map((row, index) => ({
    id: String(row && row.id || `web-${index}`).slice(0, 80),
    carNumber: String(row && (row.carNumber || row.car) || '').replace(/[^0-9a-z]/gi, '').toUpperCase().slice(0, 12),
    group: String(row && (row.group || row.groupName || row.teamName) || '').trim().slice(0, 100),
    startTime: String(row && (row.startTime || row.start) || '').slice(0, 24),
    endTime: String(row && (row.endTime || row.finish) || '').slice(0, 24),
    penaltyInputs: Array.isArray(row && row.penaltyInputs) ? row.penaltyInputs.slice(0, 10).map((item, penaltyIndex) => ({
      id: String(item && item.id || `penalty-${penaltyIndex}`).slice(0, 80),
      value: String(item && item.value || '').slice(0, 12)
    })) : [],
    penaltyTotal: String(row && (row.penaltyTotal || row.penalty) || '').slice(0, 16),
    segmentDuration: String(row && (row.segmentDuration || row.duration) || '').slice(0, 24),
    totalDuration: String(row && (row.totalDuration || row.duration) || '').slice(0, 24),
    status: ['approved', 'returned', 'pending'].includes(String(row && row.status || '').toLowerCase())
      ? String(row.status).toLowerCase()
      : 'pending'
  })).filter(row => row.carNumber)
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
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

function resultTimes(row) {
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
        const message = String(error && (error.errMsg || error.message) || error)
        if (!message.includes('-502005')) throw error
        try { await db.createCollection('published_results') } catch { await db.collection('published_results').limit(1).get() }
      }
    })().catch(error => {
      publishedResultsCollectionReady = null
      throw error
    })
  }
  return publishedResultsCollectionReady
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

function cleanPublishedResults(record, eventId = '') {
  const source = record || {}
  const stageNames = Array.isArray(source.stageNames) ? cleanStageNames(source.stageNames) : []
  return {
    ok: true,
    eventId: String(source.eventId || eventId || ''),
    publishedAt: source.publishedAt || null,
    rankingMode: source.rankingMode === 'total' ? 'total' : 'best',
    groups: cleanGroupNames(source.groups),
    stageNames,
    groupStageNames: cleanGroupStageNames(source.groupStageNames, stageNames.length ? stageNames : STAGES),
    rows: Array.isArray(source.rows) ? source.rows : []
  }
}

async function getPublishedResults(eventId) {
  const id = String(eventId || '').trim().slice(0, 100)
  if (!id) throw new Error('赛事无效')
  const db = getDatabase()
  await ensurePublishedResultsCollection(db)
  const result = await db.collection('published_results').where({ eventId: id }).limit(1).get()
  return cleanPublishedResults(result.data && result.data[0], id)
}

async function publishResults(eventId, visibleGroups, rankingMode, requestedGroupStageNames) {
  const id = String(eventId || '').trim().slice(0, 100)
  if (!id) throw new Error('请先选择赛事')
  const db = getDatabase()
  await ensureEventsCollection(db)
  await ensureCollection(db)
  await ensurePublishedResultsCollection(db)

  const eventResult = await db.collection('events').where({ id }).limit(1).get()
  const storedEvent = eventResult.data && eventResult.data[0]
  if (!storedEvent) throw new Error('没有找到该赛事，请先保存并发布赛事信息')
  const event = cleanEvent(storedEvent, storedEvent.id || storedEvent._id)
  const hasRequestedGroupStageNames = requestedGroupStageNames && typeof requestedGroupStageNames === 'object' && !Array.isArray(requestedGroupStageNames) && Object.keys(requestedGroupStageNames).length > 0
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
  const mode = rankingMode === 'total' ? 'total' : 'best'
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

  for (const [stage, record] of stageEntries) {
    for (const row of record.rows) {
      if (row.status !== 'approved') continue
      if (!selectedGroups.size) continue
      if (!row.group) { approvedWithoutGroup += 1; continue }
      if (!selectedGroups.has(row.group)) continue
      if (hasGroupStageConfig && !(groupStageNames[row.group] || []).includes(stage)) continue
      const times = resultTimes(row)
      if (!times || times.effective <= 0) continue
      const carNumber = row.carNumber
      if (!byCar.has(carNumber)) byCar.set(carNumber, { carNumber, group: row.group, stageTimes: {} })
      const competitor = byCar.get(carNumber)
      // A competitor number is unique within an event. If a row was accidentally
      // assigned to two groups, keep its first approved assignment consistently.
      if (competitor.group !== row.group) continue
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
    rows
  }
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
  const existing = await db.collection('published_results').where({ eventId: id }).limit(1).get()
  if (existing.data && existing.data.length) await db.collection('published_results').doc(existing.data[0]._id).update(snapshot)
  else await db.collection('published_results').add(snapshot)
  return { ...cleanPublishedResults(snapshot, id), rowCount: rows.length, unassignedRowCount: approvedWithoutGroup }
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
  getPublishedResults,
  publishResults,
  listEvents,
  saveEvent,
  uploadEventCover,
  listPermissions,
  upsertPermission,
  updatePermission,
  deletePermission
}
