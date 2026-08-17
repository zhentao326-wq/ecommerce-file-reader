'use strict'

// ============================================================================
// ecommerce-file-reader — 纯 JavaScript 解析库（无任何运行时依赖）
// 支持: 图片(jpg/jpeg/png/webp) / Excel(xlsx/xls) / CSV / PDF / TXT / MD
// 运行环境: 普通 Node.js 或 DeepSeek Harness 动态插件沙箱
//   （只依赖 TextDecoder/TextEncoder/Uint8Array/DataView 等标准能力）
// 用法(独立): node reader.js <文件路径>
// ============================================================================

// ---------------------------------------------------------------------------
// 编码工具
// ---------------------------------------------------------------------------
function detectEncoding(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch (e) { /* 不是合法 UTF-8 */ }
  try {
    new TextDecoder('gb18030', { fatal: true }).decode(bytes)
    return 'gb18030'
  } catch (e) { /* 不是合法 GBK */ }
  return 'latin1'
}

function latin1Decode(bytes) {
  // 手动 Latin-1 解码（不依赖 TextDecoder 标签，保证沙箱可用）
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    const end = Math.min(i + 8192, bytes.length)
    let part = ''
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j])
    s += part
  }
  return s
}

function decodeText(bytes, label) {
  if (label === 'latin1' || label === 'iso-8859-1') return latin1Decode(bytes)
  try {
    return new TextDecoder(label).decode(bytes)
  } catch (e) {
    return latin1Decode(bytes)
  }
}

// ---------------------------------------------------------------------------
// 字节工具
// ---------------------------------------------------------------------------
function u16(b, off) {
  return (b[off] | (b[off + 1] << 8)) & 0xFFFF
}

