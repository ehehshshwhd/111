const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cloudStore = require('./cloud-store')
const { isValidEventId, validateEventId } = require('./event-id')

const HOST = process.env.SCORE_REVIEW_HOST || '0.0.0.0'
const PORT = Number(process.env.SCORE_REVIEW_PORT || process.env.PORT || 4173)
const WEB_ROOT = __dirname
const DATA_FILE = process.env.SCORE_REVIEW_DATA || path.join(WEB_ROOT, 'server-data.json')
const WEB_PASSWORD = process.env.SCORE_REVIEW_PASSWORD
const SESSION_SECRET = process.env.SCORE_REVIEW_SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex'))
// Keep the admin session persistent. The signature still prevents tampering;
// the browser can end it by clearing site data or the server can rotate the
// session secret when an immediate logout of all sessions is required.
const SESSION_COOKIE_MAX_AGE = 2147483647

if (!WEB_PASSWORD || !SESSION_SECRET) {
  console.error('缺少 SCORE_REVIEW_PASSWORD 或 SCORE_REVIEW_SESSION_SECRET。请在服务环境变量中设置后再启动。')
  process.exitCode = 1
  return
}

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } catch { return {} }
}
function writeData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8') }
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url') }
function makeSession() { const payload = Buffer.from(JSON.stringify({ v: 1 })).toString('base64url'); return `${payload}.${sign(payload)}` }
function validSession(req) {
  const value = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('score_session='))
  if (!value) return false
  const token = value.slice('score_session='.length); const parts = token.split('.')
  if (parts.length !== 2) return false
  const supplied = Buffer.from(parts[1]); const expected = Buffer.from(sign(parts[0]))
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return false
  try {
    const session = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    return session && (session.v === 1 || (Number.isFinite(session.exp) && session.exp > Date.now()))
  } catch { return false }
}
function send(res, status, body, headers = {}) { const data = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers }); res.end(data) }
function serve(res, urlPath) {
  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const templateCover = requested === 'event-template-cover.jpg'
    ? (fs.existsSync(path.join(WEB_ROOT, requested)) ? path.join(WEB_ROOT, requested) : path.resolve(WEB_ROOT, '..', 'racing-app', 'assets', 'events', 'event2-poster-crop.jpg'))
    : null
  const bundledEventAssets = {
    'event-assets/stage-01.jpg': path.join(WEB_ROOT, 'event-assets', 'stage-01.jpg'),
    'event-assets/stage-02-banner.jpg': path.join(WEB_ROOT, 'event-assets', 'stage-02-banner.jpg'),
    'event-assets/stage-03.jpg': path.join(WEB_ROOT, 'event-assets', 'stage-03.jpg')
  }
  let bundledEventAsset = bundledEventAssets[requested] || null
  if (!bundledEventAsset && /^event-assets\//i.test(requested)) {
    let assetName = ''
    try { assetName = decodeURIComponent(requested.slice('event-assets/'.length)) } catch {}
    if (/^[A-Za-z0-9._-]+$/.test(assetName)) {
      const candidates = [
        path.join(WEB_ROOT, 'event-assets', assetName),
        path.resolve(WEB_ROOT, '..', 'racing-app', 'subpackages', 'events', 'assets', assetName)
      ]
      bundledEventAsset = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null
    }
  }
  const file = templateCover || bundledEventAsset || path.resolve(WEB_ROOT, requested)
  const isBundledTemplateCover = requested === 'event-template-cover.jpg' && templateCover === file
  const isBundledEventAsset = bundledEventAsset === file
  if ((!file.startsWith(path.resolve(WEB_ROOT) + path.sep) && !isBundledTemplateCover && !isBundledEventAsset) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { ok: false, message: '页面不存在' })
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' }
  let data = fs.readFileSync(file)
  if (path.basename(file) === 'index.html' && process.env.SCORE_REVIEW_API_BASE === 'same-origin') {
    data = Buffer.from(data.toString('utf8').replace('// SCORE_REVIEW_CONFIG', 'window.SCORE_REVIEW_API=window.location.origin;'))
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' }); res.end(data)
}
function body(req) { return new Promise((resolve, reject) => { let value = ''; req.on('data', chunk => { value += chunk; if (value.length > 8 * 1024 * 1024) reject(new Error('请求过大')) }); req.on('end', () => { try { resolve(value ? JSON.parse(value) : {}) } catch { reject(new Error('请求格式无效')) } }); req.on('error', reject) }) }
function key(eventId, stage) { return `${validateEventId(eventId)}::${String(stage || '').toUpperCase()}` }
function publicEventView(event) {
  // Return each editable event-detail section as its own field so the mini
  // program can render registration, rules and awards in their proper places.
  return { ...event, editorDetailText: String(event.detailText || '') }
}
function cloudError(res, error) {
  const rawMessage = String(error && (error.errMsg || error.message) || error)
  const rawCode = String(error && (error.code || error.errCode) || '')
  console.error('CloudBase request failed:', error && (error.stack || error.message) || error)
  let message = 'CloudBase 数据库暂时不可用，请检查云托管环境变量和数据库权限。'
  let diagnosticCode = rawCode || 'CLOUD_DB_ERROR'
  if (/未配置 SCORE_REVIEW_CLOUDBASE_ENV/i.test(rawMessage)) {
    message = '未配置 CloudBase 环境 ID，请设置 SCORE_REVIEW_CLOUDBASE_ENV。'
    diagnosticCode = 'CLOUD_ENV_MISSING'
  } else if (/missing secret|secretId|secretKey|accessKey|credential|INVALID_ACCESS_TOKEN|token format|鉴权|权限|403|401/i.test(rawMessage) || /INVALID_ACCESS_TOKEN/i.test(rawCode)) {
    message = 'CloudBase 鉴权失败，请在云托管环境变量中配置 CLOUDBASE_API_KEY，并确认该密钥属于当前环境。'
    diagnosticCode = rawCode || 'CLOUD_AUTH_ERROR'
  } else if (/collection|502005|不存在/i.test(rawMessage)) {
    message = 'CloudBase 数据集合不可用，请检查数据库集合和服务权限。'
    diagnosticCode = rawCode || 'CLOUD_COLLECTION_ERROR'
  }
  if (/成绩已被其他设备修改|版本号缺失|本次未覆盖云端数据/i.test(rawMessage)) {
    return send(res, 409, { ok: false, code: rawCode || 'REVISION_CONFLICT', message: rawMessage })
  }
  if (/云端(?:成绩记录|已发布成绩|赛事 ID).*重复/i.test(rawMessage)) {
    return send(res, 409, { ok: false, code: rawCode || 'CLOUD_DUPLICATE_RECORD', message: rawMessage })
  }
  return send(res, 503, { ok: false, message, diagnosticCode })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end() }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (url.pathname === '/api/session' && req.method === 'POST') {
    try { const input = await body(req); const supplied = Buffer.from(String(input.password || '')); const expected = Buffer.from(WEB_PASSWORD); if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(res, 401, { ok: false, message: '网页密码错误' }); const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : ''; return send(res, 200, { ok: true }, { 'Set-Cookie': `score_session=${makeSession()}; HttpOnly;${secure} SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}; Path=/` }) } catch (error) { return send(res, 400, { ok: false, message: error.message }) }
  }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    let cloudDatabaseConnected = false
    let cloudDatabaseDiagnostic = cloudStore.enabled ? 'CLOUD_DB_UNCHECKED' : 'CLOUD_DISABLED'
    if (cloudStore.enabled) {
      try {
        await cloudStore.check()
        cloudDatabaseConnected = true
        cloudDatabaseDiagnostic = 'OK'
      } catch (error) {
        const detail = String(error && (error.errMsg || error.message) || error)
        const code = String(error && (error.code || error.errCode) || '')
        if (/missing secret|secretId|secretKey|accessKey|credential/i.test(detail)) cloudDatabaseDiagnostic = 'CLOUD_AUTH_MISSING'
        else if (/INVALID_ACCESS_TOKEN|token format/i.test(detail) || /INVALID_ACCESS_TOKEN/i.test(code)) cloudDatabaseDiagnostic = 'CLOUD_API_KEY_INVALID'
        else if (/permission|forbidden|unauthorized|无权限|权限/i.test(detail) || /PERMISSION|FORBIDDEN/i.test(code)) cloudDatabaseDiagnostic = 'CLOUD_DB_PERMISSION_DENIED'
        else if (/collection|502005|不存在/i.test(detail)) cloudDatabaseDiagnostic = 'CLOUD_COLLECTION_ERROR'
        else cloudDatabaseDiagnostic = code || 'CLOUD_DB_ERROR'
        console.error('CloudBase health check failed:', code, error && error.message || error)
      }
    }
    return send(res, cloudDatabaseConnected || !cloudStore.enabled ? 200 : 503, {
      ok: cloudDatabaseConnected || !cloudStore.enabled,
      cloudEnabled: cloudStore.enabled,
      cloudEnvConfigured: Boolean(cloudStore.env),
      cloudAuthConfigured: Boolean(cloudStore.authConfigured),
      cloudAuthMode: cloudStore.authMode,
      cloudDatabaseConnected,
      cloudDatabaseDiagnostic
    })
  }
  if (url.pathname === '/api/public/events' && req.method === 'GET') {
    try {
      const events = cloudStore.enabled
        ? await cloudStore.listEvents({ publishedOnly: true })
        : (readData().events || []).filter(event => event.published !== false).sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      return send(res, 200, { ok: true, events: events.map(publicEventView) })
    } catch (error) { return cloudError(res, error) }
  }
  if (url.pathname === '/api/public/results' && req.method === 'GET') {
    try {
      const rawEventId = url.searchParams.get('eventId')
      if (!isValidEventId(rawEventId)) return send(res, 400, { ok: false, message: '赛事 ID 无效' })
      const eventId = validateEventId(rawEventId)
      const result = cloudStore.enabled
        ? await cloudStore.getPublishedResults(eventId)
        : (readData().publishedResults || {})[eventId] || { ok: true, eventId, publishedAt: null, rankingMode: 'best', groups: [], stageNames: [], rows: [] }
      return send(res, 200, result)
    } catch (error) { return cloudError(res, error) }
  }
  if (url.pathname.startsWith('/api/')) {
    if (!validSession(req)) return send(res, 401, { ok: false, message: '请先登录网页后台' })
    if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { ok: true })
    if (url.pathname === '/api/events' && req.method === 'POST') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '赛事发布需要先连接 CloudBase；当前服务未配置云端数据库。' })
        const input = await body(req)
        const event = await cloudStore.saveEvent(input)
        return send(res, 200, { ok: true, event })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '赛事保存失败' }) }
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      try {
        if (cloudStore.enabled) {
          const events = await cloudStore.listEvents()
          return send(res, 200, { ok: true, events: Array.isArray(events) ? events : [] })
        }
        const events = (readData().events || [])
          .filter(event => event && !event.deletedAt)
          .sort((a, b) => new Date(b.publishedAt || b.updatedAt || b.createdAt || 0) - new Date(a.publishedAt || a.updatedAt || a.createdAt || 0))
        return send(res, 200, { ok: true, events })
      } catch (error) { return cloudError(res, error) }
    }
    if (url.pathname === '/api/events' && req.method === 'DELETE') {
      try {
        const input = await body(req)
        // Validate the target before checking cloud availability so malformed
        // or placeholder IDs can never be treated as delete requests.
        const rawId = typeof input.eventId === 'string' ? input.eventId.trim() : ''
        if (!rawId || ['preview', 'default'].includes(rawId)) return send(res, 400, { ok: false, message: '请选择一个真实的云端赛事后再删除' })
        if (!isValidEventId(rawId)) return send(res, 400, { ok: false, message: '赛事 ID 无效，未删除任何数据' })
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '删除赛事需要先连接 CloudBase；当前服务未配置云端数据库。' })
        const result = await cloudStore.deleteEvent(rawId)
        return send(res, 200, { ok: true, ...result, retained: ['work_records', 'published_results', 'uploads', 'event_metrics'] })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '赛事删除失败' }) }
    }
    if (url.pathname === '/api/published-results' && req.method === 'POST') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '发布成绩需要连接 CloudBase；当前服务未配置云端数据库。' })
        const input = await body(req)
        if (!isValidEventId(input.eventId)) return send(res, 400, { ok: false, message: '赛事 ID 无效' })
        const result = await cloudStore.publishResults(input.eventId, input.visibleGroups, input.rankingMode, input.groupStageNames)
        return send(res, 200, { ok: true, ...result })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '成绩发布失败' }) }
    }
    if (url.pathname === '/api/approve-all-scores' && req.method === 'POST') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '批量审核需要连接 CloudBase；当前服务未配置云端数据库。' })
        const input = await body(req)
        if (!isValidEventId(input.eventId)) return send(res, 400, { ok: false, message: '赛事 ID 无效' })
        const result = await cloudStore.approveAllScores(input.eventId)
        return send(res, 200, { ok: true, ...result })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '成绩批量审核失败' }) }
    }
    if (url.pathname === '/api/upload-batches' && req.method === 'GET') {
      try {
        const rawEventId = url.searchParams.get('eventId')
        if (!isValidEventId(rawEventId)) return send(res, 400, { ok: false, message: '赛事 ID 无效' })
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '上传批次需要连接 CloudBase；当前服务未配置云端数据库。' })
        const result = await cloudStore.listUploadBatches(rawEventId)
        return send(res, 200, { ok: true, ...result })
      } catch (error) { return cloudError(res, error) }
    }
    if (url.pathname === '/api/publish-history' && req.method === 'GET') {
      try {
        const rawEventId = url.searchParams.get('eventId')
        if (!isValidEventId(rawEventId)) return send(res, 400, { ok: false, message: '赛事 ID 无效' })
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '发布记录需要连接 CloudBase；当前服务未配置云端数据库。' })
        const result = await cloudStore.listPublishHistory(rawEventId)
        return send(res, 200, { ok: true, ...result })
      } catch (error) { return cloudError(res, error) }
    }
    if (url.pathname === '/api/event-assets' && req.method === 'POST') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '上传赛事图片需要连接 CloudBase 云存储' })
        const result = await cloudStore.uploadEventAsset(await body(req))
        return send(res, 200, { ok: true, ...result })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '赛事图片上传失败' }) }
    }
    if (url.pathname === '/api/event-covers' && req.method === 'POST') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '上传封面需要连接 CloudBase 云存储' })
        const result = await cloudStore.uploadEventCover(await body(req))
        return send(res, 200, { ok: true, ...result })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '封面上传失败' }) }
    }
    if (url.pathname === '/api/permissions' && req.method === 'GET') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '权限管理需要先连接 CloudBase；当前服务未配置云端数据库。' })
        const permissions = await cloudStore.listPermissions()
        return send(res, 200, { ok: true, ...permissions })
      } catch (error) { return cloudError(res, error) }
    }
    if (url.pathname === '/api/permissions' && req.method === 'POST') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '权限管理需要先连接 CloudBase；当前服务未配置云端数据库。' })
        const permissions = await cloudStore.upsertPermission(await body(req))
        return send(res, 200, { ok: true, ...permissions })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '权限保存失败' }) }
    }
    if (url.pathname === '/api/permissions' && req.method === 'PATCH') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '权限管理需要先连接 CloudBase；当前服务未配置云端数据库。' })
        const permissions = await cloudStore.updatePermission(await body(req))
        return send(res, 200, { ok: true, ...permissions })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '权限状态更新失败' }) }
    }
    if (url.pathname === '/api/permissions' && req.method === 'DELETE') {
      try {
        if (!cloudStore.enabled) return send(res, 503, { ok: false, message: '权限管理需要先连接 CloudBase；当前服务未配置云端数据库。' })
        const permissions = await cloudStore.deletePermission(await body(req))
        return send(res, 200, { ok: true, ...permissions })
      } catch (error) { return send(res, 400, { ok: false, message: error.message || '权限删除失败' }) }
    }
    if (url.pathname === '/api/work-records' && req.method === 'GET') {
      const rawEventId = url.searchParams.get('eventId'); const stage = String(url.searchParams.get('stage') || '').toUpperCase()
      if (!isValidEventId(rawEventId)) return send(res, 400, { ok: false, message: '赛事 ID 无效' })
      const eventId = validateEventId(rawEventId)
      if (!/^SS(?:[1-9]|1\d|20)$/.test(stage)) return send(res, 400, { ok: false, message: '赛段无效' })
      try {
        const record = cloudStore.enabled ? await cloudStore.get(eventId, stage) : (readData()[key(eventId, stage)] || { rows: [], revision: 0, updatedAt: null, updatedByPhone: '' })
        return send(res, 200, { ok: true, ...record, count: Array.isArray(record.rows) ? record.rows.length : 0 })
      } catch (error) { return cloudError(res, error) }
    }
    if (url.pathname === '/api/work-records' && req.method === 'PUT') {
      try {
        const input = await body(req); const stage = String(input.stage || '').toUpperCase()
        if (!isValidEventId(input.eventId) || !/^SS(?:[1-9]|1\d|20)$/.test(stage) || !Array.isArray(input.rows)) return send(res, 400, { ok: false, message: '赛事 ID、赛段或成绩格式无效' })
        const eventId = validateEventId(input.eventId)
        if (input.rows.length > 1000) return send(res, 400, { ok: false, message: '每个赛段最多保存 1000 条成绩，请分批检查后重试' })
        const rows = cloudStore.normalizeRows(input.rows); const record = { rows, revision: 0, updatedAt: new Date().toISOString(), updatedByPhone: '网页管理员' }
        let saved = { count: rows.length, revision: Number(input.expectedRevision) + 1, verified: true }
        if (cloudStore.enabled) {
          if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return send(res, 409, { ok: false, code: 'REVISION_REQUIRED', message: '成绩版本号缺失，请刷新赛段后重试' })
          saved = await cloudStore.put(eventId, stage, rows, input.expectedRevision)
        } else {
          const data = readData(); const old = data[key(eventId, stage)]; const actual = Number.isSafeInteger(Number(old && old.revision)) && Number(old && old.revision) >= 0 ? Number(old.revision) : 0
          if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== actual) return send(res, 409, { ok: false, code: 'REVISION_CONFLICT', message: `成绩已被其他设备修改（云端版本 ${actual}，本地版本 ${input.expectedRevision}），请刷新后重试` })
          record.revision = actual + 1; data[key(eventId, stage)] = record; writeData(data); saved.revision = record.revision
        }
        return send(res, 200, { ok: true, count: rows.length, revision: saved.revision, verified: saved.verified === true })
      } catch (error) { if (cloudStore.enabled) return cloudError(res, error); return send(res, 400, { ok: false, message: error.message }) }
    }
    return send(res, 404, { ok: false, message: '接口不存在' })
  }
  serve(res, url.pathname)
})

server.listen(PORT, HOST, () => console.log(`成绩审核网页已启动，监听 ${HOST}:${PORT}；数据存储：${cloudStore.enabled ? `CloudBase ${cloudStore.env}` : '本机 JSON 文件'}`))
