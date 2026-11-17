/**
 * 命令行导出（桌面端工作台不可用时的备选通道）
 *
 * 用法：
 *   node scripts/export.mjs <源文件.docx|.xlsx> [输出目录] [文件名] [--template <模版路径>]
 *
 * 例：
 *   node scripts/export.mjs "需求单.docx" "<USER_HOME>\Desktop"
 *   node scripts/export.mjs "需求单.docx" "<USER_HOME>\Desktop" "结构式_导出.xlsx"
 *
 * 行为与工作台一致：按文档从上到下提取全部图片，逐张写入固定模版的「结构式/产品信息」列，
 * 生成一份新的 xlsx（绝不覆盖模版本身）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractImages } from '../lib/extract.js'
import { inspectTemplate, fillTemplate } from '../lib/template.js'

/** 模版路径：--template > 环境变量 TEMPLATE_XLSX > 默认桌面上的固定模版 */
const DEFAULT_TEMPLATE = process.env.TEMPLATE_XLSX || '<USER_HOME>\\Desktop\\业务咨询货号申请表.xlsx'

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

const positional = process.argv.slice(2).filter((value, index, all) => {
  if (value.startsWith('--')) return false
  const prev = all[index - 1]
  return !(prev && prev.startsWith('--'))
})

const sourceArg = positional[0]
if (!sourceArg) {
  console.error('用法：node scripts/export.mjs <源文件.docx|.xlsx> [输出目录] [文件名] [--template <模版路径>]')
  process.exit(2)
}

const sourcePath = path.resolve(sourceArg)
const outputDir = path.resolve(positional[1] || path.dirname(sourcePath))
const templatePath = path.resolve(arg('--template') || DEFAULT_TEMPLATE)

if (!fs.existsSync(sourcePath)) {
  console.error(`源文件不存在：${sourcePath}`)
  process.exit(2)
}
if (!fs.existsSync(templatePath)) {
  console.error(`模版不存在：${templatePath}`)
  process.exit(2)
}
if (!fs.existsSync(outputDir)) {
  console.error(`输出目录不存在：${outputDir}`)
  process.exit(2)
}

const { items } = extractImages(fs.readFileSync(sourcePath), path.basename(sourcePath))
if (!items.length) {
  console.error('这个文件里没有提取到任何图片')
  process.exit(1)
}

const templateBuffer = fs.readFileSync(templatePath)
const info = inspectTemplate(templateBuffer)
const result = fillTemplate(templateBuffer, items, {
  sheetPartPath: info.sheetPartPath,
  targetColumn: info.targetColumn,
  mergeEndColumn: info.mergeEndColumn,
  dataStartRow: info.dataStartRow,
  columns: info.columns,
  defaultColWidth: info.defaultColWidth,
  rowHeights: info.rowHeights,
})

const stamp = new Date()
const pad = (n) => String(n).padStart(2, '0')
const autoName = `结构式_导出_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}.xlsx`
let name = positional[2] || autoName
name = path.basename(name)
if (!/\.xlsx$/i.test(name)) name += '.xlsx'

let target = path.join(outputDir, name)
for (let n = 2; n < 100 && fs.existsSync(target); n += 1) {
  target = path.join(outputDir, name.replace(/\.xlsx$/i, ` (${n}).xlsx`))
}
if (path.resolve(target).toLowerCase() === path.resolve(templatePath).toLowerCase()) {
  console.error('不能覆盖模版文件本身，请换一个文件名')
  process.exit(2)
}

fs.writeFileSync(target, result.buffer)
const bytes = fs.statSync(target).size
if (bytes !== result.buffer.length) {
  console.error(`落盘校验不一致：应为 ${result.buffer.length} 字节，实际 ${bytes} 字节`)
  process.exit(1)
}

console.log(`源文件：${sourcePath}`)
console.log(`模版：  ${templatePath}`)
console.log(`提取：  ${items.length} 张图片 → 第 ${result.firstRow}~${result.lastRow} 行（${info.targetColumn} 列「${info.targetTitle}」）`)
console.log(`输出：  ${target}  (${(bytes / 1024).toFixed(1)}KB)`)