function u32(b, off) {
  return ((b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0)
}

function readDouble(b, off) {
  return new DataView(b.buffer, b.byteOffset + off, 8).getFloat64(0, true)
}

function strToBytes(s) {
  const a = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xFF
  return a
}

// ---------------------------------------------------------------------------
// DEFLATE 解压（RFC 1951）— 纯 JS 实现，用于 xlsx(zip)/pdf/flate 流
// ---------------------------------------------------------------------------
function inflate(bytes) {
  const out = []
  let bitBuf = 0
  let bitCnt = 0
  let pos = 0

  function readBits(n) {
    while (bitCnt < n) {
      if (pos >= bytes.length) throw new Error('inflate: 输入意外结束')
      bitBuf |= bytes[pos++] << bitCnt
      bitCnt += 8
    }
    const v = bitBuf & ((1 << n) - 1)
    bitBuf >>>= n
    bitCnt -= n
    return v
  }

  function buildHuffman(lengths) {
    const maxLen = 15
    const count = new Array(maxLen + 1).fill(0)
    for (let i = 0; i < lengths.length; i++) count[lengths[i]]++
    count[0] = 0
    let code = 0
    const nextCode = new Array(maxLen + 1).fill(0)
    for (let bits = 1; bits <= maxLen; bits++) {
      code = (code + count[bits - 1]) << 1
      nextCode[bits] = code
    }
    const table = new Array(1 << maxLen)
    for (let i = 0; i < lengths.length; i++) {
      const len = lengths[i]
      if (len === 0) continue
      let c = nextCode[len]++
      const shift = maxLen - len
      const base = c << shift
      for (let j = 0; j < (1 << shift); j++) table[base | j] = { len, sym: i }
    }
    return table
  }

  function decodeSym(table) {
    let code = 0
    for (let i = 0; i < 15; i++) {
      code = (code << 1) | readBits(1)
      const e = table[code << (15 - (i + 1))]
      if (e !== undefined && e.len === i + 1) return e.sym
    }
    throw new Error('inflate: 无效的 Huffman 编码')
  }

  const CODELEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
  const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
  const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

  function fixedLengths() {
    const lengths = new Array(288)
    for (let i = 0; i <= 143; i++) lengths[i] = 8
    for (let i = 144; i <= 255; i++) lengths[i] = 9
    for (let i = 256; i <= 279; i++) lengths[i] = 7
    for (let i = 280; i <= 287; i++) lengths[i] = 8
    return lengths
  }
  const fixedLit = buildHuffman(fixedLengths())
  const fixedDist = buildHuffman(new Array(30).fill(5))

  function decodeBlock() {
    for (;;) {
      const sym = decodeSym(literal)
      if (sym === 256) break
      if (sym < 256) {
        out.push(sym)
      } else {
        const li = sym - 257
        if (li > 28) throw new Error('inflate: 无效的长度码')
        const length = LENGTH_BASE[li] + readBits(LENGTH_EXTRA[li])
        const di = decodeSym(dist)
        if (di > 29) throw new Error('inflate: 无效的距离码')
        const distance = DIST_BASE[di] + readBits(DIST_EXTRA[di])
        if (distance > out.length) throw new Error('inflate: 距离超出输出范围')
        for (let i = 0; i < length; i++) out.push(out[out.length - distance])
      }
    }
  }

  let literal = fixedLit
  let dist = fixedDist
  let bfinal = 0
  do {
    bfinal = readBits(1)
    const btype = readBits(2)
    if (btype === 0) {
      // stored block: 按字节对齐
      bitBuf = 0
      bitCnt = 0
      if (pos + 4 > bytes.length) throw new Error('inflate: 存储块数据不足')
      const len = bytes[pos] | (bytes[pos + 1] << 8)
      const nlen = bytes[pos + 2] | (bytes[pos + 3] << 8)
      pos += 4
      if ((len ^ 0xFFFF) !== nlen) throw new Error('inflate: 存储块长度校验失败')
      for (let i = 0; i < len; i++) {
        if (pos >= bytes.length) throw new Error('inflate: 输入意外结束')
        out.push(bytes[pos++])
      }
    } else if (btype === 1) {
      literal = fixedLit
      dist = fixedDist
      decodeBlock()
    } else if (btype === 2) {
      const hlit = readBits(5) + 257
      const hdist = readBits(5) + 1
      const hclen = readBits(4) + 4
      const clLengths = new Array(19).fill(0)
      for (let i = 0; i < hclen; i++) clLengths[CODELEN_ORDER[i]] = readBits(3)
      const clTable = buildHuffman(clLengths)
      const all = new Array(hlit + hdist).fill(0)
      let i = 0
      while (i < hlit + hdist) {
        const sym = decodeSym(clTable)
        if (sym < 16) {
          all[i++] = sym
        } else if (sym === 16) {
          if (i === 0) throw new Error('inflate: 重复码位置错误')
          const prev = all[i - 1]
          const rep = 3 + readBits(2)
          for (let k = 0; k < rep; k++) all[i++] = prev
        } else if (sym === 17) {
          i += 3 + readBits(3)
        } else {
          i += 11 + readBits(7)
        }
        if (i > hlit + hdist) throw new Error('inflate: 码长过多')
      }
      literal = buildHuffman(all.slice(0, hlit))
      dist = buildHuffman(all.slice(hlit))
      decodeBlock()
    } else {
      throw new Error('inflate: 无效的块类型')
    }
  } while (!bfinal)

  return new Uint8Array(out)
}

// zlib 包装（RFC 1950）：跳过 2 字节头 + 4 字节 Adler-32
function inflateZlib(bytes) {
  const hasZlibHeader =
    bytes.length >= 2 &&
    (bytes[0] & 0x0F) === 8 &&
    (((bytes[0] << 8) | bytes[1]) % 31 === 0)
  if (hasZlibHeader) {
    const end = bytes.length >= 6 ? bytes.length - 4 : bytes.length
    return inflate(bytes.slice(2, end))
  }
  return inflate(bytes)
}

// ---------------------------------------------------------------------------
// ZIP 解析（用于 xlsx）
// ---------------------------------------------------------------------------
function zipEntries(bytes) {
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到结束记录）')
  const totalEntries = u16(bytes, eocd + 10)
  const cdOffset = u32(bytes, eocd + 16)
  const entries = []
  let p = cdOffset
  for (let n = 0; n < totalEntries && p + 46 <= bytes.length; n++) {
    if (!(bytes[p] === 0x50 && bytes[p + 1] === 0x4B && bytes[p + 2] === 0x01 && bytes[p + 3] === 0x02)) break
    const method = u16(bytes, p + 10)
    const compSize = u32(bytes, p + 20)
    const nameLen = u16(bytes, p + 28)
    const extraLen = u16(bytes, p + 30)
    const commentLen = u16(bytes, p + 32)
    const localOffset = u32(bytes, p + 42)
    const nameBytes = bytes.slice(p + 46, p + 46 + nameLen)
    let name = ''
    try {
      name = decodeText(nameBytes, 'utf-8')
    } catch (e) {
      name = decodeText(nameBytes, 'latin1')
    }
    let data = new Uint8Array(0)
    if (localOffset + 30 <= bytes.length &&
        bytes[localOffset] === 0x50 && bytes[localOffset + 1] === 0x4B &&
        bytes[localOffset + 2] === 0x03 && bytes[localOffset + 3] === 0x04) {
      const lNameLen = u16(bytes, localOffset + 26)
      const lExtraLen = u16(bytes, localOffset + 28)
      const dataStart = localOffset + 30 + lNameLen + lExtraLen
      const comp = bytes.slice(dataStart, dataStart + compSize)
      if (method === 0) data = comp
      else if (method === 8) data = inflate(comp)
      else throw new Error('不支持的 ZIP 压缩方式: ' + method)
    }
    entries.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ---------------------------------------------------------------------------
// XML 简易工具（xlsx）
// ---------------------------------------------------------------------------
function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlChildren(inner, tag) {
  // 返回每个元素的内部内容（含自闭合元素，其内容为空字符串）
  const out = []
  const re = new RegExp('<' + tag + '\\b[^>]*?>([\\s\\S]*?)</' + tag + '>', 'g')
  let m
  while ((m = re.exec(inner))) out.push(m[1])
  const re2 = new RegExp('<' + tag + '\\b[^>]*?/>', 'g')
  while ((m = re2.exec(inner))) out.push('')
  return out
}

function xmlTags(inner, tag) {
  // 返回每个元素的完整开标签文本（含自闭合），供 getAttr 读取属性
  const out = []
  const re = new RegExp('<' + tag + '\\b[^>]*?/?>', 'g')
  let m
  while ((m = re.exec(inner))) out.push(m[0])
  return out
}

function getAttr(tagText, name) {
  const re = new RegExp('\\b' + name + '="([^"]*)"')
  const m = tagText.match(re)
  return m ? unescapeXml(m[1]) : undefined
}

function xmlTextOf(inner) {
  return xmlChildren(inner, 't').map(unescapeXml).join('')
}

// ---------------------------------------------------------------------------
// 图片解析: 仅解析头部，无需解压像素数据
// ---------------------------------------------------------------------------
function isSofMarker(m) {
  return m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC
}

function parseImage(bytes, ext) {
  const b = bytes
  // PNG
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
    return {
      format: 'PNG',
      width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0,
      height: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0
    }
  }
  // WebP (RIFF....WEBP)
  if (b.length >= 20 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    let p = 12
    while (p + 8 <= b.length) {
      const type = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3])
      const size = u32(b, p + 4)
      const pl = p + 8
      if (type === 'VP8 ' && size >= 10) {
        const w = (b[pl + 6] | (b[pl + 7] << 8)) & 0x3FFF
        const h = (b[pl + 8] | (b[pl + 9] << 8)) & 0x3FFF
        return { format: 'WEBP', width: w, height: h }
      }
      if (type === 'VP8L' && size >= 5 && b[pl] === 0x2F) {
        const w = 1 + (b[pl + 1] | ((b[pl + 2] & 0x3F) << 8))
        const h = 1 + (((b[pl + 2] >> 6) | (b[pl + 3] << 2) | ((b[pl + 4] & 0x0F) << 10)) & 0x3FFF)
        return { format: 'WEBP', width: w, height: h }
      }
      if (type === 'VP8X' && size >= 10) {
        const w = 1 + (b[pl + 4] | (b[pl + 5] << 8) | (b[pl + 6] << 16))
        const h = 1 + (b[pl + 8] | (b[pl + 9] << 8) | (b[pl + 10] << 16))
        return { format: 'WEBP', width: w, height: h }
      }
      p = pl + size + (size % 2)
    }
    throw new Error('未识别的 WebP 块')
  }
  // JPEG
  if (b.length >= 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let p = 2
    while (p + 4 <= b.length) {
      if (b[p] !== 0xFF) {
        p++
        continue
      }
      const marker = b[p + 1]
      if (marker === 0xD8 || marker === 0x01) {
        p += 2
        continue
      }
      if (marker >= 0xD0 && marker <= 0xD9) {
        p += 2
        continue
      }
      const len = (b[p + 2] << 8) | b[p + 3]
      if (len < 2) throw new Error('JPEG 标记长度异常')
      if (isSofMarker(marker)) {
        const h = (b[p + 5] << 8) | b[p + 6]
        const w = (b[p + 7] << 8) | b[p + 8]
        return { format: 'JPEG', width: w, height: h }
      }
      p += 2 + len
    }
    throw new Error('JPEG 中未找到 SOF 标记')
  }
  throw new Error('无法识别的图片格式: ' + ext)
}

