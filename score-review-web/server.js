const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cloudStore = require('./cloud-store')

const HOST = process.env.SCORE_REVIEW_HOST || '0.0.0.0'
const PORT = Number(process.env.SCORE_REVIEW_PORT || process.env.PORT || 4173)
const WEB_ROOT = __dirname
const DATA_FILE = process.env.SCORE_REVIEW_DATA || path.join(WEB_ROOT, 'server-data.json')
const WEB_PASSWORD = process.env.SCORE_REVIEW_PASSWORD
const SESSION_SECRET = process.env.SCORE_REVIEW_SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex'))

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
function makeSession() { const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url'); return `${payload}.${sign(payload)}` }
function validSession(req) {
  const value = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('score_session='))
  if (!value) return false
  const token = value.slice('score_session='.length); const parts = token.split('.')
  if (parts.length !== 2) return false
  const supplied = Buffer.from(parts[1]); const expected = Buffer.from(sign(parts[0]))
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return false
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString()).exp > Date.now() } catch { return false }
}
function send(res, status, body, headers = {}) { const data = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers }); res.end(data) }
function serve(res, urlPath) {
  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.resolve(WEB_ROOT, requested)
  if (!file.startsWith(path.resolve(WEB_ROOT) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { ok: false, message: '页面不存在' })
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' }
  let data = fs.readFileSync(file)
  if (path.basename(file) === 'index.html' && process.env.SCORE_REVIEW_API_BASE === 'same-origin') {
    data = Buffer.from(data.toString('utf8').replace('// SCORE_REVIEW_CONFIG', 'window.SCORE_REVIEW_API=window.location.origin;'))
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' }); res.end(data)
}
function body(req) { return new Promise((resolve, reject) => { let value = ''; req.on('data', chunk => { value += chunk; if (value.length > 2 * 1024 * 1024) reject(new Error('请求过大')) }); req.on('end', () => { try { resolve(value ? JSON.parse(value) : {}) } catch { reject(new Error('请求格式无效')) } }); req.on('error', reject) }) }
function key(eventId, stage) { return `${String(eventId || 'default').slice(0, 100)}::${String(stage || '').toUpperCase()}` }
function cloudError(res, error) {
  console.error('CloudBase work_records request failed:', error && (error.stack || error.message) || error)
  return send(res, 503, { ok: false, message: 'CloudBase 数据库暂时不可用，请检查云托管数据库权限和环境配置。' })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end() }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (url.pathname === '/api/session' && req.method === 'POST') {
    try { const input = await body(req); const supplied = Buffer.from(String(input.password || '')); const expected = Buffer.from(WEB_PASSWORD); if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(res, 401, { ok: false, message: '网页密码错误' }); const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : ''; return send(res, 200, { ok: true }, { 'Set-Cookie': `score_session=${makeSession()}; HttpOnly;${secure} SameSite=Lax; Max-Age=28800; Path=/` }) } catch (error) { return send(res, 400, { ok: false, message: error.message }) }
  }
  if (url.pathname.startsWith('/api/')) {
    if (!validSession(req)) return send(res, 401, { ok: false, message: '请先登录网页后台' })
    if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { ok: true })
    if (url.pathname === '/api/work-records' && req.method === 'GET') {
      const eventId = String(url.searchParams.get('eventId') || 'default').slice(0, 100); const stage = String(url.searchParams.get('stage') || '').toUpperCase()
      if (!/^SS[1-9]$/.test(stage)) return send(res, 400, { ok: false, message: '赛段无效' })
      try {
        const record = cloudStore.enabled ? await cloudStore.get(eventId, stage) : (readData()[key(eventId, stage)] || { rows: [] })
        return send(res, 200, { ok: true, ...record })
      } catch (error) { return cloudError(res, error) }
    }
    if (url.pathname === '/api/work-records' && req.method === 'PUT') {
      try { const input = await body(req); const eventId = String(input.eventId || 'default').slice(0, 100); const stage = String(input.stage || '').toUpperCase(); if (!/^SS[1-9]$/.test(stage) || !Array.isArray(input.rows)) return send(res, 400, { ok: false, message: '赛事、赛段或成绩格式无效' }); const rows = input.rows.slice(0, 1000); const record = { rows, updatedAt: new Date().toISOString(), updatedByPhone: '网页管理员' }; if (cloudStore.enabled) await cloudStore.put(eventId, stage, rows); else { const data = readData(); data[key(eventId, stage)] = record; writeData(data) } return send(res, 200, { ok: true, count: rows.length }) } catch (error) { if (cloudStore.enabled) return cloudError(res, error); return send(res, 400, { ok: false, message: error.message }) }
    }
    return send(res, 404, { ok: false, message: '接口不存在' })
  }
  serve(res, url.pathname)
})
server.listen(PORT, HOST, () => console.log(`成绩审核网页已启动，监听 ${HOST}:${PORT}；数据存储：${cloudStore.enabled ? `CloudBase ${cloudStore.env}` : '本机 JSON 文件'}`))
