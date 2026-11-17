/**
 * 模版自动找回测试
 *   ① 配置路径存在 → 直接用它
 *   ② 配置路径不存在（模版被改名/删掉）→ 同目录按内容自动找回
 *   ③ 同目录里已写过图的导出件 → 不会被误当成空模版
 *
 * 用法：node scripts/templatetest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'
import { pickPath, needSample } from './paths.mjs'

const REAL_TEMPLATE =
  pickPath(process.argv[2], ['TEMPLATE_XLSX'])
const FILLED_SAMPLE =
  pickPath(process.argv[3], ['OUTPUT_XLSX']) || path.join(process.cwd(), '.tmp', '结构式输出.xlsx')

let failed = 0
function ok(label, condition, extra = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!condition) failed += 1
}

const workDir = path.resolve('.tmp', 'template-test-work')
fs.rmSync(workDir, { recursive: true, force: true })
fs.mkdirSync(workDir, { recursive: true })

/* 造一个"改名后的模版"和一份"已填过图的导出件" */
const renamed = path.join(workDir, '模版副本_改名了.xlsx')
fs.copyFileSync(REAL_TEMPLATE, renamed)
if (fs.existsSync(FILLED_SAMPLE)) {
  fs.copyFileSync(FILLED_SAMPLE, path.join(workDir, '已经填过图的表.xlsx'))
}
const missing = path.join(workDir, '原来的名字已经不存在.xlsx')

let handler = null
const ctx = {
  effect(fn) {
    return fn()
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(spec) {
          handler = spec.handler
        },
      }
    }
    return undefined
  },
}

apply(ctx, { defaultTemplatePath: missing, workDir })

function call(route, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = `/inquiry-structure/api/${route}`
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(payload) {
        try {
          resolve(JSON.parse(payload))
        } catch (error) {
          reject(new Error(`返回不是 JSON：${payload}`))
        }
      },
    }
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body || {}), 'utf8'))
      req.emit('end')
    })
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const defaults = (await call('defaults', {})).data
ok('模版不在原位置时能自动找回', defaults.defaultTemplateExists === true, defaults.defaultTemplatePath)
ok('自动找回时标记为 fallback', defaults.defaultTemplateFallback === true)
ok('找回的是改名后的那份空模版', path.basename(defaults.defaultTemplatePath) === path.basename(renamed), path.basename(defaults.defaultTemplatePath))
ok('没有误选已填过图的导出件', !/已经填过图的表/.test(defaults.defaultTemplatePath))

const inspect = await call('template.inspect', { templatePath: defaults.defaultTemplatePath })
ok('自动找回的模版可正常识别结构式列', inspect.ok === true && /结构式/.test(inspect.data.summary), inspect.ok ? inspect.data.summary : inspect.error)

/* 生成时界面不指定模版 —— 服务端必须自己用自动找回的那份，不能报"找不到模版文件" */
const SOURCE = needSample(pickPath(process.argv[4], ['SAMPLE_DOCX']), '源文件', '命令行参数或 SAMPLE_DOCX 环境变量')
if (fs.existsSync(SOURCE)) {
  const src = fs.readFileSync(SOURCE)
  const CHUNK = 64 * 1024
  const total = Math.ceil(src.length / CHUNK)
  let fileId = ''
  for (let i = 0; i < total; i += 1) {
    const start = i * CHUNK
    const end = Math.min(start + CHUNK, src.length)
    const res = await call('upload', {
      name: path.basename(SOURCE),
      size: src.length,
      chunkSize: CHUNK,
      index: i,
      total,
      data: src.subarray(start, end).toString('base64'),
      fileId,
    })
    if (!fileId) fileId = res.data.fileId
  }
  const filled = await call('fill', { sourceFileId: fileId, indexes: [0] })
  ok(
    '生成时自动用找回的模版（不报找不到模版）',
    filled.ok === true && path.basename(filled.data.templatePath) === path.basename(renamed),
    filled.ok ? filled.data.templatePath : filled.error,
  )
}

/* 配置路径存在时应直接使用 */
let handler2 = null
const ctx2 = {
  effect(fn) {
    return fn()
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(spec) {
          handler2 = spec.handler
        },
      }
    }
    return undefined
  },
}
apply(ctx2, { defaultTemplatePath: REAL_TEMPLATE, workDir })
const call2 = (route, body) =>
  new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = `/inquiry-structure/api/${route}`
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(payload) {
        try {
          resolve(JSON.parse(payload))
        } catch (error) {
          reject(new Error(`返回不是 JSON：${payload}`))
        }
      },
    }
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body || {}), 'utf8'))
      req.emit('end')
    })
    Promise.resolve(handler2(req, res)).catch(reject)
  })
const d2 = (await call2('defaults', {})).data
ok('配置路径存在时直接使用', d2.defaultTemplatePath === REAL_TEMPLATE && d2.defaultTemplateFallback === false)

console.log(failed ? `\n模版找回测试：${failed} 项失败` : '\n模版找回测试：全部通过')
if (failed) process.exitCode = 1