// ---------------------------------------------------------------------------
// CSV 解析
// ---------------------------------------------------------------------------
function sniffDelimiter(text) {
  const line = (text.split(/\r?\n/).find(l => l.trim().length > 0) || '').trim()
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 }
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQ = !inQ
    else if (!inQ && counts[ch] !== undefined) counts[ch]++
  }
  let best = ','
  let bestN = 0
  for (const d in counts) {
    if (counts[d] > bestN) {
      bestN = counts[d]
      best = d
    }
  }
  return bestN > 0 ? best : ','
}

function parseCsvRows(text, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); rows.push(row); row = [] }
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field.length === 0) { inQuotes = true; i++; continue }
    if (ch === delimiter) { pushField(); i++; continue }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      pushRow()
      i++
      continue
    }
    if (ch === '\n') { pushRow(); i++; continue }
    field += ch
    i++
  }
  if (field.length > 0 || row.length > 0) pushRow()
  return rows.filter(r => r.some(c => String(c).trim() !== ''))
}

function parseCsv(bytes) {
  const enc = detectEncoding(bytes)
  const text = decodeText(bytes, enc)
  const delimiter = sniffDelimiter(text)
  const rows = parseCsvRows(text, delimiter)
  const fields = rows.length ? rows[0].map(String) : []
  const data = rows.slice(1)
  return {
    fields,
    total_rows: data.length,
    rows: data.slice(0, 100),
    encoding: enc,
    delimiter: delimiter === '\t' ? 'tab' : delimiter
  }
}

