/**
 * 上传链路回归测试（专测「上传失败」那一类问题）
 *
 * ① 客户端：从 client.js 里原样抽出 uploadFile 跑一遍，断言
 *    整个文件只建一个会话（只有一个请求带空 fileId，其余都带同一个 fileId）。
 * ② 服务端：4 个并发线程共享一个会话上传真实 docx，断言能抽取出 19 张图。
 * ③ 服务端：旧写法（每个线程各建会话）必须被判为未完成，不能放行残缺文件。
 *
 * 用法：node scripts/uploadtest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'
import { pickPath, needSample } from './paths.mjs'

const SOURCE = needSample(pickPath(process.argv[2], ['SAMPLE_DOCX']), '源文件', '命令行参数或 SAMPLE_DOCX 环境变量')
const CHUNK = 32 * 1024

let failed = 0
function ok(label, condition, extra = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!condition) failed += 1
}

/* ================================================================== *
 * ① 客户端：只建一个会话
 * ================================================================== */
function extractUploadFn(code) {
  const marker = 'const uploadFile = useCallback('
  const start = code.indexOf(marker)
  if (start < 0) throw new Error('client.js 里找不到 uploadFile')
  const braceAt = code.indexOf('{', code.indexOf('async (file) =>', start))
  let depth = 0
  let end = -1
  for (let i = braceAt; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error('uploadFunction 括号不匹配')
  const tail = code.slice(end + 1)
  const close = tail.indexOf(')')
  return code.slice(start, end + 1 + close + 1)
}

const clientCode = fs.readFileSync(path.resolve('client.js'), 'utf8')
const calls = []
const sandbox = {
  useCallback: (fn) => fn,
  CHUNK_BYTES: CHUNK,
  bufferToBase64: (buf) => Buffer.from(buf).toString('base64'),
  apiPost: async (route, body) => {
    calls.push({ route, index: body.index, fileId: body.fileId, len: body.data.length })
    return { fileId: 'SESSION-A', done: true }
  },
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(
  `${extractUploadFn(clientCode)}\n;globalThis.__uploadFile = uploadFile;`,
  sandbox,
  { filename: 'client.js' },
)

const fakeFile = {
  name: '测试需求单.docx',
  size: 327097,
  slice(start, end) {
    const len = Math.max(0, Math.min(end, this.size) - start)
    const buf = Buffer.alloc(len, 0x41)
    return {
      async arrayBuffer() {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      },
    }
  },
}

const gotFileId = await sandbox.__uploadFile(fakeFile)
const emptySessions = calls.filter((c) => !c.fileId)
const ids = new Set(calls.map((c) => c.fileId))
const indexes = calls.map((c) => c.index).sort((a, b) => a - b)
const expectedIndexes = Array.from({ length: Math.ceil(fakeFile.size / CHUNK) }, (_, i) => i)

ok('客户端：请求数等于分片数', calls.length === expectedIndexes.length, `${calls.length} / ${expectedIndexes.length}`)
ok('客户端：只有一个请求带空 fileId（只建一个会话）', emptySessions.length === 1, `${emptySessions.length} 个`)
ok('客户端：其余请求共用同一个 fileId', ids.size === 2 && ids.has('SESSION-A'), [...ids].join(' | '))
ok('客户端：分片序号不重不漏', indexes.join(',') === expectedIndexes.join(','))
ok('客户端：返回共享的 fileId', gotFileId === 'SESSION-A', String(gotFileId))

/* ================================================================== *
 * ② / ③ 服务端：并发共享会话 / 旧写法必须失败
 * ================================================================== */
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
apply(ctx, { workDir: path.resolve('.tmp', 'upload-test-work') })

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

const bytes = fs.readFileSync(SOURCE)
const total = Math.ceil(bytes.length / CHUNK)
const chunkOf = (index) => bytes.subarray(index * CHUNK, Math.min(bytes.length, (index + 1) * CHUNK))
const name = path.basename(SOURCE)

/* --- ② 4 个并发线程共享一个会话（修复后的写法） --- */
{
  let fileId = ''
  const first = await call('upload', {
    name,
    size: bytes.length,
    chunkSize: CHUNK,
    index: 0,
    total,
    data: chunkOf(0).toString('base64'),
    fileId: '',
  })
  fileId = first.data.fileId
  let next = 1
  const workers = []
  const runOne = async () => {
    for (;;) {
      const current = next
      if (current >= total) return
      next = current + 1
      await call('upload', {
        name,
        size: bytes.length,
        chunkSize: CHUNK,
        index: current,
        total,
        data: chunkOf(current).toString('base64'),
        fileId,
      })
    }
  }
  for (let i = 0; i < 4; i += 1) workers.push(runOne())
  await Promise.all(workers)

  const ex = await call('extract', { fileId })
  ok('服务端：并发共享会话可完成上传并提取', ex.ok === true && ex.data.count === 19, ex.ok ? `${ex.data.count} 张` : ex.error)
}

/* --- ③ 旧写法：每个线程各建会话，必须被判为未完成 --- */
{
  let next = 0
  const ids2 = []
  const workers = []
  const runOne = async () => {
    for (;;) {
      const current = next
      if (current >= total) return
      next = current + 1
      const res = await call('upload', {
        name,
        size: bytes.length,
        chunkSize: CHUNK,
        index: current,
        total,
        data: chunkOf(current).toString('base64'),
        fileId: '',
      })
      ids2.push(res.ok ? res.data.fileId : '')
    }
  }
  for (let i = 0; i < 4; i += 1) workers.push(runOne())
  await Promise.all(workers)
  const sessions = new Set(ids2)
  ok('服务端：旧写法会拆出多个会话（这正是故障成因）', sessions.size > 1, `${sessions.size} 个会话`)
  const ex = await call('extract', { fileId: ids2[ids2.length - 1] })
  ok('服务端：残缺会话不会被当成上传成功', ex.ok === false && /尚未上传完成|失效/.test(String(ex.error)), String(ex.error))
}

console.log(failed ? `\n上传链路测试：${failed} 项失败` : '\n上传链路测试：全部通过')
if (failed) process.exitCode = 1
