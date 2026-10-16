function createAutoRefreshController(options = {}) {
  const refresh = typeof options.refresh === 'function' ? options.refresh : () => false
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true
  const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false
  const documentRef = options.documentRef || (typeof document !== 'undefined' ? document : null)
  const windowRef = options.windowRef || (typeof window !== 'undefined' ? window : null)
  const setTimeoutFn = options.setTimeoutFn || setTimeout
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout
  const intervalMs = Math.max(1000, Number(options.intervalMs) || 15000)
  const failureDelayMs = Math.max(1000, Number(options.failureDelayMs) || 30000)
  const maxFailureDelayMs = Math.max(failureDelayMs, Number(options.maxFailureDelayMs) || 60000)
  let timer = null
  let running = null
  let stopped = true
  let bound = false
  let failureCount = 0
  const visible = () => documentRef?.visibilityState !== 'hidden'
  const online = () => windowRef?.navigator?.onLine !== false
  const enabled = () => { try { return Boolean(isEnabled()) } catch { return false } }
  const busy = () => { try { return Boolean(isBusy()) } catch { return true } }
  const eligible = () => !stopped && visible() && online() && enabled()
  const clear = () => { if (timer !== null) clearTimeoutFn(timer); timer = null }
  const nextFailureDelay = () => Math.min(maxFailureDelayMs, failureDelayMs * (2 ** Math.max(0, failureCount - 1)))
  const schedule = delay => { clear(); if (!eligible()) return; timer = setTimeoutFn(() => { timer = null; void attempt().catch(() => {}) }, Math.max(0, Number(delay) || 0)) }
  const attempt = () => {
    if (running) return running
    if (!eligible()) return Promise.resolve(false)
    if (busy()) { schedule(intervalMs); return Promise.resolve(false) }
    running = Promise.resolve().then(() => refresh()).then(result => {
      failureCount = 0
      return result === true || result === false ? result : false
    }).catch(error => { failureCount += 1; throw error }).finally(() => {
      const failed = failureCount > 0
      running = null
      if (eligible()) schedule(failed ? nextFailureDelay() : intervalMs)
    })
    return running
  }
  const onVisibilityChange = () => { if (!visible()) clear(); else void attempt().catch(() => {}) }
  const onOnline = () => { void attempt().catch(() => {}) }
  const onOffline = () => clear()
  const onFocus = () => { void attempt().catch(() => {}) }
  const addListeners = () => {
    if (bound) return
    documentRef?.addEventListener('visibilitychange', onVisibilityChange)
    windowRef?.addEventListener('online', onOnline)
    windowRef?.addEventListener('offline', onOffline)
    windowRef?.addEventListener('focus', onFocus)
    bound = true
  }
  const removeListeners = () => {
    if (!bound) return
    documentRef?.removeEventListener('visibilitychange', onVisibilityChange)
    windowRef?.removeEventListener('online', onOnline)
    windowRef?.removeEventListener('offline', onOffline)
    windowRef?.removeEventListener('focus', onFocus)
    bound = false
  }
  return {
    start() { if (stopped) { stopped = false; addListeners() } return attempt() },
    stop() { stopped = true; clear(); removeListeners() },
    bind() { addListeners(); return this },
    trigger() { return attempt() },
    get running() { return Boolean(running) },
    get scheduled() { return timer !== null }
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createAutoRefreshController }
if (typeof window !== 'undefined') window.createAutoRefreshController = createAutoRefreshController
