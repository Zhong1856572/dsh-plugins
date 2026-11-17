/**
 * 边界自测：图片数量不固定 + Excel 作为源文件
 *   · 合成 3 张图的 docx  → 提取应为 3
 *   · 合成 30 张图的 docx → 提取应为 30，并写进模版第 3~32 行
 *   · 以已生成的 xlsx 作为源 → 按行顺序取回图片
 * 用法：node scripts/edgetest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeZip } from '../lib/zip.js'
import { extractImages } from '../lib/extract.js'
import { inspectTemplate, fillTemplate } from '../lib/template.js'
import { pickPath, needSample } from './paths.mjs'

const TEMPLATE = needSample(pickPath(process.argv[2], ['TEMPLATE_XLSX']), '模版', '命令行参数或 TEMPLATE_XLSX 环境变量')
const SOURCE = needSample(pickPath(process.argv[3], ['SAMPLE_DOCX']), '源文件', '命令行参数或 SAMPLE_DOCX 环境变量')
const WORK = path.resolve('.tmp', 'edge')
fs.mkdirSync(WORK, { recursive: true })

/** 合成一个只含结构式图片的最小 docx */
function makeDocx(count) {
  const source = fs.readFileSync(SOURCE)
  // 直接从真实文档里取前 count 张图当素材，避免自造 PNG
  const { unzip } = {}
  void unzip

  const entries = []
  const media = []
  for (let i = 1; i <= count; i += 1) {
    // 用真实图片的字节：从源 zip 里取（下面用简单的方式读）
    media.push({ name: `image${i}.png`, data: readSourceImage(i) })
  }

  const body = media
    .map(
      (m, i) =>
        `<w:p><w:r><w:t>CAP-${i + 1}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1330325" cy="953135"/>` +
        `<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId${i + 1}"/>` +
        `</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
    )
    .join('')

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<w:body>${body}<w:sectPr/></w:body></w:document>`

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    media
      .map(
        (m, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`,
      )
      .join('') +
    '</Relationships>'

  entries.push({ name: '[Content_Types].xml', data: Buffer.from(contentTypes(), 'utf8') })
  entries.push({ name: '_rels/.rels', data: Buffer.from(rootRels(), 'utf8') })
  entries.push({ name: 'word/document.xml', data: Buffer.from(document, 'utf8') })
  entries.push({ name: 'word/_rels/document.xml.rels', data: Buffer.from(rels, 'utf8') })
  for (const m of media) entries.push({ name: `word/media/${m.name}`, data: m.data })

  void source
  return writeZip(entries)
}

function contentTypes() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  )
}

function rootRels() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  )
}

/** 从真实需求单里取第 n 张图（借助 zip.js 读） */
let sourceMedia = null
function readSourceImage(n) {
  if (!sourceMedia) {
    const { readZip } = requireZip()
    const zip = readZip(fs.readFileSync(SOURCE))
    sourceMedia = zip.entries
      .filter((e) => e.name.startsWith('word/media/'))
      .map((e) => e.data)
  }
  return sourceMedia[(n - 1) % sourceMedia.length]
}

let zipModule = null
function requireZip() {
  if (!zipModule) {
    // 顶层 await 不可用时的同步替代：用 createRequire 加载 ESM 不行，这里直接复用已导入的 writeZip 所在模块
    zipModule = { readZip: readZipSync }
  }
  return zipModule
}

// 同步读取 zip（与 lib/zip.js 同一实现，用子进程不可行，这里用简单实现）
import { readZip } from '../lib/zip.js'
function readZipSync(buffer) {
  return readZip(buffer)
}

function ok(label, condition, extra = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!condition) process.exitCode = 1
}

const templateBuffer = fs.readFileSync(TEMPLATE)
const info = inspectTemplate(templateBuffer)

/* 1) 3 张图 */
const docx3 = makeDocx(3)
fs.writeFileSync(path.join(WORK, 'three.docx'), docx3)
const three = extractImages(docx3, 'three.docx')
ok('3 张图的 docx', three.items.length === 3, `实得 ${three.items.length} 张`)
ok('上下文文字正确', three.items[0] && three.items[0].context === 'CAP-1', three.items[0] && three.items[0].context)

/* 2) 30 张图 */
const docx30 = makeDocx(30)
fs.writeFileSync(path.join(WORK, 'thirty.docx'), docx30)
const thirty = extractImages(docx30, 'thirty.docx')
ok('30 张图的 docx', thirty.items.length === 30, `实得 ${thirty.items.length} 张`)

const filled = fillTemplate(templateBuffer, thirty.items, {
  sheetPartPath: info.sheetPartPath,
  targetColumn: info.targetColumn,
  mergeEndColumn: info.mergeEndColumn,
  dataStartRow: info.dataStartRow,
  columns: info.columns,
  defaultColWidth: info.defaultColWidth,
  rowHeights: info.rowHeights,
})
const out30 = path.join(WORK, 'thirty-output.xlsx')
fs.writeFileSync(out30, filled.buffer)
ok('30 张写入第 3~32 行', filled.firstRow === 3 && filled.lastRow === 32, `${filled.firstRow}~${filled.lastRow}`)

/* 2.5 输出里不能留空占位框：锚点数 = 写入张数，且每个锚点都得有真实图片引用 */
{
  const { byName } = readZip(filled.buffer)
  let drawingXml = ''
  let mediaCount = 0
  for (const [name, data] of byName) {
    if (/^xl\/drawings\/drawing\d+\.xml$/.test(name)) drawingXml = data.toString('utf8')
    if (name.startsWith('xl/media/')) mediaCount += 1
  }
  const anchors = (drawingXml.match(/<xdr:(oneCellAnchor|twoCellAnchor)\b/g) || []).length
  const withBlip = (drawingXml.match(/<a:blip\b[^>]*r:embed=/g) || []).length
  ok('输出里没有空占位框', anchors === thirty.items.length && withBlip === anchors, `锚点 ${anchors} / 带图引用 ${withBlip} / 写入 ${thirty.items.length}`)
  ok('图片文件数与写入数一致', mediaCount === thirty.items.length, `${mediaCount} 个`)
}

/* 3) 以 xlsx 作为源 */
const xlsxSource = path.resolve('.tmp', 'server-test-output.xlsx')
if (fs.existsSync(xlsxSource)) {
  const fromXlsx = extractImages(fs.readFileSync(xlsxSource), 'xlsx-source.xlsx')
  ok('xlsx 作为源可提取', fromXlsx.items.length === 19, `实得 ${fromXlsx.items.length} 张`)
  const rows = fromXlsx.items.map((it) => it.row)
  const sorted = [...rows].sort((a, b) => a - b)
  ok('按行排序（自上而下）', JSON.stringify(rows) === JSON.stringify(sorted), `行号 ${rows.slice(0, 5).join(',')}…`)
  ok('锚定在 F 列', fromXlsx.items.every((it) => it.col === 6), `列 ${fromXlsx.items[0] && fromXlsx.items[0].col}`)
} else {
  console.log('（跳过 xlsx 源测试：先跑 servertest.mjs 生成样本）')
}

console.log('\n输出文件：', out30)
