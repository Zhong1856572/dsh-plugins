/**
 * 服务端路由自测：不起真实 HTTP，直接把 handler 跑一遍
 * 流程：分片上传 → 提取 → 取预览 → 读模版 → 生成
 * 用法：node scripts/servertest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'
import { pickPath, needSample } from './paths.mjs'

const SOURCE = needSample(pickPath(process.argv[2], ['SAMPLE_DOCX']), '源文件', '命令行参数或 SAMPLE_DOCX 环境变量')
const TEMPLATE = needSample(pickPath(process.argv[3], ['TEMPLATE_XLSX']), '模版', '命令行参数或 TEMPLATE_XLSX 环境变量')
const OUTPUT = path.resolve('.tmp', 'server-test-output.xlsx')
const CHUNK = 32 * 1024

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

apply(ctx, {
  defaultTemplatePath: TEMPLATE,
  workDir: path.resolve('.tmp', 'server-work'),
})

if (!handler) {
  console.error('✗ webServer 路由没有注册')
  process.exit(1)
}

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
        let json = {}
        try {
          json = JSON.parse(payload)
        } catch (error) {
          reject(new Error(`返回不是 JSON：${payload}`))
          return
        }
        resolve(json)
      },
    }
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body || {}), 'utf8'))
      req.emit('end')
    })
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

function ok(label, condition, extra = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!condition) process.exitCode = 1
}

async function main() {
  console.log('— ① 分片上传 —')
  const buffer = fs.readFileSync(SOURCE)
  const total = Math.max(1, Math.ceil(buffer.length / CHUNK))
  let fileId = ''
  for (let index = 0; index < total; index += 1) {
    const slice = buffer.subarray(index * CHUNK, Math.min(buffer.length, (index + 1) * CHUNK))
    const res = await call('upload', {
      name: path.basename(SOURCE),
      size: buffer.length,
      chunkSize: CHUNK,
      index,
      total,
      data: slice.toString('base64'),
      fileId,
    })
    if (!res.ok) throw new Error(res.error)
    fileId = res.data.fileId
  }
  ok('上传完成', !!fileId, `fileId=${fileId.slice(0, 8)}… 共 ${total} 个分片`)

  console.log('\n— ② 提取图片 —')
  const extracted = await call('extract', { fileId })
  ok('提取成功', extracted.ok, extracted.ok ? `${extracted.data.count} 张` : extracted.error)
  ok('顺序正确', extracted.data.items.every((it, i) => it.index === i))

  console.log('\n— ③ 取单张预览 —')
  const preview = await call('preview', { fileId, index: 0 })
  ok('预览可取', preview.ok && String(preview.data.dataUrl).startsWith('data:image/'), preview.ok ? `${preview.data.width}×${preview.data.height}` : preview.error)

  console.log('\n— ④ 读模版 —')
  const tpl = await call('template.inspect', { templatePath: TEMPLATE })
  ok('模版识别', tpl.ok, tpl.ok ? tpl.data.summary : tpl.error)

  console.log('\n— ⑤ 生成 —')
  const indexes = extracted.data.items.map((it) => it.index)
  const filled = await call('fill', {
    sourceFileId: fileId,
    indexes,
    templatePath: TEMPLATE,
    outputPath: OUTPUT,
  })
  ok('生成成功', filled.ok, filled.ok ? `${filled.data.written} 张 → ${filled.data.outputPath}` : filled.error)
  if (filled.ok) {
    const size = fs.statSync(filled.data.outputPath).size
    ok('输出文件存在', size > 0, `${(size / 1024).toFixed(1)}KB`)
  }

  console.log('\n— ⑤b 另存为链路 —')
  /* 用户在系统目录选择器里选了目录：服务端直接写进去 */
  const pickedDir = path.resolve('.tmp', 'picked-dir')
  fs.rmSync(pickedDir, { recursive: true, force: true })
  fs.mkdirSync(pickedDir, { recursive: true })
  const picked = await call('fill', {
    sourceFileId: fileId,
    indexes,
    templatePath: TEMPLATE,
    outputDir: pickedDir,
    filename: '结构式_导出_测试.xlsx',
  })
  ok('指定目录时直接写进该目录', picked.ok && path.dirname(picked.data.outputPath) === pickedDir && fs.existsSync(picked.data.outputPath), picked.ok ? picked.data.outputPath : picked.error)
  /* 同名文件不静默覆盖：自动加序号 */
  const pickedAgain = await call('fill', {
    sourceFileId: fileId,
    indexes,
    templatePath: TEMPLATE,
    outputDir: pickedDir,
    filename: '结构式_导出_测试.xlsx',
  })
  ok(
    '同名文件不覆盖，自动加序号',
    pickedAgain.ok && /结构式_导出_测试 \(2\)\.xlsx$/.test(pickedAgain.data.outputPath) && fs.existsSync(pickedAgain.data.outputPath),
    pickedAgain.ok ? pickedAgain.data.outputName : pickedAgain.error,
  )
  /* 落盘字节数必须与生成结果一致 */
  if (picked.ok) {
    const size = fs.statSync(picked.data.outputPath).size
    ok('落盘字节数与生成结果一致', size === picked.data.size, `${size} / ${picked.data.size}`)
  }
  /* 不给输出位置：先落在工作目录，界面上把路径给出来 */
  const staged = await call('fill', { sourceFileId: fileId, indexes, templatePath: TEMPLATE })
  ok('不给路径时先生成到工作目录', staged.ok && staged.data.outputPath && fs.existsSync(staged.data.outputPath), staged.ok ? staged.data.outputPath : staged.error)

  /* 界面不再指定模版：服务端必须自己按"配置的路径 → 自动找回"解析出来 */
  const autoTpl = await call('fill', { sourceFileId: fileId, indexes: [0] })
  ok('不传模版时由服务端固定解析', autoTpl.ok && autoTpl.data.templatePath === TEMPLATE, autoTpl.ok ? autoTpl.data.templatePath : autoTpl.error)

  console.log('\n— ⑥ 异常路径 —')
  const noPick = await call('fill', { sourceFileId: fileId, indexes: [], templatePath: TEMPLATE })
  ok('未勾选时给出中文提示', !noPick.ok && /勾选/.test(noPick.error), noPick.error)
  const badPath = await call('fill', {
    sourceFileId: fileId,
    indexes: [0],
    templatePath: TEMPLATE,
    outputPath: path.resolve('.tmp/no-such-dir-xyz/out.xlsx'),
  })
  ok('输出目录不存在时拒绝写入', !badPath.ok && /输出目录/.test(badPath.error), badPath.error)
  const overwrite = await call('fill', {
    sourceFileId: fileId,
    indexes: [0],
    templatePath: TEMPLATE,
    outputPath: TEMPLATE,
  })
  ok('拒绝覆盖模版本身', !overwrite.ok && /不能覆盖/.test(overwrite.error), overwrite.error)
  const badRoute = await call('nope', {})
  ok('未知路由返回 404', badRoute.ok === false)
}

main().catch((error) => {
  console.error('✗ 自测异常：', error)
  process.exit(1)
})
