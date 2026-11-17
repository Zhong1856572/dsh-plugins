/**
 * 固定模版读写：读表头 → 把结构式按顺序写进「结构式/产品信息」列
 * ---------------------------------------------------------------------------
 * 做法是「外科手术式」改包：模版本身一个字节都不动，只做四件事
 *   1) 新增 xl/media/imageN.*（图片本体）
 *   2) 新增/追加 xl/drawings/drawingN.xml（图片锚点）
 *   3) sheet1.xml 末尾挂一个 <drawing r:id="..."/>，并补上 sheet 的 .rels
 *   4) [Content_Types].xml 补 image 默认类型与 drawing 覆盖项
 *
 * 好处：模版的合并单元格、行高、列宽、边框、字体全部原样保留，
 *       不会像「用库重写一遍」那样把模版样式改形。
 */

import { readZip, writeZip } from './zip.js'
import {
  colIndex,
  colLetter,
  colWidthToPx,
  escapeXml,
  parseRef,
  parseRels,
  parseSharedStrings,
  partDir,
  pxToEmu,
  readCellTexts,
  readColumnWidths,
  readMerges,
  readRowHeights,
  resolvePart,
  rowHeightToPx,
} from './ooxml.js'
import { EXCEL_MIME, extOf, mimeOf } from './imagemeta.js'

const DEFAULT_HEADER_HINTS = ['结构式', '结构', '产品信息']
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DRAWING_REL_TYPE = `${REL_NS}/drawing`
const DRAWING_CT = 'application/vnd.openxmlformats-officedocument.drawing+xml'

/* ------------------------------------------------------------------ *
 * 模版结构识别
 * ------------------------------------------------------------------ */

/**
 * 读取模版信息：目标列、起始行、可用行数。
 * @param {Buffer} buffer
 * @returns {Object}
 */