// ---------------------------------------------------------------------------
// 文本解析 (txt / md)
// ---------------------------------------------------------------------------
function parseText(bytes) {
  const enc = detectEncoding(bytes)
  let text = decodeText(bytes, enc)
  let truncated = false
  if (text.length > 100000) {
    text = text.slice(0, 100000)
    truncated = true
  }
  return { content: text, encoding: enc, truncated }
}

// ---------------------------------------------------------------------------
// XLSX 解析
// ---------------------------------------------------------------------------
function cellValue(attrs, content, sharedStrings) {
  const t = getAttr(attrs, 't')
  const vMatch = content.match(/<v>([\s\S]*?)<\/v>/)
  const isMatch = content.match(/<is>([\s\S]*?)<\/is>/)
  if (isMatch) return xmlTextOf(isMatch[1])
  const raw = vMatch ? vMatch[1] : ''
  if (t === 's') {
    const idx = parseInt(raw, 10)
    if (!isNaN(idx) && sharedStrings[idx] !== undefined) return sharedStrings[idx]
    return ''
  }
  if (t === 'inlineStr') return xmlTextOf(content)
  if (t === 'str') return unescapeXml(raw)
  if (t === 'b') return raw === '1'
  if (t === 'e') return '#ERROR'
  if (raw === '') return null
  const n = Number(raw)
  return isNaN(n) ? unescapeXml(raw) : n
}

function parseXlsxSheet(sheetName, sheetXml, sharedStrings) {
  const rowsXml = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let m
  while ((m = rowRe.exec(sheetXml))) rowsXml.push(m[1])
  const grid = rowsXml.map(inner => {
    const cells = []
    const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g
    let cm
    while ((cm = cellRe.exec(inner))) {
      cells.push(cellValue(cm[1], cm[3] !== undefined ? cm[3] : '', sharedStrings))
    }
    return cells
  })
  return buildSheetResult(sheetName, grid)
}

function buildSheetResult(sheetName, grid) {
  if (!grid.length) return { sheet_name: sheetName, fields: [], total_rows: 0, first_20_rows: [] }
  const fields = grid[0].map(v => v === null || v === undefined ? '' : String(v))
  const data = grid.slice(1).filter(r => r.some(v => v !== null && v !== undefined && String(v).trim() !== ''))
  return {
    sheet_name: sheetName,
    fields,
    total_rows: data.length,
    first_20_rows: data.slice(0, 20)
  }
}

function parseXlsx(bytes) {
  const entries = zipEntries(bytes)
  const map = {}
  for (const e of entries) map[e.name] = e.data
  const getText = name => (map[name] ? decodeText(map[name], 'utf-8') : '')

  // 共享字符串
  const sharedStrings = []
  const ssXml = getText('xl/sharedStrings.xml')
  if (ssXml) {
    for (const si of xmlChildren(ssXml, 'si')) sharedStrings.push(xmlTextOf(si))
  }

  // sheet 顺序与路径
  const wbXml = getText('xl/workbook.xml')
  const sheetTags = xmlTags(wbXml, 'sheet')
  const rels = {}
  const relsXml = getText('xl/_rels/workbook.xml.rels')
  if (relsXml) {
    for (const t of xmlTags(relsXml, 'Relationship')) {
      const id = getAttr(t, 'Id')
      const target = getAttr(t, 'Target')
      if (id && target) rels[id] = target.replace(/^\/+/, '')
    }
  }
  const sheetList = sheetTags.map((t, i) => {
    const name = getAttr(t, 'name') || ('Sheet' + (i + 1))
    const rid = getAttr(t, 'r:id')
    let path = (rid && rels[rid]) ? rels[rid] : ('xl/worksheets/sheet' + (i + 1) + '.xml')
    if (path.indexOf('xl/') !== 0) path = 'xl/' + path
    return { name, path }
  })

  const sheets = []
  for (const s of sheetList) {
    if (!map[s.path]) continue
    sheets.push(parseXlsxSheet(s.name, getText(s.path), sharedStrings))
  }
  return { sheets }
}

