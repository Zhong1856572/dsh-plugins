/**
 * 本地自测：用真实文件跑一遍「提取 → 写模版」
 * 用法：node scripts/selftest.mjs [源文件] [模版] [输出文件]
 */

import fs from 'node:fs'
import path from 'node:path'
import { extractImages } from '../lib/extract.js'
import { inspectTemplate, fillTemplate } from '../lib/template.js'
import { pickPath, needSample } from './paths.mjs'

const source = needSample(pickPath(process.argv[2], ['SAMPLE_DOCX']), '源文件', '命令行参数或 SAMPLE_DOCX 环境变量')
const templatePath = needSample(pickPath(process.argv[3], ['TEMPLATE_XLSX']), '模版', '命令行参数或 TEMPLATE_XLSX 环境变量')
const outputPath = process.argv[4] || path.join(process.cwd(), '.tmp', '结构式输出.xlsx')

const srcBuffer = fs.readFileSync(source)
const tplBuffer = fs.readFileSync(templatePath)

console.log('源文件：', source)
console.log('模版：', templatePath)

const { kind, items } = extractImages(srcBuffer, source)
console.log(`\n[1] 提取完成：类型=${kind}，共 ${items.length} 张图`)
items.slice(0, 5).forEach((it) => {
  console.log(
    `    #${it.index + 1} ${it.name} ${it.width}x${it.height}px ${(it.bytes.length / 1024).toFixed(1)}KB` +
      ` 比例=${it.extentCx ? (it.extentCx / it.extentCy).toFixed(2) : '—'} 上下文="${it.context.slice(0, 60)}"`,
  )
})
if (items.length > 5) console.log(`    … 其余 ${items.length - 5} 张略`)

const info = inspectTemplate(tplBuffer)
console.log('\n[2] 模版识别：')
console.log(`    工作表=${info.sheetName} 目标列=${info.targetColumnLetter}（${info.targetTitle}）`)
console.log(`    表头行=${info.headerRow} 起始行=${info.dataStartRow} 合并到=${info.mergeEndColumnLetter} 可用行=${info.availableRows}`)

const result = fillTemplate(tplBuffer, items, {
  sheetPartPath: info.sheetPartPath,
  targetColumn: info.targetColumn,
  mergeEndColumn: info.mergeEndColumn,
  dataStartRow: info.dataStartRow,
  columns: info.columns,
  defaultColWidth: info.defaultColWidth,
  rowHeights: info.rowHeights,
})

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, result.buffer)
console.log(`\n[3] 写入完成：${result.written} 张，行 ${result.firstRow}~${result.lastRow}`)
console.log('    输出：', outputPath, `(${(result.buffer.length / 1024).toFixed(1)}KB)`)
