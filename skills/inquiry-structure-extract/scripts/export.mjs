#!/usr/bin/env node
/**
 * 询单结构式提取与回填（命令行）
 *
 * 用法：
 *   node scripts/export.mjs <源文件.docx|.xlsx> [输出目录] [文件名] [--template <模版路径>]
 *
 * 模版路径的取法（优先级从高到低）：
 *   1. --template 参数
 *   2. 环境变量 TEMPLATE_XLSX
 *   3. 默认 <USER_HOME>\Desktop\业务咨询货号申请表.xlsx
 *
 * 行为：
 *   · 把源文件里全部图片按「文档从上到下」的顺序提取出来
 *   · 逐张写入模版里那列「结构式」列（表头写着「结构式」或「结构式/产品信息」），
 *     从数据首行开始一行一张，图按比例缩放并居中在合并单元格内
 *   · 行数不够时自动扩展表格行
 *   · 源文件只读、模版不覆盖，产物是一份新的 xlsx
 *
 * 纯 Node 实现，不依赖任何第三方包。
 */

import fs from 'node:fs'
import path from 'node:path'
import { extractImages } from './lib/extract.js'
import { inspectTemplate, fillTemplate } from './lib/template.js'

const DEFAULT_TEMPLATE = process.env.TEMPLATE_XLSX || '<USER_HOME>\\Desktop\\业务咨询货号申请表.xlsx'

function usage() {
  console.log(`用法：node scripts/export.mjs <源文件.docx|.xlsx> [输出目录] [文件名] [--template <模版路径>]

例：
  node scripts/export.mjs "需求单.docx" "<USER_HOME>\\Desktop"
  node scripts/export.mjs "需求单.docx" "<USER_HOME>\\Desktop" "结构式_导出.xlsx"
  node scripts/export.mjs "需求单.docx" --template "D:/模版/申请表.xlsx"

模版路径优先级：--template > 环境变量 TEMPLATE_XLSX > 默认路径`)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  usage()
  process.exit(argv.length === 0 ? 2 : 0)
}

const positional = argv.filter((value, index, all) => {
  if (value.startsWith('--')) return false
  const prev = all[index - 1]
  return !(prev && prev.startsWith('--'))
})

const sourceArg = positional[0]
if (!sourceArg) {
  usage()
  process.exit(2)
}

const sourcePath = path.resolve(sourceArg)
const outputDir = path.resolve(positional[1] || path.dirname(sourcePath))
const templatePath = path.resolve(argValue('--template') || DEFAULT_TEMPLATE)

if (!fs.existsSync(sourcePath)) {
  console.error(`源文件不存在：${sourcePath}`)
  process.exit(2)
}
if (!fs.existsSync(templatePath)) {
  console.error(`模版不存在：${templatePath}`)
  console.error('请用 --template 指定模版，或设置环境变量 TEMPLATE_XLSX。模版要求见 references/template-requirements.md')
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
if (!info.targetColumn) {
  console.error('模版里找不到「结构式」列，请检查模版表头')
  process.exit(1)
}

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
let name = path.basename(positional[2] || autoName)
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
