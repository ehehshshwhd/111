const auth = require('../../../utils/auth')
const container = require('../../../utils/cloud-container')
const { ALL_STAGES } = require('../../../utils/stages')
const { convertGroupedPrizeTables, normalizePrizeTableColors, normalizePrizeTitleColors, repairPrizeTableColspans } = require('../../../utils/prize-table')

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

function normalizeDetailPageHtml(value) {
  const sanitized = String(value == null ? '' : value)
    .slice(0, 300000)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(\s(?:href|src)\s*=\s*["'])\s*javascript:[^"']*(["'])/gi, '$1$2')
  return normalizeDetailPageTextStyles(convertResponsiveDetailTables(convertGroupedPrizeTables(repairPrizeTableColspans(normalizePrizeTitleColors(sanitized)))))
}

function convertResponsiveDetailTables(value) {
  const source = String(value || '')
  const tableToken = /<\/?table\b[^>]*>/gi
  const ranges = []
  let depth = 0
  let start = -1
  let match
  while ((match = tableToken.exec(source))) {
    if (/^<table\b/i.test(match[0])) {
      if (depth === 0) start = match.index
      depth += 1
    } else if (depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        ranges.push([start, tableToken.lastIndex])
        start = -1
      }
    }
  }
  if (!ranges.length) return source
  let result = source
  ranges.reverse().forEach(([from, to]) => {
    const table = result.slice(from, to)
    const converted = convertResponsiveDetailTable(table)
    if (converted !== table) result = result.slice(0, from) + converted + result.slice(to)
  })
  return result
}

function convertResponsiveDetailTable(tableHtml) {
  const open = String(tableHtml).match(/^<table\b([^>]*)>/i)
  if (!open) return tableHtml
  const inner = String(tableHtml).slice(open[0].length).replace(/<\/table\s*>$/i, '')
  // Keep merged and nested tables on the native renderer; their geometry cannot
  // be represented by equal-width mobile cells without changing the content.
  if (/<table\b/i.test(inner) || /\b(?:rowspan|colspan)\s*=/i.test(inner)) return tableHtml
  const rows = [...inner.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr\s*>/gi)].map(match => ({
    attrs: match[1],
    cells: [...match[2].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)].map(cell => ({
      tag: cell[1].toLowerCase(), attrs: cell[2], content: cell[3],
    }))
  })).filter(row => row.cells.length)
  const columnCount = Math.max(0, ...rows.map(row => row.cells.length))
  if (columnCount < 2) return tableHtml
  const columnWeights = Array.from({ length: columnCount }, (_, cellIndex) => {
    const longestCell = Math.max(0, ...rows.map(row => {
      const cell = row.cells[cellIndex]
      return cell ? cell.content.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|#160);/gi, ' ').trim().length : 0
    }))
    return Math.min(8, Math.max(3, longestCell))
  })

  const captionMatch = inner.match(/<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i)
  const caption = captionMatch ? `<div class="detail-mobile-table-caption" style="display:block;width:100%;box-sizing:border-box;text-align:center;line-height:1.4;overflow-wrap:anywhere">${captionMatch[1]}</div>` : ''
  const markup = rows.map((row, rowIndex) => {
    const isHeader = rowIndex === 0 && (row.cells.some(cell => cell.tag === 'th') || /<thead\b/i.test(inner))
    const rowClass = `detail-mobile-table-row${isHeader ? ' detail-mobile-table-head' : ''}`
    const cells = Array.from({ length: columnCount }, (_, cellIndex) => row.cells[cellIndex] || { tag: 'td', attrs: '', content: '' }).map((cell, cellIndex) => {
      const cellClass = `detail-mobile-table-cell${isHeader ? ' detail-mobile-table-head-cell' : ''}`
      const attrs = responsiveDetailCellAttrs(cell.attrs, cellClass, isHeader, columnWeights[cellIndex])
      return `<div${attrs}>${normalizeResponsiveDetailCellHtml(cell.content)}</div>`
    }).join('')
    return `<div class="${rowClass}" style="display:flex;width:100%;max-width:100%;min-width:0;box-sizing:border-box">${cells}</div>`
  }).join('')
  return `<div class="detail-mobile-table" style="display:block;width:100%;max-width:100%;min-width:0;box-sizing:border-box;overflow:visible;font-size:11px;line-height:1.35">${caption}${markup}</div>`
}

