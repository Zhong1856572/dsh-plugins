/**
 * 取参助手：源文件 / 模版路径只从命令行参数或环境变量取，
 * 仓库里不写死任何本机路径，也不写死任何业务文件名。
 *
 *   源文件：命令行第一个参数，或环境变量 SAMPLE_DOCX
 *   模版：  命令行第二个参数，或环境变量 TEMPLATE_XLSX
 */
import fs from 'node:fs'
import path from 'node:path'

/** 依次尝试 参数 → 环境变量 → 空 */
export function pickPath(argValue, envNames) {
  const fromArg = String(argValue || '').trim()
  if (fromArg) return path.resolve(fromArg)
  for (const name of envNames) {
    const value = String(process.env[name] || '').trim()
    if (value) return path.resolve(value)
  }
  return ''
}

/** 缺样例文件时给出提示并正常退出（跳过而不是判失败） */
export function needSample(resolved, label, hint) {
  if (resolved && fs.existsSync(resolved)) return resolved
  console.log(`跳过：没有可用的${label}（${hint}），本机没有样例文件就不跑这条用例。`)
  process.exit(0)
}