// ---------------------------------------------------------------------------
// PDF 解析
// ---------------------------------------------------------------------------
function countPdfPages(text) {
  let n = 0
  const re = /\/Type\s*\/Page\b/g
  let m
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index + m[0].length)
    if (!/^s/.test(rest)) n++
  }
  if (n === 0) {
    const cm = text.match(/\/Count\s+(\d+)/)
    if (cm) n = parseInt(cm[1], 10) || 0
  }
  return n
}

function unescapePdfString(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = s[++i]
    if (n === undefined) break
    if (n === 'n') out += '\n'
    else if (n === 'r') out += '\r'
    else if (n === 't') out += '\t'
    else if (n === 'b') out += '\b'
    else if (n === 'f') out += '\f'
    else if (n === '(' || n === ')' || n === '\\') out += n
    else if (n >= '0' && n <= '7') {
      let code = n.charCodeAt(0) - 48
      if (i + 1 < s.length && s[i + 1] >= '0' && s[i + 1] <= '7') code = code * 8 + (s.charCodeAt(++i) - 48)
      if (i + 1 < s.length && s[i + 1] >= '0' && s[i + 1] <= '7') code = code * 8 + (s.charCodeAt(++i) - 48)
      out += String.fromCharCode(code)
    } else if (n === '\r' || n === '\n') {
      if (n === '\r' && s[i + 1] === '\n') i++
    } else {
      out += n
    }
  }
  return out
}

function hexPdfString(s) {
  let out = ''
  let hex = ''
  for (const ch of s) {
    if (/[0-9a-fA-F]/.test(ch)) hex += ch
  }
  if (hex.length % 2 !== 0) hex += '0'
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
  }
  return out
}

function extractPdfText(content) {
  const parts = []
  const btRe = /BT\b([\s\S]*?)ET\b/g
  let m
  while ((m = btRe.exec(content))) {
    const block = m[1]
    const strRe = /\(((?:[^()\\\r\n]|\\.)*)\)|<([0-9a-fA-F\s]+)>/g
    let s
    while ((s = strRe.exec(block))) {
      if (s[1] !== undefined) parts.push(unescapePdfString(s[1]))
      else parts.push(hexPdfString(s[2]))
    }
  }
  return parts.join('')
}

function parsePdf(bytes) {
  const text = decodeText(bytes, 'latin1')
  const pageCount = countPdfPages(text)
  const pages = []
  const streamRe = /<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)endstream/g
  let m
  let totalChars = 0
  let truncated = false
  while ((m = streamRe.exec(text))) {
    const dict = m[1]
    const dataStr = m[2]
    let content = ''
    if (/FlateDecode/.test(dict)) {
      try {
        content = decodeText(inflateZlib(strToBytes(dataStr)), 'latin1')
      } catch (e) {
        content = ''
      }
    } else {
      content = dataStr
    }
    pages.push({ page: pages.length + 1, text: extractPdfText(content) })
    totalChars += pages[pages.length - 1].text.length
    if (totalChars >= 100000) {
      truncated = true
      break
    }
  }
  return { page_count: pageCount, pages, truncated }
}

