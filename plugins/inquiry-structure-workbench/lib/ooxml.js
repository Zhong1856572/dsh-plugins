/**
 * OOXML 轻量解析工具（无第三方依赖）
 * ---------------------------------------------------------------------------
 * 只解析工作台需要的几类信息：
 *   · 共享字符串 / 单元格文本（用于读模版表头）
 *   · 行高、列宽（用于把结构式按比例放进单元格）
 *   · 关系表 rId → target（用于把图片和 drawing 对上）
 *   · 合并单元格（用于找到「结构式/产品信息」这一列的实际宽度）
 */

/** XML 文本转义 */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 0 基列号 → 列字母（0 → A） */
export function colLetter(index) {
  let n = Number(index)
  if (!Number.isFinite(n) || n < 0) return 'A'
  let out = ''
  n = Math.floor(n)
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/** 列字母 → 0 基列号（A → 0） */
export function colIndex(letters) {
  const s = String(letters || '').toUpperCase()
  let n = 0
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (code < 65 || code > 90) return NaN
    n = n * 26 + (code - 64)
  }
  return n - 1
}

/** 单元格引用 → { row(1基), col(1基) } */
export function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref || '').toUpperCase())
  if (!m) return null
  return { row: Number(m[2]), col: colIndex(m[1]) + 1 }
}

/**
 * 解析 sharedStrings.xml。
 * @param {string} xml
 * @returns {string[]}
 */
export function parseSharedStrings(xml) {
  if (!xml) return []
  const out = []
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m
  while ((m = siRe.exec(xml))) {
    // 去掉注音块，再把所有 <t> 文本拼起来（不区分是否包在 <r> 富文本里）
    const body = m[1].replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '')
    const parts = []
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let tm
    while ((tm = tRe.exec(body))) parts.push(tm[1])
    out.push(decodeEntities(parts.join('')))
  }
  return out
}

/** XML 实体解码 */
export function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

/**
 * 读取工作表里所有单元格的显示文本。
 * @param {string} sheetXml
 * @param {string[]} sharedStrings
 * @returns {Map<string, string>} 键为单元格引用（�� F3），值为文本
 */
export function readCellTexts(sheetXml, sharedStrings) {
  const out = new Map()
  if (!sheetXml) return out
  const cellRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g
  let m
  while ((m = cellRe.exec(sheetXml))) {
    const attrs = m[1] || m[2] || ''
    const inner = m[3] || ''
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)
    if (!ref) continue
    const type = /t="([^"]+)"/.exec(attrs)
    const t = type ? type[1] : 'n'
    let value = ''
    if (t === 's') {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
      const idx = v ? Number(v[1]) : NaN
      value = Number.isFinite(idx) ? sharedStrings[idx] || '' : ''
    } else if (t === 'inlineStr') {
      const parts = []
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
      let tm
      while ((tm = tRe.exec(inner))) parts.push(tm[1])
      value = decodeEntities(parts.join(''))
    } else if (t === 'str' || t === 'e') {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
      value = v ? decodeEntities(v[1]) : ''
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
      value = v ? v[1] : ''
    }
    out.set(ref[1], value)
  }
  return out
}

/**
 * 读取 sheetData 里每一行的行号与行高（磅）。
 * @param {string} sheetXml
 * @returns {Map<number, number>} 行号 → 行高（pt，缺省 15）
 */
export function readRowHeights(sheetXml) {
  const out = new Map()
  if (!sheetXml) return out
  const rowRe = /<row\b([^>]*)\/?>/g
  let m
  while ((m = rowRe.exec(sheetXml))) {
    const attrs = m[1] || ''
    const r = /r="(\d+)"/.exec(attrs)
    const ht = /ht="([\d.]+)"/.exec(attrs)
    if (!r) continue
    out.set(Number(r[1]), ht ? Number(ht[1]) : 15)
  }
  return out
}

/**
 * 读取列宽。
 * @param {string} sheetXml
 * @returns {Array<{min:number,max:number,width:number}>} 列号为 1 基
 */
export function readColumnWidths(sheetXml) {
  const out = []
  if (!sheetXml) return out
  const colRe = /<col\b([^>]*)\/?>/g
  let m
  while ((m = colRe.exec(sheetXml))) {
    const attrs = m[1] || ''
    const min = Number((/min="(\d+)"/.exec(attrs) || [])[1] || 0)
    const max = Number((/max="(\d+)"/.exec(attrs) || [])[1] || 0)
    const width = Number((/width="([\d.]+)"/.exec(attrs) || [])[1] || 0)
    if (min && max && width) out.push({ min, max, width })
  }
  return out
}

/**
 * 读取合并单元格区间。
 * @param {string} sheetXml
 * @returns {Array<{ref:string, start:{row,col}, end:{row,col}}>}
 */
export function readMerges(sheetXml) {
  const out = []
  if (!sheetXml) return out
  const mergeRe = /<mergeCell\b([^>]*)\/?>/g
  let m
  while ((m = mergeRe.exec(sheetXml))) {
    const ref = (/ref="([^"]+)"/.exec(m[1] || '') || [])[1]
    if (!ref) continue
    const [a, b] = ref.split(':')
    const start = parseRef(a)
    const end = parseRef(b || a)
    if (start && end) out.push({ ref, start, end })
  }
  return out
}

/**
 * 解析关系表（.rels）。
 * @param {string} xml
 * @returns {Map<string, {target: string, type: string}>}
 */
export function parseRels(xml) {
  const out = new Map()
  if (!xml) return out
  const relRe = /<Relationship\b([^>]*)\/?>/g
  let m
  while ((m = relRe.exec(xml))) {
    const attrs = m[1] || ''
    const id = (/Id="([^"]+)"/.exec(attrs) || [])[1]
    const target = (/Target="([^"]+)"/.exec(attrs) || [])[1]
    const type = (/Type="([^"]+)"/.exec(attrs) || [])[1]
    if (id) out.set(id, { target: target || '', type: type || '' })
  }
  return out
}

/**
 * 把关系 target 解析成 zip 内的绝对部件路径。
 * @param {string} baseDir 关系文件所在目录（无尾斜杠）
 * @param {string} target
 * @returns {string}
 */
export function resolvePart(baseDir, target) {
  if (!target) return ''
  let t = String(target).split('#')[0].replace(/\\/g, '/')
  if (t.startsWith('/')) return t.slice(1)
  const base = baseDir ? baseDir.replace(/\/+$/, '') + '/' : ''
  const parts = (base + t).split('/')
  const stack = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.join('/')
}

/** 部件路径 → 所在目录 */
export function partDir(partPath) {
  const idx = String(partPath || '').lastIndexOf('/')
  return idx < 0 ? '' : partPath.slice(0, idx)
}

/** Excel 列宽（字符）→ 像素（近似 Calibri 11） */
export function colWidthToPx(width) {
  const w = Number(width)
  if (!Number.isFinite(w) || w <= 0) return 64
  return Math.round(w * 7) + 5
}

/** 行高（磅）→ 像素 */
export function rowHeightToPx(pt) {
  const h = Number(pt)
  if (!Number.isFinite(h) || h <= 0) return 20
  return Math.round((h * 96) / 72)
}

/** 像素 → EMU */
export function pxToEmu(px) {
  return Math.max(1, Math.round(Number(px) * 9525))
}