export function inspectTemplate(buffer) {
  const zip = readZip(buffer)
  const workbookXml = zip.byName.get('xl/workbook.xml')
  if (!workbookXml) throw new Error('这个文件不是 Excel 工作簿（缺少 xl/workbook.xml）')

  const workbookRels = parseRels(
    (zip.byName.get('xl/_rels/workbook.xml.rels') || Buffer.from('')).toString('utf8'),
  )
  const sharedStrings = parseSharedStrings(
    (zip.byName.get('xl/sharedStrings.xml') || Buffer.from('')).toString('utf8'),
  )

  const sheets = []
  const sheetRe = /<sheet\b([^>]*)\/?>/g
  let sm
  while ((sm = sheetRe.exec(workbookXml.toString('utf8')))) {
    const attrs = sm[1] || ''
    const name = (/name="([^"]*)"/.exec(attrs) || [])[1] || ''
    const rId = (/r:id="([^"]+)"/.exec(attrs) || [])[1]
    const sheetId = Number((/sheetId="(\d+)"/.exec(attrs) || [])[1] || sheets.length + 1)
    const rel = rId ? workbookRels.get(rId) : null
    if (!rel || !rel.target) continue
    sheets.push({ name, sheetId, partPath: resolvePart('xl', rel.target) })
  }
  if (!sheets.length) throw new Error('模版里没有找到工作表')

  sheets.sort((a, b) => a.sheetId - b.sheetId)
  const sheet = sheets[0]
  const sheetXml = zip.byName.get(sheet.partPath)
  if (!sheetXml) throw new Error(`模版的工作表部件缺失：${sheet.partPath}`)
  const sheetText = sheetXml.toString('utf8')

  const cells = readCellTexts(sheetText, sharedStrings)
  const merges = readMerges(sheetText)
  const rowHeights = readRowHeights(sheetText)

  // 目标列 = 表头里写着「结构式」的那一列
  let target = null
  const headerScanLimit = Math.min(4, Math.max(...[...rowHeights.keys()], 1))
  for (let row = 1; row <= headerScanLimit && !target; row += 1) {
    for (const [ref, text] of cells) {
      const parsed = parseRef(ref)
      if (!parsed || parsed.row !== row) continue
      const hint = DEFAULT_HEADER_HINTS.find((h) => text.includes(h))
      if (hint) {
        target = { column: parsed.col, row, title: text, hint }
        break
      }
    }
  }
  if (!target) {
    const heads = []
    for (const [ref, text] of cells) {
      const parsed = parseRef(ref)
      if (parsed && parsed.row === target?.row) heads.push(`${colLetter(parsed.col - 1)}:${text}`)
      if (parsed && parsed.row <= 2 && text) heads.push(`${colLetter(parsed.col - 1)}:${text}`)
    }
    throw new Error(
      `模版里找不到「结构式」这一列（已检查表头：${[...new Set(heads)].slice(0, 12).join('、') || '空'}）。请确认模版表头是否含「结构式」字样。`,
    )
  }

  // 合并跨度：优先用数据行的合并，其次用表头的合并
  let mergeEndCol = target.column
  for (const merge of merges) {
    if (merge.start.col === target.column && merge.start.row > target.row && merge.end.col > mergeEndCol) {
      mergeEndCol = merge.end.col
    }
  }
  for (const merge of merges) {
    if (merge.start.col === target.column && merge.start.row === target.row && merge.end.col > mergeEndCol) {
      mergeEndCol = merge.end.col
    }
  }

  const dataStartRow = target.row + 1
  const maxRow = Math.max(...rowHeights.keys(), dataStartRow)
  const availableRows = Math.max(0, maxRow - dataStartRow + 1)

  const headers = []
  for (const [ref, text] of cells) {
    const parsed = parseRef(ref)
    if (!parsed || parsed.row !== target.row) continue
    headers.push({ column: parsed.col, letter: colLetter(parsed.col - 1), title: text })
  }
  headers.sort((a, b) => a.column - b.column)

  const colWidths = readColumnWidths(sheetText)
  const defaultWidth = Number(
    (/defaultColWidth="([\d.]+)"/.exec(sheetText) || [])[1] || 9,
  )

  return {
    sheetName: sheet.name,
    sheetPartPath: sheet.partPath,
    targetColumn: target.column,
    targetColumnLetter: colLetter(target.column - 1),
    targetTitle: target.title,
    mergeEndColumn: mergeEndCol,
    mergeEndColumnLetter: colLetter(mergeEndCol - 1),
    headerRow: target.row,
    dataStartRow,
    availableRows,
    maxRow,
    headers,
    columns: colWidths,
    defaultColWidth: defaultWidth,
    rowHeights,
  }
}

/* ------------------------------------------------------------------ *
 * 模版里的坏锚点清理
 * ------------------------------------------------------------------ */

/**
 * 清掉模版里"坏引用"的图片锚点。
 *
 * 判据：锚点里的图片引用（a:blip r:embed）必须能通过 drawing 的 rels
 * 解析到包里真实存在的 media 文件。
 * - 有些模版里留着从别处粘过来的占位框：blipFill 是空的、图片文件早已不在，
 *   它们会被原样带进导出结果，在表格里变成一个个没有内容的小方块；
 * - 有真实图片的锚点（例如公司 logo）必须保留。
 *
 * @param {string} drawingXml
 * @param {Map<string, {target: string}>} drawingRels
 * @param {Map<string, Buffer>} byName 包内所有部件
 * @param {string} drawingPartPath drawing 部件在包内的路径
 * @returns {{ xml: string, droppedRels: string[] }}
 */