// ---------------------------------------------------------------------------
// XLS (BIFF8 + OLE2 复合文档) 解析
// ---------------------------------------------------------------------------
function parseOle(bytes) {
  const b = bytes
  const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
  for (let i = 0; i < 8; i++) {
    if (b[i] !== sig[i]) throw new Error('不是有效的 .xls（OLE2 签名错误）')
  }
  const sectorShift = u16(b, 30)
  const sectorSize = 1 << sectorShift
  const miniShift = u16(b, 32)
  const miniSize = 1 << miniShift
  const numFat = u32(b, 44)
  const dirStart = u32(b, 48)
  const miniCutoff = u32(b, 56)
  const miniFatStart = u32(b, 60)
  const numMiniFat = u32(b, 64)
  const difatStart = u32(b, 68)
  const numDifat = u32(b, 72)
  const END = 0xFFFFFFFE
  const FREE = 0xFFFFFFFF
  const FATSECT = 0xFFFFFFFD

  // 收集 FAT 扇区号（DIFAT 链）
  const fatSectors = []
  for (let i = 0; i < 109; i++) {
    const s = u32(b, 76 + i * 4)
    if (s === FREE || s === END) break
    fatSectors.push(s)
  }
  let ds = difatStart
  let difatGuard = 0
  while (ds !== END && ds !== FREE && ds !== FATSECT && difatGuard++ < 1000) {
    const perSector = (sectorSize / 4) - 1
    const base = (ds + 1) * sectorSize
    for (let i = 0; i < perSector; i++) {
      const s = u32(b, base + i * 4)
      if (s === FREE || s === END) break
      fatSectors.push(s)
    }
    ds = u32(b, base + perSector * 4)
  }

  // 读取 FAT 表
  const fat = []
  for (const fs of fatSectors) {
    const base = (fs + 1) * sectorSize
    for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(b, base + i * 4))
  }

  const readChain = (start, table) => {
    const chain = []
    let s = start
    let guard = 0
    while (s !== END && s !== FREE && !chain.includes(s) && guard++ < 1000000) {
      chain.push(s)
      s = table[s]
      if (s === undefined) break
    }
    return chain
  }

  const readSectors = (chain, sz) => {
    const parts = []
    for (const s of chain) {
      const base = (s + 1) * sz
      if (base >= b.length) break
      parts.push(b.slice(base, Math.min(base + sz, b.length)))
    }
    let total = 0
    for (const p of parts) total += p.length
    const out = new Uint8Array(total)
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }

  // 目录
  const dirBytes = readSectors(readChain(dirStart, fat), sectorSize)
  const entries = []
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const nameLen = u16(dirBytes, o + 64)
    const type = dirBytes[o + 66]
    const left = u32(dirBytes, o + 68)
    const right = u32(dirBytes, o + 72)
    const child = u32(dirBytes, o + 76)
    const start = u32(dirBytes, o + 116)
    const size = u32(dirBytes, o + 120)
    let name = ''
    if (nameLen > 0 && nameLen <= 64) {
      name = decodeText(dirBytes.slice(o, o + nameLen), 'utf-16le').replace(/\u0000+$/, '')
    }
    entries.push({ name, type, left, right, child, start, size })
  }
  const root = entries.find(e => e.type === 5)
  if (!root) throw new Error('OLE2 缺少根目录项')

  // mini 流（根目录的流）
  const miniStream = readSectors(readChain(root.start, fat), sectorSize)

  // mini FAT
  const miniFatBytes = readSectors(readChain(miniFatStart, fat), sectorSize)
  const miniFat = []
  for (let i = 0; i < miniFatBytes.length / 4; i++) miniFat.push(u32(miniFatBytes, i * 4))

  const readMiniChain = start => readChain(start, miniFat)
  const readMiniStream = entry => {
    const chain = readMiniChain(entry.start)
    const parts = []
    for (const s of chain) {
      const base = s * miniSize
      if (base >= miniStream.length) break
      parts.push(miniStream.slice(base, Math.min(base + miniSize, miniStream.length)))
    }
    let total = 0
    for (const p of parts) total += p.length
    const out = new Uint8Array(total)
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }

  const readEntryStream = entry => {
    if (entry.size < miniCutoff) return readMiniStream(entry)
    return readSectors(readChain(entry.start, fat), sectorSize)
  }

  const findEntry = name => entries.find(e => e.name === name && (e.type === 2 || e.type === 5))

  return { findEntry, readEntryStream }
}

function readUnicodeString(data, off) {
  const cch = u16(data, off)
  const flags = data[off + 2]
  let p = off + 3
  const fHigh = flags & 0x01
  const fRich = flags & 0x08
  const fExt = flags & 0x04
  let nRuns = 0
  let extLen = 0
  if (fRich) {
    nRuns = u16(data, p)
    p += 2
  }
  if (fExt) {
    extLen = u32(data, p)
    p += 4
  }
  let chars = ''
  for (let i = 0; i < cch; i++) {
    if (fHigh) {
      chars += String.fromCharCode(u16(data, p))
      p += 2
    } else {
      chars += String.fromCharCode(data[p])
      p += 1
    }
  }
  p += nRuns * 4 + extLen
  return { text: chars, next: p }
}

function readShortUnicodeString(data, off, cch) {
  const fHigh = data[off] & 0x01
  let p = off + 1
  let chars = ''
  for (let i = 0; i < cch; i++) {
    if (fHigh) {
      chars += String.fromCharCode(u16(data, p))
      p += 2
    } else {
      chars += String.fromCharCode(data[p])
      p += 1
    }
  }
  return { text: chars, next: p }
}

