/**
 * 图片提取：按文档从上到下的顺序抽出所有图片
 * ---------------------------------------------------------------------------
 * 支持两类源文件：
 *   · Word（.docx）：读 word/document.xml，按出现顺序取 <a:blip> / <v:imagedata>
 *   · Excel（.xlsx）：读各工作表的 drawing，按（表序 → 行 → 列）排序取图片
 *
 * 每张图都带一段「上下文文字」：Word 取所在表格行的文字，Excel 取锚点单元格文字，
 * 方便用户在预览里一眼认出哪张是结构式。
 */

import { readZip } from './zip.js'
import {
  decodeEntities,
  parseRels,
  parseSharedStrings,
  partDir,
  readCellTexts,
  resolvePart,
} from './ooxml.js'
import { extOf, imageSize, mimeOf } from './imagemeta.js'

/** 上下文文字最长保留长度 */
const CONTEXT_MAX = 160

function cleanText(text) {
  return decodeEntities(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(text, max = CONTEXT_MAX) {
  const t = cleanText(text)
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 提取图片。
 * @param {Buffer} buffer 源文件字节
 * @param {string} fileName 源文件名（用于判定格式）
 * @returns {{kind: 'docx'|'xlsx', items: Array<Object>}}
 */
export function extractImages(buffer, fileName = '') {
  const zip = readZip(buffer)
  const names = new Set(zip.entries.map((e) => e.name))

  if (names.has('word/document.xml')) {
    return { kind: 'docx', items: extractFromDocx(zip) }
  }
  if (names.has('xl/workbook.xml')) {
    return { kind: 'xlsx', items: extractFromXlsx(zip) }
  }

  const lower = String(fileName || '').toLowerCase()
  if (lower.endsWith('.docx')) throw new Error('这个 .docx 里没有找到正文（word/document.xml），可能不是 Word 文档')
  if (lower.endsWith('.xlsx')) throw new Error('这个 .xlsx 里没有找到工作表（xl/workbook.xml），可能不是 Excel 工作簿')
  throw new Error('只支持 .docx（Word）和 .xlsx（Excel）文件')
}

/* ------------------------------------------------------------------ *
 * Word
 * ------------------------------------------------------------------ */

function extractFromDocx(zip) {
  const docXml = zip.byName.get('word/document.xml').toString('utf8')
  const rels = parseRels(
    (zip.byName.get('word/_rels/document.xml.rels') || Buffer.from('')).toString('utf8'),
  )

  const items = []
  let inRow = false
  let rowText = []
  let paraText = []
  let lastPara = ''
  let pendingExtent = null

  const TOKEN =
    /<w:tr\b|<\/w:tr>|<w:p\b[^>]*>|<\/w:p>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<a:blip\b([^>]*?)\/?>|<v:imagedata\b([^>]*?)\/?>|<wp:extent\b([^>]*?)\/?>/g

  const push = (rId, context) => {
    const rel = rels.get(rId)
    if (!rel || !rel.target) return
    const partPath = resolvePart('word', rel.target)
    const bytes = zip.byName.get(partPath)
    if (!bytes) return
    const name = partPath.split('/').pop() || partPath
    const size = imageSize(bytes)
    items.push({
      index: items.length,
      name,
      ext: extOf(name),
      mime: mimeOf(name),
      bytes,
      width: size ? size.width : 0,
      height: size ? size.height : 0,
      extentCx: pendingExtent ? pendingExtent.cx : 0,
      extentCy: pendingExtent ? pendingExtent.cy : 0,
      context: clip(context),
    })
    pendingExtent = null
  }

  let m
  const currentContext = () => (inRow ? rowText.join(' ') : paraText.join(' ') || lastPara)
  while ((m = TOKEN.exec(docXml))) {
    const token = m[0]

    if (token.startsWith('<w:tr')) {
      inRow = true
      rowText = []
      continue
    }
    if (token.startsWith('</w:tr')) {
      inRow = false
      rowText = []
      continue
    }
    if (token.startsWith('<w:p')) {
      paraText = []
      continue
    }
    if (token.startsWith('</w:p')) {
      // 段落结束：留作后面图片的兜底上下文（图片常跟在标题段之后）
      if (paraText.length) lastPara = paraText.join(' ')
      paraText = []
      continue
    }
    if (m[1] !== undefined) {
      const text = cleanText(m[1])
      if (text) {
        if (inRow) rowText.push(text)
        paraText.push(text)
      }
      continue
    }
    if (m[4] !== undefined) {
      // <wp:extent cx=".." cy=".."> —— 记录图片在原文档里的显示尺寸
      const attrs = m[4] || ''
      const cx = Number((/cx="(\d+)"/.exec(attrs) || [])[1] || 0)
      const cy = Number((/cy="(\d+)"/.exec(attrs) || [])[1] || 0)
      pendingExtent = { cx, cy }
      continue
    }
    if (m[2] !== undefined) {
      const rId = (/r:embed="([^"]+)"/.exec(m[2]) || [])[1]
      if (rId) push(rId, currentContext())
      continue
    }
    if (m[3] !== undefined) {
      const rId = (/r:id="([^"]+)"/.exec(m[3]) || [])[1]
      if (rId) push(rId, currentContext())
      continue
    }
  }

  return items
}

/* ------------------------------------------------------------------ *
 * Excel
 * ------------------------------------------------------------------ */

function extractFromXlsx(zip) {
  const workbookXml = zip.byName.get('xl/workbook.xml').toString('utf8')
  const workbookRels = parseRels(
    (zip.byName.get('xl/_rels/workbook.xml.rels') || Buffer.from('')).toString('utf8'),
  )
  const sharedStrings = parseSharedStrings(
    (zip.byName.get('xl/sharedStrings.xml') || Buffer.from('')).toString('utf8'),
  )

  const sheets = []
  const sheetRe = /<sheet\b([^>]*)\/?>/g
  let sm
  while ((sm = sheetRe.exec(workbookXml))) {
    const attrs = sm[1] || ''
    const name = (/name="([^"]*)"/.exec(attrs) || [])[1] || ''
    const rId = (/r:id="([^"]+)"/.exec(attrs) || [])[1]
    const sheetId = Number((/sheetId="(\d+)"/.exec(attrs) || [])[1] || sheets.length + 1)
    if (!rId) continue
    const rel = workbookRels.get(rId)
    if (!rel || !rel.target) continue
    sheets.push({ name, sheetId, partPath: resolvePart('xl', rel.target) })
  }
  sheets.sort((a, b) => a.sheetId - b.sheetId)

  const collected = []

  for (const sheet of sheets) {
    const sheetXml = zip.byName.get(sheet.partPath)
    if (!sheetXml) continue
    const sheetDir = partDir(sheet.partPath)
    const sheetRelsPath = `${sheetDir}/_rels/${sheet.partPath.split('/').pop()}.rels`
    const sheetRels = parseRels(
      (zip.byName.get(sheetRelsPath) || Buffer.from('')).toString('utf8'),
    )

    for (const [, rel] of sheetRels) {
      if (!rel.type || !rel.type.endsWith('/drawing')) continue
      const drawingPath = resolvePart(sheetDir, rel.target)
      const drawingXml = zip.byName.get(drawingPath)
      if (!drawingXml) continue
      const drawingDir = partDir(drawingPath)
      const drawingRels = parseRels(
        (
          zip.byName.get(`${drawingDir}/_rels/${drawingPath.split('/').pop()}.rels`) ||
          Buffer.from('')
        ).toString('utf8'),
      )

      const cellTexts = readCellTexts(sheetXml.toString('utf8'), sharedStrings)

      const ANCHOR =
        /<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g
      let am
      while ((am = ANCHOR.exec(drawingXml.toString('utf8')))) {
        const body = am[2] || ''
        const fromCol = Number((/<xdr:col>(\d+)<\/xdr:col>/.exec(body) || [])[1] || 0)
        const fromRow = Number((/<xdr:row>(\d+)<\/xdr:row>/.exec(body) || [])[1] || 0)
        const rId = (/r:embed="([^"]+)"/.exec(body) || [])[1]
        if (!rId) continue
        const mediaRel = drawingRels.get(rId)
        if (!mediaRel || !mediaRel.target) continue
        const partPath = resolvePart(drawingDir, mediaRel.target)
        const bytes = zip.byName.get(partPath)
        if (!bytes) continue

        const name = partPath.split('/').pop() || partPath
        const size = imageSize(bytes)
        const cellRef = `${columnName(fromCol)}${fromRow + 1}`
        const cellText = cellTexts.get(cellRef) || ''

        collected.push({
          order: collected.length,
          sheet: sheet.name,
          row: fromRow + 1,
          col: fromCol + 1,
          name,
          ext: extOf(name),
          mime: mimeOf(name),
          bytes,
          width: size ? size.width : 0,
          height: size ? size.height : 0,
          extentCx: 0,
          extentCy: 0,
          context: clip(`${sheet.name}!${cellRef}${cellText ? ` ${cellText}` : ''}`),
        })
      }
    }
  }

  collected.sort((a, b) => {
    if (a.sheet !== b.sheet) return 0 // 同表内再按位置排，跨表保持工作簿顺序
    if (a.row !== b.row) return a.row - b.row
    return a.col - b.col
  })

  return collected.map((item, index) => ({ ...item, index }))
}

function columnName(index0) {
  let n = Number(index0)
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}
