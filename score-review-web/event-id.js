'use strict'

// The independently deployed account/web-api cloud functions use this same rule.
function validateEventId(value) {
  if (typeof value !== 'string') throw new Error('赛事 ID 必须是 1 到 80 位字母、数字、下划线或连字符')
  const eventId = value.trim()
  if (!eventId || eventId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(eventId)) {
    throw new Error('赛事 ID 必须是 1 到 80 位字母、数字、下划线或连字符')
  }
  return eventId
}

function isValidEventId(value) {
  try { validateEventId(value); return true } catch { return false }
}

module.exports = { validateEventId, isValidEventId }