function dropBrokenAnchors(drawingXml, drawingRels, byName, drawingPartPath) {
  if (!drawingXml) return { xml: drawingXml, droppedRels: [] }
  const pattern = /<xdr:(oneCellAnchor|twoCellAnchor)\b[^>]*>[\s\S]*?<\/xdr:\1>/g
  const blocks = []
  let match = pattern.exec(drawingXml)
  while (match !== null) {
    blocks.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
    match = pattern.exec(drawingXml)
  }
  if (!blocks.length) return { xml: drawingXml, droppedRels: [] }

  const dir = partDir(drawingPartPath)
  const decisions = []
  const droppedRels = []
  let dropped = 0
  for (const block of blocks) {
    const blip = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(block.text)
    if (!blip) {
      decisions.push(false) // 空占位框：没有图片引用
      dropped += 1
      continue
    }
    const rel = drawingRels.get(blip[1])
    const target = rel && rel.target ? resolvePart(dir, rel.target) : ''
    const alive = !!(target && byName.has(target))
    decisions.push(alive)
    if (!alive) {
      dropped += 1
      droppedRels.push(blip[1])
    }
  }
  if (!dropped) return { xml: drawingXml, droppedRels: [] }

  // 重建：保留锚点之间的原始内容（空白等），只去掉坏锚点
  let out = ''
  let cursor = 0
  blocks.forEach((block, i) => {
    out += drawingXml.slice(cursor, block.start)
    if (decisions[i]) out += block.text
    cursor = block.end
  })
  out += drawingXml.slice(cursor)
  return { xml: out, droppedRels }
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/**
 * 把图片按顺序写进模版的目标列。
 * @param {Buffer} buffer 模版字节
 * @param {Array<{bytes: Buffer, name?: string, width?: number, height?: number, extentCx?: number, extentCy?: number}>} images
 * @param {Object} options { sheetPartPath, targetColumn, mergeEndColumn, dataStartRow, columns, defaultColWidth, rowHeights }
 * @returns {{ buffer: Buffer, written: number, firstRow: number, lastRow: number, sheetName: string }}
 */
export function fillTemplate(buffer, images, options) {
  const zip = readZip(buffer)
  const entries = zip.entries.map((e) => ({ name: e.name, data: e.data }))
  const byName = new Map(entries.map((e) => [e.name, e.data]))

  const sheetPartPath = options.sheetPartPath
  let sheetText = byName.get(sheetPartPath).toString('utf8')
  const sheetDir = partDir(sheetPartPath)
  const sheetFile = sheetPartPath.split('/').pop()
  const sheetRelsPath = `${sheetDir}/_rels/${sheetFile}.rels`

  const targetColumn = options.targetColumn
  const mergeEndColumn = Math.max(targetColumn, options.mergeEndColumn || targetColumn)
  const dataStartRow = options.dataStartRow

  // 需要更多行时补行（克隆最后一行样式 + 补合并）
  const neededRows = dataStartRow + images.length - 1
  const extend = ensureDataRows(sheetText, neededRows, targetColumn, mergeEndColumn)
  sheetText = extend.sheetXml

  // 列宽（像素）
  const columns = options.columns || []
  const defaultWidth = options.defaultColWidth || 9
  const colPx = (col) => {
    const hit = columns.find((c) => col >= c.min && col <= c.max)
    return colWidthToPx(hit ? hit.width : defaultWidth)
  }
  const boxWidthPx = (() => {
    let total = 0
    for (let c = targetColumn; c <= mergeEndColumn; c += 1) total += colPx(c)
    return total
  })()

  const rowHeights = options.rowHeights instanceof Map ? options.rowHeights : new Map()
  const rowPx = (row) => rowHeightToPx(rowHeights.get(row) || 0)

  // media 部件命名（避开已有）
  let mediaIndex = 1
  for (const name of byName.keys()) {
    const m = /^xl\/media\/image(\d+)\./.exec(name)
    if (m) mediaIndex = Math.max(mediaIndex, Number(m[1]) + 1)
  }

  // 找到（或新建）drawing 部件
  const sheetRels = parseRels((byName.get(sheetRelsPath) || Buffer.from('')).toString('utf8'))
  let drawingPartPath = ''
  let drawingRelsPath = ''
  let drawingRelsXml = ''
  let drawingXml = ''
  let drawingRelId = ''

  for (const [id, rel] of sheetRels) {
    if (rel.type && rel.type.endsWith('/drawing')) {
      drawingRelId = id
      drawingPartPath = resolvePart(sheetDir, rel.target)
      break
    }
  }

  if (drawingPartPath) {
    drawingXml = byName.get(drawingPartPath).toString('utf8')
    drawingRelsPath = `${partDir(drawingPartPath)}/_rels/${drawingPartPath.split('/').pop()}.rels`
    drawingRelsXml = (byName.get(drawingRelsPath) || Buffer.from('')).toString('utf8')
  } else {
    let n = 1
    while (byName.has(`xl/drawings/drawing${n}.xml`)) n += 1
    drawingPartPath = `xl/drawings/drawing${n}.xml`
    drawingRelsPath = `xl/drawings/_rels/drawing${n}.xml.rels`
    drawingXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      `xmlns:r="${REL_NS}"></xdr:wsDr>`
    drawingRelsXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  }

  const drawingRels = parseRels(drawingRelsXml)

  // 模版自带的坏锚点（图片引用被删空的占位框）不能带进结果
  if (drawingPartPath) {
    const cleaned = dropBrokenAnchors(drawingXml, drawingRels, byName, drawingPartPath)
    drawingXml = cleaned.xml
    for (const id of cleaned.droppedRels) drawingRels.delete(id)
  }

  let relSeq = 1
  for (const id of drawingRels.keys()) {
    const m = /^rId(\d+)$/.exec(id)
    if (m) relSeq = Math.max(relSeq, Number(m[1]) + 1)
  }

  // 现存图片编号（cNvPr id 必须唯一）
  let picId = 1
  for (const m of drawingXml.matchAll(/<xdr:cNvPr\b[^>]*\bid="(\d+)"/g)) {
    picId = Math.max(picId, Number(m[1]) + 1)
  }

  const anchors = []
  const newMedia = []
  const contentTypes = new Set()

  images.forEach((image, index) => {
    const ext = extOf(image.name || '') || extOf(image.ext || '') || 'png'
    const mime = mimeOf(image.name || `image.${ext}`)
    if (!EXCEL_MIME.has(mime)) {
      throw new Error(`图片格式 ${ext || '未知'} 无法写入 Excel（仅支持 png/jpg/gif/bmp/emf/wmf）`)
    }
    contentTypes.add(ext)

    const mediaName = `xl/media/image${mediaIndex}.${ext}`
    mediaIndex += 1
    newMedia.push({ name: mediaName, data: image.bytes })

    const relId = `rId${relSeq}`
    relSeq += 1
    drawingRels.set(relId, { target: `../media/image${mediaIndex - 1}.${ext}`, type: `${REL_NS}/image` })

    const row = dataStartRow + index
    const boxH = rowPx(row)
    const boxW = boxWidthPx

    // 原始比例：优先用文档里的显示尺寸（wp:extent），否则用像素尺寸
    let ratio = 0
    if (image.extentCx > 0 && image.extentCy > 0) {
      ratio = image.extentCx / image.extentCy
    } else if (image.width > 0 && image.height > 0) {
      ratio = image.width / image.height
    }

    const padX = 4
    const padY = 4
    const innerW = Math.max(8, boxW - padX * 2)
    const innerH = Math.max(8, boxH - padY * 2)

    let drawW = innerW
    let drawH = innerH
    if (ratio > 0) {
      const byHeight = innerH * ratio
      if (byHeight <= innerW) {
        drawW = byHeight
        drawH = innerH
      } else {
        drawW = innerW
        drawH = innerW / ratio
      }
    }

    const colOff = pxToEmu(Math.max(0, Math.round((boxW - drawW) / 2)))
    const rowOff = pxToEmu(Math.max(0, Math.round((boxH - drawH) / 2)))
    const cx = pxToEmu(Math.round(drawW))
    const cy = pxToEmu(Math.round(drawH))

    anchors.push(
      [
        '<xdr:oneCellAnchor>',
        '<xdr:from>',
        `<xdr:col>${targetColumn - 1}</xdr:col>`,
        `<xdr:colOff>${colOff}</xdr:colOff>`,
        `<xdr:row>${row - 1}</xdr:row>`,
        `<xdr:rowOff>${rowOff}</xdr:rowOff>`,
        '</xdr:from>',
        `<xdr:ext cx="${cx}" cy="${cy}"/>`,
        '<xdr:pic>',
        '<xdr:nvPicPr>',
        `<xdr:cNvPr id="${picId + index}" name="结构式 ${index + 1}"/>`,
        '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>',
        '</xdr:nvPicPr>',
        '<xdr:blipFill>',
        `<a:blip r:embed="${relId}"/>`,
        '<a:stretch><a:fillRect/></a:stretch>',
        '</xdr:blipFill>',
        '<xdr:spPr>',
        `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`,
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
        '</xdr:spPr>',
        '</xdr:pic>',
        '<xdr:clientData/>',
        '</xdr:oneCellAnchor>',
      ].join(''),
    )
  })

  // 合并 drawing XML
  const anchorXml = anchors.join('')
  if (drawingXml.includes('</xdr:wsDr>')) {
    drawingXml = drawingXml.replace('</xdr:wsDr>', `${anchorXml}</xdr:wsDr>`)
  } else {
    drawingXml += anchorXml
  }

  // 合并 drawing 的 rels
  const relEntries = [...drawingRels.entries()]
    .map(([id, rel]) => `<Relationship Id="${id}" Type="${rel.type}" Target="${escapeXml(rel.target)}"/>`)
    .join('')
  const newDrawingRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    relEntries +
    '</Relationships>'

  // sheet 挂 drawing
  if (!drawingRelId) {
    let sheetRelSeq = 1
    for (const id of sheetRels.keys()) {
      const m = /^rId(\d+)$/.exec(id)
      if (m) sheetRelSeq = Math.max(sheetRelSeq, Number(m[1]) + 1)
    }
    drawingRelId = `rId${sheetRelSeq}`
    sheetRels.set(drawingRelId, {
      target: `../${drawingPartPath.replace(/^xl\//, '')}`,
      type: DRAWING_REL_TYPE,
    })
    sheetText = insertDrawingTag(sheetText, drawingRelId)
  }

  const sheetRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    [...sheetRels.entries()]
      .map(([id, rel]) => `<Relationship Id="${id}" Type="${rel.type}" Target="${escapeXml(rel.target)}"/>`)
      .join('') +
    '</Relationships>'

  // 组装新的包
  const replaced = new Map()
  replaced.set(sheetPartPath, Buffer.from(sheetText, 'utf8'))
  replaced.set(sheetRelsPath, Buffer.from(sheetRelsXml, 'utf8'))
  replaced.set(drawingPartPath, Buffer.from(drawingXml, 'utf8'))
  replaced.set(drawingRelsPath, Buffer.from(newDrawingRelsXml, 'utf8'))
  for (const media of newMedia) replaced.set(media.name, media.data)

  const outEntries = []
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    outEntries.push({ name: entry.name, data: replaced.get(entry.name) || entry.data })
  }
  for (const [name, data] of replaced) {
    if (seen.has(name)) continue
    seen.add(name)
    outEntries.push({ name, data })
  }

  // Content_Types
  const ctEntry = outEntries.find((e) => e.name === '[Content_Types].xml')
  if (ctEntry) {
    let ct = ctEntry.data.toString('utf8')
    for (const ext of contentTypes) {
      if (!new RegExp(`<Default\\b[^>]*Extension="${ext}"`, 'i').test(ct)) {
        const mime = mimeOf(`x.${ext}`)
        ct = ct.replace(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="${ext}" ContentType="${mime}"/>`,
        )
      }
    }
    if (!ct.includes(`PartName="/${drawingPartPath}"`)) {
      ct = ct.replace(
        '</Types>',
        `<Override PartName="/${drawingPartPath}" ContentType="${DRAWING_CT}"/></Types>`,
      )
    }
    ctEntry.data = Buffer.from(ct, 'utf8')
  }

  const outBuffer = writeZip(outEntries)
  return {
    buffer: outBuffer,
    written: images.length,
    firstRow: dataStartRow,
    lastRow: dataStartRow + images.length - 1,
  }
}

/** 在 sheet XML 里插入 <drawing r:id="..."/>（按 OOXML 规定的元素顺序） */
function insertDrawingTag(sheetXml, relId) {
  const tag = `<drawing r:id="${relId}"/>`
  const anchors = [
    '<legacyDrawing',
    '<legacyDrawingHF',
    '<picture',
    '<oleObjects',
    '<controls',
    '<webPublishItems',
    '<tableParts',
    '<extLst',
  ]
  for (const anchor of anchors) {
    const idx = sheetXml.indexOf(anchor)
    if (idx >= 0) return `${sheetXml.slice(0, idx)}${tag}${sheetXml.slice(idx)}`
  }
  const idx = sheetXml.lastIndexOf('</worksheet>')
  if (idx < 0) throw new Error('模版的工作表 XML 不完整')
  return `${sheetXml.slice(0, idx)}${tag}${sheetXml.slice(idx)}`
}

/** 行不够时按最后一行样式补行，并补上目标列的合并单元格 */
function ensureDataRows(sheetXml, neededRow, targetColumn, mergeEndColumn) {
  const rowRe = /<row\b([^>]*)\/?>(?:([\s\S]*?)<\/row>)?/g
  let maxRow = 0
  let lastRowXml = ''
  let lastRowNo = 0
  let m
  while ((m = rowRe.exec(sheetXml))) {
    const attrs = m[1] || ''
    const r = Number((/r="(\d+)"/.exec(attrs) || [])[1] || 0)
    if (!r) continue
    if (r > maxRow) {
      maxRow = r
      lastRowNo = r
      lastRowXml = m[0]
    }
  }
  if (neededRow <= maxRow) return { sheetXml }

  if (!lastRowXml) return { sheetXml }
  const extraRows = []
  const extraMerges = []
  for (let row = maxRow + 1; row <= neededRow; row += 1) {
    let cloned = lastRowXml.replace(/r="\d+"/, `r="${row}"`)
    extraRows.push(cloned)
    if (mergeEndColumn > targetColumn) {
      extraMerges.push(
        `<mergeCell ref="${colLetter(targetColumn - 1)}${row}:${colLetter(mergeEndColumn - 1)}${row}"/>`,
      )
    }
  }

  let out = sheetXml
  if (extraRows.length) {
    const idx = out.lastIndexOf('</sheetData>')
    if (idx < 0) throw new Error('模版缺少 sheetData')
    out = `${out.slice(0, idx)}${extraRows.join('')}${out.slice(idx)}`
  }
  if (extraMerges.length) {
    if (out.includes('</mergeCells>')) {
      out = out.replace('</mergeCells>', `${extraMerges.join('')}</mergeCells>`)
    } else {
      const idx = out.indexOf('<sheetData>')
      out = `${out.slice(0, idx)}<mergeCells count="${extraMerges.length}">${extraMerges.join('')}</mergeCells>${out.slice(idx)}`
    }
  }
  // dimension 同步放大
  out = out.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"/, (all, startCol, endCol, endRow) =>
    Number(endRow) < neededRow ? `<dimension ref="${startCol}:${endCol}${neededRow}"` : all,
  )
  return { sheetXml: out }
}