function parseSst(records) {
  const strings = []
  const first = records[0]
  const unique = u16(first.data, 2)
  let ri = 0
  let off = 4
  let curData = first.data

  const readBytesInto = n => {
    const out = new Uint8Array(n)
    let got = 0
    while (got < n) {
      const av = curData.length - off
      if (av > 0) {
        const take = Math.min(av, n - got)
        out.set(curData.slice(off, off + take), got)
        off += take
        got += take
      } else {
        ri++
        if (ri >= records.length) throw new Error('SST: 记录不足')
        curData = records[ri].data
        off = 0
      }
    }
    return out
  }

  const skipBytes = n => {
    let left = n
    while (left > 0) {
      const av = curData.length - off
      if (av > 0) {
        const take = Math.min(av, left)
        off += take
        left -= take
      } else {
        ri++
        if (ri >= records.length) throw new Error('SST: 记录不足')
        curData = records[ri].data
        off = 0
      }
    }
  }

  const readString = () => {
    const cch = readBytesInto(2)
    const cchVal = cch[0] | (cch[1] << 8)
    const flags = readBytesInto(1)[0]
    const fHigh = (flags & 0x01) === 1
    const fRich = (flags & 0x08) === 8
    const fExt = (flags & 0x04) === 4
    let nRuns = 0
    let extLen = 0
    if (fRich) {
      const rb = readBytesInto(2)
      nRuns = rb[0] | (rb[1] << 8)
    }
    if (fExt) {
      const eb = readBytesInto(4)
      extLen = (eb[0] | (eb[1] << 8) | (eb[2] << 16) | (eb[3] << 24)) >>> 0
    }
    const bytePerChar = fHigh ? 2 : 1
    let remaining = cchVal * bytePerChar
    let chars = ''
    while (remaining > 0) {
      const av = curData.length - off
      if (av === 0) {
        ri++
        if (ri >= records.length) throw new Error('SST: 字符串被截断')
        curData = records[ri].data
        off = 1 // 跳过 CONTINUE 的 grbit 字节
        continue
      }
      const take = Math.min(av, remaining)
      const chunk = curData.slice(off, off + take)
      if (fHigh) {
        for (let i = 0; i + 1 < take; i += 2) {
          chars += String.fromCharCode(chunk[i] | (chunk[i + 1] << 8))
        }
      } else {
        for (let i = 0; i < take; i++) chars += String.fromCharCode(chunk[i])
      }
      off += take
      remaining -= take
    }
    skipBytes(nRuns * 4 + extLen)
    return chars
  }

  for (let i = 0; i < unique; i++) strings.push(readString())
  return strings
}

function parseRk(v) {
  const fDiv = (v & 0x02) === 2
  if (v & 0x01) {
    const i = (v | 0) >> 2
    return fDiv ? i / 100 : i
  }
  const hi = v & 0xFFFFFFFC
  const dv = new DataView(new ArrayBuffer(8))
  dv.setUint32(0, hi, false)
  dv.setUint32(4, 0, false)
  const x = dv.getFloat64(0, false)
  return fDiv ? x / 100 : x
}

function parseXlsSheet(wb, startPos, sst) {
  const cells = {}
  const rows = []
  const ensureRow = r => {
    if (!(r in cells)) {
      cells[r] = {}
      rows.push(r)
    }
    return cells[r]
  }
  let pos = startPos
  let pendingString = null
  const len = wb.length
  while (pos + 4 <= len) {
    const id = u16(wb, pos)
    const size = u16(wb, pos + 2)
    if (pos + 4 + size > len) break
    const d = wb.slice(pos + 4, pos + 4 + size)
    if (id === 0x000A) break // EOF
    if (id === 0x0208) { // ROW
      ensureRow(u16(d, 0))
    } else if (id === 0x00FD) { // LABELSST
      const r = u16(d, 0)
      const c = u16(d, 2)
      const idx = u32(d, 6)
      ensureRow(r)[c] = sst[idx] !== undefined ? sst[idx] : ''
    } else if (id === 0x0203) { // NUMBER
      const r = u16(d, 0)
      const c = u16(d, 2)
      ensureRow(r)[c] = readDouble(d, 6)
    } else if (id === 0x027E) { // RK
      const r = u16(d, 0)
      const c = u16(d, 2)
      ensureRow(r)[c] = parseRk(u32(d, 6))
    } else if (id === 0x00BD) { // MULRK
      const r = u16(d, 0)
      const cFirst = u16(d, 2)
      const cLast = u16(d, d.length - 2)
      for (let c = cFirst, i = 4; c <= cLast; c++, i += 6) {
        ensureRow(r)[c] = parseRk(u32(d, i + 2))
      }
    } else if (id === 0x0006) { // FORMULA
      const r = u16(d, 0)
      const c = u16(d, 2)
      const b0 = d[6]
      const b1 = d[7]
      if (b0 === 0xFF && b1 === 0xFF) {
        pendingString = { r, c }
      } else if (b0 === 0x00 && b1 === 0x00) {
        ensureRow(r)[c] = readDouble(d, 6)
      } else if (b0 === 0xFF && b1 === 0x00) {
        ensureRow(r)[c] = d[9] === 0 ? (d[8] !== 0) : '#ERROR'
      }
    } else if (id === 0x0207) { // STRING（公式字符串结果）
      if (pendingString) {
        const str = readUnicodeString(d, 6)
        ensureRow(pendingString.r)[pendingString.c] = str.text
        pendingString = null
      }
    } else if (id === 0x0201 || id === 0x00BE) { // BLANK / MULBLANK
      const r = u16(d, 0)
      const c = u16(d, 2)
      ensureRow(r)[c] = null
    }
    pos += 4 + size
  }
  rows.sort((a, b) => a - b)
  const grid = rows.map(r => {
    const keys = Object.keys(cells[r]).map(Number)
    const maxC = keys.length ? Math.max.apply(null, keys) : -1
    const rowArr = []
    for (let c = 0; c <= maxC; c++) rowArr.push(cells[r][c] !== undefined ? cells[r][c] : null)
    return rowArr
  })
  return grid
}