function normalizeResponsiveDetailCellHtml(value) {
  return String(value || '').replace(/<([a-z][\w:-]*)\b([^>]*)>/gi, (tag, name, rawAttrs) => {
    let attrs = rawAttrs
      .replace(/\s+(?:width|height|data-colwidth|nowrap)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
    const styleMatch = attrs.match(/\sstyle\s*=\s*(["'])(.*?)\1/i)
    if (!styleMatch) return `<${name}${attrs}>`
    const style = styleMatch[2]
      .replace(/(^|;)\s*(?:width|min-width|max-width|height|min-height|max-height)\s*:[^;]*/gi, '$1')
      .replace(/(^|;)\s*white-space\s*:\s*nowrap\b[^;]*/gi, '$1white-space:normal')
      .replace(/;{2,}/g, ';')
      .replace(/^;|;$/g, '')
    return `<${name}${attrs.replace(styleMatch[0], style ? ` style="${style}"` : '')}>`
  })
}

function responsiveDetailCellAttrs(rawAttrs, className, isHeader, columnWeight) {
  let attrs = String(rawAttrs || '')
    .replace(/\s+(?:width|height|data-colwidth|nowrap|colspan|rowspan)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
  const classMatch = attrs.match(/\sclass\s*=\s*(["'])(.*?)\1/i)
  if (classMatch) attrs = attrs.replace(classMatch[0], ` class="${classMatch[2]} ${className}"`)
  else attrs += ` class="${className}"`
  const styleMatch = attrs.match(/\sstyle\s*=\s*(["'])(.*?)\1/i)
  let style = styleMatch ? styleMatch[2] : ''
  style = style
    .replace(/(^|;)\s*(?:width|min-width|max-width|height|min-height|max-height|white-space)\s*:[^;]*/gi, '$1')
    .replace(/;{2,}/g, ';')
    .replace(/^;|;$/g, '')
  const defaults = [
    'display:flex', `flex:${columnWeight} 1 0`, 'min-width:0', 'box-sizing:border-box',
    'align-items:center', 'justify-content:center', 'padding:6px 2px',
    'text-align:center', 'white-space:normal', 'word-break:break-all',
    'overflow-wrap:anywhere', 'line-height:1.35', 'border:1px solid #e6e6e6'
  ]
  if (isHeader) defaults.push('font-weight:700')
  const has = property => new RegExp(`(?:^|;)\\s*${property}\\s*:`, 'i').test(style)
  defaults.forEach(item => {
    const property = item.slice(0, item.indexOf(':'))
    if (!has(property)) style += `${style ? ';' : ''}${item}`
  })
  if (styleMatch) return attrs.replace(styleMatch[0], ` style="${style}"`)
  return `${attrs} style="${style}"`
}

function normalizeDetailPageTextStyles(html) {
  let tableDepth = 0
  return String(html || '').replace(/<(\/?)([a-z][\w:-]*)\b([^>]*)>/gi, (tag, closing, name, attrs) => {
    const element = name.toLowerCase()
    if (closing) {
      if (element === 'table') tableDepth = Math.max(0, tableDepth - 1)
      return tag
    }
    if (element === 'table') tableDepth += 1
    const tableElement = tableDepth > 0 && /^(table|colgroup|col|thead|tbody|tfoot|tr|th|td)$/.test(element)
    if (tableElement) {
      tag = tag.replace(/\s+(?:width|height|data-colwidth|nowrap)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|\/?>)/gi, '')
      attrs = tag.slice(name.length + 1, -1)
    }
    const classMatch = attrs.match(/\bclass\s*=\s*(["'])(.*?)\1/i)
    const classes = classMatch ? classMatch[2].split(/\s+/) : []
    const alignClass = classes.find(item => /^content-align-(left|center|right|justify)$/.test(item))
    const styleMatch = attrs.match(/\sstyle\s*=\s*(["'])(.*?)\1/i)
    let style = styleMatch ? styleMatch[2].trim().replace(/;?\s*$/, ';') : ''
    if (tableElement) {
      style = style.replace(/(^|;)\s*(?:min-width|height|min-height|max-height)\s*:[^;]*/gi, '$1')
      if (element !== 'table') style = style.replace(/(^|;)\s*(?:width|max-width)\s*:[^;]*(?=;|$)/gi, '$1')
    }
    if (tableDepth > 0) style = style.replace(/(white-space\s*:)\s*nowrap\b[^;]*/gi, '$1normal')
    const additions = []
    const has = property => new RegExp(`(?:^|;)\\s*${property}\\s*:`, 'i').test(style)
    const set = (property, value) => {
      if (has(property)) style = style.replace(new RegExp(`((?:^|;)\\s*${property}\\s*:)[^;]*`, 'gi'), `$1${value}`)
      else additions.push(`${property}:${value}`)
    }

    if (alignClass && !has('text-align')) additions.push(`text-align:${alignClass.slice('content-align-'.length)}`)
    if (classes.includes('content-bold') && !has('font-weight')) additions.push('font-weight:700')
    if (element === 'img') {
      if (!has('display')) additions.push('display:block')
      if (!has('width')) additions.push('width:100%')
      if (!has('max-width')) additions.push('max-width:100%')
      if (!has('height')) additions.push('height:auto')
      if (!has('object-fit')) additions.push('object-fit:contain')
      if (!has('border-radius')) additions.push('border-radius:2px')
      if (!has('margin')) additions.push('margin:0 0 18px')
    } else if (element === 'p') {
      if (!has('margin')) additions.push('margin:0 0 13px')
      if (!has('white-space')) additions.push('white-space:pre-wrap')
      if (!has('overflow-wrap')) additions.push('overflow-wrap:anywhere')
    } else if (/^h[1-4]$/.test(element)) {
      if (!has('margin')) additions.push('margin:18px 0 10px')
      if (!has('color')) additions.push('color:#222')
      if (!has('line-height')) additions.push('line-height:1.45')
      if (!has('white-space')) additions.push('white-space:pre-wrap')
      if (!has('overflow-wrap')) additions.push('overflow-wrap:anywhere')
    } else if (element === 'ul' || element === 'ol') {
      if (!has('margin')) additions.push('margin:0 0 14px')
      if (!has('padding-left')) additions.push('padding-left:22px')
    } else if (element === 'li') {
      if (!has('margin')) additions.push('margin:0 0 8px')
      if (!has('padding-left')) additions.push('padding-left:0')
    } else if (element === 'table') {
      set('width', '100%')
      set('max-width', '100%')
      set('table-layout', 'fixed')
      set('margin', '0')
      set('margin-left', '0')
      set('margin-right', '0')
      if (!has('border-collapse')) additions.push('border-collapse:collapse')
    } else if (element === 'th' || element === 'td') {
      set('padding', '5px 2px')
      set('white-space', 'normal')
      set('word-break', 'break-all')
      if (!has('border')) additions.push('border:1px solid #e6e6e6')
      if (!has('text-align')) additions.push('text-align:center')
      if (!has('line-height')) additions.push('line-height:1.35')
      if (!has('overflow-wrap')) additions.push('overflow-wrap:anywhere')
    }

    if (!additions.length && !tableDepth) return tag
    style += additions.join(';')
    if (tableDepth) style = style.split(';').map(item => item.trim()).filter(Boolean).join(';')
    if (!style) return styleMatch ? tag.replace(styleMatch[0], '') : tag
    if (styleMatch) return tag.replace(styleMatch[0], ` style=${styleMatch[1]}${style}${styleMatch[1]}`)
    return tag.replace(/\s*\/?>$/, ending => ` style="${style}"${ending}`)
  })
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
    const srcMatch = tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i)
    const miniSrcMatch = tag.match(/\bdata-mini-src\s*=\s*["']([^"']+)["']/i)
    const fileId = detailPageCloudFileId(dataIdMatch && dataIdMatch[1] || srcMatch && srcMatch[1])
    const sourceUrl = srcMatch && decodeDetailPageUrl(srcMatch[1])
    const miniUrl = miniSrcMatch && decodeDetailPageUrl(miniSrcMatch[1])
    const url = (fileId && urls && urls.get(fileId)) || miniUrl || (sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : '')
    if (!url) return tag
    // WeChat rich-text treats &amp; literally in image URLs instead of decoding
    // it like a browser HTML document, which invalidates signed CloudBase URLs.
    const escapedUrl = decodeDetailPageUrl(url).replace(/["<>]/g, char => ({ '"': '&quot;', '<': '&lt;', '>': '&gt;' }[char]))
    const withoutSrc = tag.replace(/\s+src\s*=\s*["'][^"']*["']/i, '').replace(/\s+data-file-id\s*=\s*["'][^"']*["']/i, '').replace(/\s+data-mini-src\s*=\s*["'][^"']*["']/i, '')
    return withoutSrc.replace(/\s*\/?>$/, '') + ` src="${escapedUrl}" />`
  })
}

function decodeDetailPageUrl(value) {
  return String(value || '').replace(/&amp;/gi, '&').replace(/&#(?:0*38|x0*26);/gi, '&')
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
  const parts = splitDetailPageResults(html)
  return {
    ...parts,
    html,
    segments: splitDetailPageImages(html),
    beforeSegments: splitDetailPageImages(parts.before),
    afterSegments: splitDetailPageImages(parts.after)
  }
}

function splitDetailPageImages(value) {
  const source = String(value || '')
  const tagPattern = /<img\b[^>]*>|<\/?[a-z][\w:-]*\b[^>]*>/gi
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
  const segments = []
  const stack = []
  let segmentStack = []
  let buffer = ''
  let cursor = 0

  const pushHtml = html => {
    if (!html) return
    const text = html.replace(/<[^>]*>/g, '').trim()
    if (!text && !/<(?:br|hr|img)\b/i.test(html)) return
    const closing = stack.slice().reverse().map(tag => `</${tag.name}>`).join('')
    segments.push({ type: 'html', html: `${segmentStack.map(tag => tag.source).join('')}${html}${closing}`, key: segments.length })
    segmentStack = stack.slice()
  }
  const updateStack = tag => {
    const closing = tag.match(/^<\/([a-z][\w:-]*)\b/i)
    if (closing) {
      const name = closing[1].toLowerCase()
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].name === name) { stack.length = index; break }
      }
      return
    }
    const opening = tag.match(/^<([a-z][\w:-]*)\b/i)
    if (!opening) return
    const name = opening[1].toLowerCase()
    if (!voidTags.has(name) && !/\/\s*>$/.test(tag)) stack.push({ name, source: tag })
  }

  let match
  while ((match = tagPattern.exec(source))) {
    buffer += source.slice(cursor, match.index)
    const tag = match[0]
    if (/^<img\b/i.test(tag) && !stack.some(item => /^(?:table|thead|tbody|tfoot|tr|td|th)$/.test(item.name))) {
      const srcMatch = tag.match(/\b(?:src|data-mini-src|data-file-id)\s*=\s*(["'])(.*?)\1/i)
      if (srcMatch && srcMatch[2]) {
        pushHtml(buffer)
        const altMatch = tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)
        segments.push({ type: 'image', src: decodeDetailPageUrl(srcMatch[2]), alt: altMatch ? altMatch[2] : '', key: segments.length })
        buffer = ''
        segmentStack = stack.slice()
      } else {
        buffer += tag
      }
    } else {
      buffer += tag
      updateStack(tag)
    }
    cursor = tagPattern.lastIndex
  }
  buffer += source.slice(cursor)
  pushHtml(buffer)
  if (!segments.length && source) segments.push({ type: 'html', html: source, key: 0 })
  return segments
}

function normalizeContentBlocks(value) {
  if (!Array.isArray(value)) return []
  if (value.length > 1000) throw new Error('赛事正文超过 1000 项，拒绝不完整显示')
  const supportedTypes = new Set(['heading', 'paragraph', 'text', 'note', 'image', 'banner', 'divider', 'list', 'table'])
  const normalizedBlocks = value.reduce((blocks, block, index) => {
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
      // The web editor may serialize verbose inline styles for a long but
      // otherwise valid paragraph. The API accepts rich HTML up to 500 KB;
      // silently cutting it at 30 KB can leave broken tags and flatten the
      // rest of the published article in wx:rich-text.
      html: typeof block.html === 'string' ? block.html.slice(0, 500000) : '',
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
    if (type === 'table') {
      Object.assign(normalized, normalizePrizeTableColors(normalized))
    }
    const stageImageHtml = !normalized.text.trim() && ['paragraph', 'text', 'note'].includes(type)
      ? String(block.html || '').match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']*stage-01(?:\.jpg)?(?:[?#][^"']*)?)["'][^>]*\/?>/i)
      : null
    if (stageImageHtml) {
      normalized.type = 'image'
      normalized.src = stageImageHtml[1]
      normalized.url = stageImageHtml[1]
      normalized.miniUrl = stageImageHtml[1]
      normalized.html = ''
    }
    if (type === 'banner') {
      normalized.theme = ['01', '02', '03'].includes(String(block.theme)) ? String(block.theme) : '01'
      normalized.number = String(block.number || '').slice(0, 20)
    }
    blocks.push(normalized)
    return blocks
  }, [])
  const introSeen = new Set()
  const dedupedBlocks = normalizedBlocks.filter(block => {
    if (!['paragraph', 'text'].includes(block.type)) return true
    const text = String(block.text || '').trim()
    const key = /^(前言|活动总称|活动主题)\s*[：:]/.test(text) ? text : ''
    if (!key) return true
    if (introSeen.has(key)) return false
    introSeen.add(key)
    return true
  })
  const hasStage01Image = dedupedBlocks.some(block => block.type === 'image' && /(?:^|\/)stage-01(?:\.jpg)?(?:[?#].*)?$/i.test(String(block.src || block.url || block.miniUrl || '')))
  const stageImage = hasStage01Image ? dedupedBlocks.find(block => block.type === 'image' && /(?:^|\/)stage-01(?:\.jpg)?(?:[?#].*)?$/i.test(String(block.src || block.url || block.miniUrl || ''))) : null
  const withoutStage01Banner = hasStage01Image ? dedupedBlocks.filter(block => !(block.type === 'banner' && block.theme === '01')) : dedupedBlocks
  if (stageImage) {
    const imageIndex = withoutStage01Banner.indexOf(stageImage)
    const themeIndex = withoutStage01Banner.findIndex(block => ['paragraph', 'text', 'note'].includes(block.type) && /活动主题\s*[：:]/.test(String(block.text || '')))
    if (imageIndex >= 0 && themeIndex >= 0) {
      withoutStage01Banner.splice(imageIndex, 1)
      const nextThemeIndex = withoutStage01Banner.findIndex(block => ['paragraph', 'text', 'note'].includes(block.type) && /活动主题\s*[：:]/.test(String(block.text || '')))
      withoutStage01Banner.splice(nextThemeIndex + 1, 0, stageImage)
    }
  }
  return withoutStage01Banner
}

function normalizeSignupOptions(value, registrationEnabled = false) {
  if (!Array.isArray(value)) return []
  if (value.length > 100) throw new Error('报名选项超过 100 项，拒绝不完整显示')
  if (value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('报名选项格式无效')
  return value.map(item => {
    const name = String(item.name || '').trim()
    const rawFee = String(item.fee ?? '0').trim().replace(/\/车\s*$/, '/辆')
    const feeAmount = rawFee ? (rawFee.startsWith('¥') || rawFee.startsWith('￥') ? rawFee.replace(/^￥/, '¥') : `¥ ${rawFee}`) : ''
    const configuredUnit = String(item.unit || '').trim()
    const feeUnit = configuredUnit === '车' ? '辆' : configuredUnit || (/(?:场地赛|攀爬赛|女子组|专业组|新秀组)/.test(name) ? '人' : '辆')
    const fee = feeAmount && !/\/[^/]+$/.test(feeAmount) ? `${feeAmount}/${feeUnit}` : feeAmount
    const note = String(item.note || '').trim()
    const registeredCount = Number.isFinite(Number(item.registeredCount)) && Number(item.registeredCount) >= 0 ? Math.floor(Number(item.registeredCount)) : 0
    const countNote = registrationEnabled === true ? `（已报${registeredCount}${feeUnit}）` : ''
    return {
      ...item,
      displayText: `${name}${fee ? ` ${fee}` : ''}${countNote}${note && !/^已报\s*\d+/.test(note) ? `（${note}）` : ''}`
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
      detailPageBeforeHtml: '', detailPageAfterHtml: '', detailPageSegments: [], detailPageBeforeSegments: [], detailPageAfterSegments: [],
      detailPageHasResultsAction: false, detailPageResultsLabel: ''
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
  loadPublishedEvent(id, silent) {
    if (this._eventLoading) return this._eventLoading
    const requestId = (this._eventRequestId || 0) + 1
    this._eventRequestId = requestId
    if (!silent) this.safeSetData({ eventConfigError: '', eventCloudReady: false, canAccessWork: false })
    this._eventLoading = container.call('/api/public/events').then(readEventList).then(events => {
      if (this.__unloaded || this._eventRequestId !== requestId) return
      const record = events.find(item => String(item && (item.id || item._id) || '') === String(id))
      if (!record) {
        // A successful cloud response is authoritative. Do not resurrect the
        // built-in suiping page after an administrator unpublishes/deletes it.
        // The old page remains available only when the network request itself
        // fails (see catch below), so an offline user can still view cached UI.
        this.safeSetData({
          event: { id: String(id), title: '', date: '', location: '', status: '', signup: [], signupOptions: [], contentBlocks: [], registrationEnabled: false },
          registrationPanel: '',
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
        detailPageSegments: detailPage.segments,
        detailPageBeforeSegments: detailPage.beforeSegments,
        detailPageAfterSegments: detailPage.afterSegments,
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
        signupOptions: normalizeSignupOptions(record.signupOptions, record.registrationEnabled),
        registrationEnabled: record.registrationEnabled === true,
        workBackendEnabled: record.workBackendEnabled !== false,
        groups: Array.isArray(record.groups) ? record.groups : [],
        visibleGroups: Array.isArray(record.visibleGroups) ? record.visibleGroups : [],
        groupStageNames: record.groupStageNames && typeof record.groupStageNames === 'object' && !Array.isArray(record.groupStageNames) ? record.groupStageNames : {},
        stageNames: Array.isArray(record.stageNames) ? record.stageNames : [],
        scoringType: 'rally',
        rankingMode: 'total',
        coverFileId: String(record.coverFileId || ''),
        coverUrl: String(record.coverUrl || ''),
        publishedAt: record.publishedAt || null,
        isDynamic: true,
        isGeneric: true
      }
      if (publishedEvent.id === 'suiping') this.safeSetData({ detailReady: false })
      this.safeSetData({ eventConfigReady: true, eventCloudReady: true, eventConfigError: '' })
      if (!publishedEvent.registrationEnabled) this.safeSetData({ registrationPanel: '' })
      if (!publishedEvent.workBackendEnabled) this.safeSetData({ canAccessWork: false })
      // Publish the full record before resolving temporary image URLs. The
      // cover and body image requests can finish in either order.
      this.safeSetData({ event: publishedEvent })
      this.resolveEventCover(publishedEvent)
      this.resolveEventContentImages(publishedEvent)
      this.resolveEventDetailPageImages(publishedEvent)
      this.loadWorkAccess()
    }).catch(error => {
      if (this.__unloaded || this._eventRequestId !== requestId) return
      this.safeSetData({ eventCloudReady: false, canAccessWork: false, registrationPanel: '' })
      // Legacy detail content can remain visible offline, but work access
      // stays closed until the current cloud event has been verified.
      console.warn('读取赛事详情失败，继续显示内置内容', error)
      if (String(id) === 'suiping') {
        this.safeSetData({ eventConfigReady: true, eventConfigError: '云端赛事读取失败，当前显示的是小程序内置旧版内容。请重试确认最新赛事数据。' })
        this.loadWorkAccess()
      } else {
        this.safeSetData({ eventConfigReady: true, eventConfigError: '赛事详情读取失败，请检查网络后重试。' })
      }
    }).finally(() => { this._eventLoading = null })
    return this._eventLoading
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
        rankingMode: 'total',
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
        detailPageSegments: detailPage.segments,
        detailPageBeforeSegments: detailPage.beforeSegments,
        detailPageAfterSegments: detailPage.afterSegments,
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
    this._detailVisible = true
    if (!normalizeEventId(this.data.id)) return
    this.refreshPublishedEvent()
  },
  refreshPublishedEvent() {
    if (!this._detailVisible || this.__unloaded) return
    if (this._publicationTimer) clearTimeout(this._publicationTimer)
    return this.loadPublishedEvent(this.data.id, true).finally(() => {
      if (this._publicationTimer) clearTimeout(this._publicationTimer)
      if (this._detailVisible && !this.__unloaded) this._publicationTimer = setTimeout(() => this.refreshPublishedEvent(), 10000)
    })
  },
  onHide() {
    this._detailVisible = false
    if (this._publicationTimer) clearTimeout(this._publicationTimer)
    this._publicationTimer = null
  },
  async openRegistration() {
    if (!this.data.eventCloudReady || !this.data.event || this.data.event.registrationEnabled !== true) return
    if (!auth.getUser()) { wx.navigateTo({ url: '/pages/login/login?from=profile' }); return }
    const options = (this.data.event.signupOptions || []).filter(option => option.registrationEnabled !== false)
    if (!options.length) { wx.showToast({ title: '暂无开放报名的组别', icon: 'none' }); return }
    this._registrationRequestId = this._registrationRequestId || ('signup_'+Date.now()+'_'+Math.random().toString(36).slice(2,14))
    this.safeSetData({ registrationPanel: 'form', registrationError: '', registrationRole: 'driver', registrationGroups: options.map(option=>option.name), registrationForm: this.data.registrationForm || { 组别: options[0].name }, registrationFields: ['姓名','赛号','车队','车型','排量','颜色','身份证','手机号','血型','国籍'], navigatorFields: ['领航员姓名','领航员身份证','领航员手机号','领航员血型','领航员国籍'] })
    try {
      const result = await this.callRegistration('getRegistrationProfiles')
      this.safeSetData({ registrationProfiles: result.profiles || [], registrationProfileNames: (result.profiles || []).map(row=>row.姓名+' / '+(row.赛号 || '未填车号')) })
    } catch (error) { this.safeSetData({ registrationError: error.message }) }
  },
  callRegistration(action, data) {
    return this.callInteraction(action, data).then(result=>{
      if (String(result.eventId || '') !== String(this.data.id)) throw new Error('报名响应赛事不一致，请重试')
      return result
    })
  },
  changeRegistrationField(event) {
    const field = event.currentTarget.dataset.field
    const allowed = [...(this.data.registrationFields || []), ...(this.data.navigatorFields || [])]
    if (!allowed.includes(field)) return
    this.safeSetData({ registrationForm: { ...this.data.registrationForm, [field]: event.detail.value } })
  },
  changeRegistrationGroup(event) {
    const group = (this.data.registrationGroups || [])[Number(event.detail.value)]
    if (group) this.safeSetData({ registrationForm: { ...this.data.registrationForm, 组别: group } })
  },
  changeRegistrationRole(event) { this.safeSetData({ registrationRole: event.currentTarget.dataset.role }) },
  chooseRegistrationProfile(event) {
    const profile = (this.data.registrationProfiles || [])[Number(event.detail.value)]
    if (profile) this.safeSetData({ registrationForm: { ...this.data.registrationForm, ...profile } })
  },
  closeRegistration() { if (!this.data.registrationSubmitting) this.safeSetData({ registrationPanel: '' }) },
  async openSignupList() {
    if (!this.data.eventCloudReady || !this.data.event || this.data.event.registrationEnabled !== true) return
    this.safeSetData({ registrationPanel: 'list', registrationError: '', registrationListLoading: true })
    try {
      const result = await this.callRegistration('listRegistrations')
      this.safeSetData({ registrationRows: result.rows || [] })
    } catch (error) { this.safeSetData({ registrationError: error.message }) }
    finally { this.safeSetData({ registrationListLoading: false }) }
  },
  async submitRegistration() {
    if (this.data.registrationSubmitting || this.data.registrationPanel !== 'form') return
    this.safeSetData({ registrationSubmitting: true, registrationError: '' })
    try {
      await this.callRegistration('submitRegistration', { form: this.data.registrationForm, requestId: this._registrationRequestId })
      this._registrationRequestId = null
      this.safeSetData({ registrationForm: null })
      wx.showToast({ title: '报名成功', icon: 'success' })
      await this.openSignupList()
    } catch (error) { this.safeSetData({ registrationError: error.message || '报名失败，请重试' }) }
    finally { this.safeSetData({ registrationSubmitting: false }) }
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
    // 每次打开成绩详情都重新读取一次：外部网站刚发布的成绩不需要退出重进页面就能看到。
    // 已有的分组先保留显示，读取完成后再替换，避免面板闪一下空白。
    const eventId = this.data.id || (this.data.event && this.data.event.id)
    if (eventId) this.loadPublishedResults(eventId)
  },
  previewDetailImage(event) {
    const current = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.src || '').trim()
    if (!current) return
    const eventData = this.data.event || {}
    const urls = [
      ...(Array.isArray(eventData.detailPageBeforeSegments) ? eventData.detailPageBeforeSegments : []),
      ...(Array.isArray(eventData.detailPageSegments) ? eventData.detailPageSegments : []),
      ...(Array.isArray(eventData.detailPageAfterSegments) ? eventData.detailPageAfterSegments : [])
    ].filter(item => item && item.type === 'image' && item.src).map(item => String(item.src))
    wx.previewImage({ current, urls: [...new Set([current, ...urls])] })
  },
  previewStandaloneImage(event) {
    const current = String(event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.src || '').trim()
    if (current) wx.previewImage({ current, urls: [current] })
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
    const isTotal = stageName === '总成绩'
    const stageNames = isTotal ? group.stages.filter(name => name !== '总成绩') : [stageName]
    const rankOfRow = row => {
      if (isTotal) return row.rank
      // 赛段视图用该赛段的组别名次；老数据没有 stageRanks 时退回总名次
      if (row.stageRanks && typeof row.stageRanks === 'object') return row.stageRanks[stageName]
      return row.rank
    }
    const groupRows = snapshot ? snapshot.rows.filter(row => String(row && row.group || '') === group.name) : []
    // 分组内按名次从 1 往下排，没有名次的排最后
    const rows = isTotal ? groupRows : groupRows.slice().sort((left, right) => {
      const a = Number(rankOfRow(left))
      const b = Number(rankOfRow(right))
      const av = Number.isFinite(a) && a > 0 ? a : Infinity
      const bv = Number.isFinite(b) && b > 0 ? b : Infinity
      return av - bv
    })
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
      const primaryStage = stageValues.find(item => item.name === stageName) || stageValues[0] || {}
      const rankValue = rankOfRow(row)
      return {
        id: String(row.id || row.carNumber || Math.random()),
        carNumber: String(row.carNumber || ''),
        group: String(row.group || ''),
        driver: String(row.driver || row.driverName || row.name || ''),
        coDriver: String(row.coDriver || row.navigator || row.coDriverName || ''),
        rank: rankValue === undefined || rankValue === null || rankValue === '' ? '' : String(rankValue),
        stageValues,
        validScore: this.displayScoreValue(row.validScore || (row.totalScore)),
        selectedDuration: isTotal ? '' : this.displayScoreValue(row.stageTimes && row.stageTimes[stageName] && row.stageTimes[stageName].duration),
        // 新卡片版式：赛段用时 / 罚时 / 本赛段成绩（总成绩视图下显示总成绩）
        cardStageTime: isTotal ? '' : (primaryStage.duration || ''),
        cardPenalty: isTotal ? '' : (primaryStage.penalty || ''),
        cardFinal: isTotal
          ? this.displayScoreValue(row.validScore || (row.totalScore))
          : (primaryStage.duration || '')
      }
    })
    wx.setNavigationBarTitle({ title: '成绩表' })
    this.setData({
      scoreViewVisible: true,
      selectedScore: {
        groupName: group.name,
        stageName,
        isTotal,
        rankingMode: 'total',
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
    this.onHide()
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
    const openGroupRows = [
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
    ]
    const openGroupSubtotals = ['小计：48000元','小计：48000元','小计：48000元','小计：48000元']
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
        rows: openGroupRows,
        groups: ['公开A组', '公开B组', '公开C组', '公开D组'].map((name, groupIndex) => ({
          name,
          subtotal: openGroupSubtotals[groupIndex]
        }))
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