function parseXls(bytes) {
  const ole = parseOle(bytes)
  let wbEntry = ole.findEntry('Workbook')
  if (!wbEntry) wbEntry = ole.findEntry('Book')
  if (!wbEntry) throw new Error('未找到 Workbook 流')
  const wb = ole.readEntryStream(wbEntry)

  // 收集记录
  const records = []
  let pos = 0
  while (pos + 4 <= wb.length) {
    const id = u16(wb, pos)
    const size = u16(wb, pos + 2)
    if (pos + 4 + size > wb.length) break
    records.push({ id, size, data: wb.slice(pos + 4, pos + 4 + size) })
    pos += 4 + size
  }

  // BOUNDSHEET → sheet 列表
  const sheets = []
  for (const r of records) {
    if (r.id === 0x0085 && r.data.length >= 8) {
      const sheetPos = u32(r.data, 0)
      const nameLen = r.data[6]
      const name = readShortUnicodeString(r.data, 7, nameLen).text
      sheets.push({ name, pos: sheetPos })
    }
  }

  // SST
  const sstRecords = records.filter(r => r.id === 0x00FC)
  const sst = sstRecords.length ? parseSst(sstRecords) : []

  const result = []
  for (const sheet of sheets) {
    const grid = parseXlsSheet(wb, sheet.pos, sst)
    result.push(buildSheetResult(sheet.name, grid))
  }
  return { sheets: result }
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------
function readFileBytes(fileName, bytes) {
  const dot = fileName.lastIndexOf('.')
  const ext = (dot >= 0 ? fileName.slice(dot + 1) : '').toLowerCase()
  const base = { success: true, file_name: fileName, file_type: ext, file_size: bytes.length }
  try {
    if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp') {
      return Object.assign(base, parseImage(bytes, ext))
    }
    if (ext === 'xlsx') return Object.assign(base, parseXlsx(bytes))
    if (ext === 'xls') return Object.assign(base, parseXls(bytes))
    if (ext === 'csv') return Object.assign(base, parseCsv(bytes))
    if (ext === 'pdf') return Object.assign(base, parsePdf(bytes))
    if (ext === 'txt' || ext === 'md') return Object.assign(base, parseText(bytes))
    return Object.assign(base, { success: false, error: '不支持的文件类型: ' + ext })
  } catch (e) {
    return Object.assign(base, {
      success: false,
      error: '解析失败: ' + (e && e.message ? e.message : String(e))
    })
  }
}

// ---------------------------------------------------------------------------
// 独立运行（仅真实 Node 环境；沙箱内 module 为 undefined，此段不会执行）
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    readFileBytes,
    detectEncoding,
    inflate,
    inflateZlib,
    zipEntries,
    parseImage,
    parseCsv,
    parseText,
    parseXlsx,
    parsePdf,
    parseXls
  }
  if (typeof process !== 'undefined' && process.argv && process.argv.length > 2) {
    const fsmod = require('fs')
    const p = process.argv[2]
    const bytes = new Uint8Array(fsmod.readFileSync(p))
    const name = p.split(/[\\/]/).pop()
    console.log(JSON.stringify(readFileBytes(name, bytes), null, 2))
  }
}
