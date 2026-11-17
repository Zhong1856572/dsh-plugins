/**
 * @local/inquiry-structure-workbench —— 询单结构式助手 · 服务端（Node ESM）
 * ---------------------------------------------------------------------------
 * 职责：
 *   · 接收用户选中的 Word / Excel（分片上传），在本机解析；
 *   · 按文档从上到下抽出图片，交给前端预览与勾选；
 *   · 把勾选后的图片按顺序写进固定模版的「结构式/产品信息」列，导出新的 xlsx。
 *
 * 全程只在本机内存与本机磁盘之间流转，不上传任何外部服务。
 *
 * 路由（前缀 /inquiry-structure/api）：
 *   POST /defaults        { }                        → 默认模版位置
 *   POST /upload          { name,size,chunkSize,index,total,data } → 分片上传
 *   POST /extract         { fileId }                 → 图片清单（不含图片体）
 *   POST /preview         { fileId, index }          → 单张图片（base64 dataURL）
 *   POST /template.inspect{ path? , fileId? }        → 模版结构（目标列/起始行/行数）
 *   POST /fill            { sourceFileId, indexes[], templatePath?|templateFileId?, outputPath? }
 *   POST /reveal          { path }                   → 在文件管理器中定位
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { extractImages } from './lib/extract.js'
import { fillTemplate, inspectTemplate } from './lib/template.js'
import { readZip } from './lib/zip.js'

/** Cordis 依赖注入：只要 Web 服务器服务。 */
export const inject = ['webServer']

const PLUGIN_ID = 'inquiry-structure-workbench'
const PLUGIN_VERSION = '1.0.5'
/** 构建标记：客户端拿它跟自己比，不一致就说明桌面端没重启（跑的是旧界面） */
const PLUGIN_BUILD = '1.0.5-20261117'
/** 本服务端要求的最低客户端构建号（客户端行为没变时保持旧值，避免误报"请重启"） */
const CLIENT_BUILD_REQUIRED = '1.0.5-20261117'
const API_PREFIX = '/inquiry-structure/api'

/** 默认配置（cordis.patch.yml 会覆盖同名键） */
export const DEFAULTS = {
  /** 默认固定模版；改名/移走时会在同目录按内容自动找回
   *  支持占位符：<USER_HOME> → 当前用户家目录（发布版用它避免写死本机路径） */
  defaultTemplatePath: '<USER_HOME>\\Desktop\\业务咨询货号申请表.xlsx',
  /** 默认输出目录（留空 = 模版所在目录） */
  defaultOutputDir: '',
  /** 工作目录（留空 = 系统临时目录下的 inquiry-structure-workbench） */
  workDir: '',
  /** 单个上传分片上限（字节，客户端据此切分） */
  maxChunkBytes: 262144,
}

/**
 * 展开路径里的占位符。
 * 发布版把本机路径脱敏成 <USER_HOME>，装到别人机器上时要还原成对方的家目录。
 * @param {string} value
 * @returns {string}
 */
function expandPlaceholders(value) {
  if (!value) return value
  let out = value
  if (out.includes('<USER_HOME>')) {
    out = out.split('<USER_HOME>').join(os.homedir())
  }
  if (out.includes('<WORKBUDDY_HOME>')) {
    out = out.split('<WORKBUDDY_HOME>').join(path.join(os.homedir(), '.workbuddy'))
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(body)
  } catch (error) {
    try {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
    } catch (_) {
      /* 忽略 */
    }
  }
}

function readJsonBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function safeName(name) {
  return (
    str(name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'file'
  )
}

function defaultWorkDir(config) {
  const configured = str(config.workDir).trim()
  if (configured) return configured
  return path.join(os.tmpdir(), 'inquiry-structure-workbench')
}

/* ------------------------------------------------------------------ *
 * 上传会话
 * ------------------------------------------------------------------ */

function createSessions(workDir) {
  const sessions = new Map()
  const uploadDir = path.join(workDir, 'uploads')
  try {
    fs.mkdirSync(uploadDir, { recursive: true })
  } catch (_) {
    /* 忽略 */
  }

  function partPath(id) {
    return path.join(uploadDir, `${id}.part`)
  }
  function finalPath(id, name) {
    return path.join(uploadDir, `${id}__${safeName(name)}`)
  }

  return {
    sessions,
    uploadDir,
    /**
     * 追加一个分片。
     * @returns {{done: boolean, fileId: string, path: string, size: number, name: string}}
     */
    append(body) {
      const name = safeName(body.name)
      const size = Number(body.size) || 0
      const chunkSize = Number(body.chunkSize) || 0
      const index = Number(body.index) || 0
      const total = Number(body.total) || 1
      const data = str(body.data)
      if (!data) throw new Error('分片内容为空')

      let fileId = str(body.fileId)
      if (!fileId) {
        fileId = crypto.randomBytes(12).toString('hex')
        sessions.set(fileId, {
          id: fileId,
          name,
          size,
          total,
          received: 0,
          chunks: new Set(),
        })
      }
      const session = sessions.get(fileId)
      if (!session) throw new Error('上传会话已失效，请重新选择文件')

      const buffer = Buffer.from(data, 'base64')
      const offset = index * (chunkSize || buffer.length)
      // 注意：'a' 模式会忽略写入位置（O_APPEND），必须用 r+/w+ 才能按分片偏移写；
      // 'w' 会把已有内容截断，新建文件要用不清空的 'w+'。
      const fd = (() => {
        try {
          return fs.openSync(partPath(fileId), 'r+')
        } catch (_) {
          return fs.openSync(partPath(fileId), 'w+')
        }
      })()
      try {
        fs.writeSync(fd, buffer, 0, buffer.length, offset)
      } finally {
        fs.closeSync(fd)
      }
      session.chunks.add(index)
      session.received = session.chunks.size

      // 只有集齐 0..total-1 全部分片才算上传完成
      const expect = session.total || 1
      let complete = session.chunks.size >= expect
      if (complete) {
        for (let i = 0; i < expect; i += 1) {
          if (!session.chunks.has(i)) {
            complete = false
            break
          }
        }
      }
      const done = complete
      if (done) {
        const target = finalPath(fileId, name)
        try {
          fs.renameSync(partPath(fileId), target)
        } catch (error) {
          throw new Error(`保存上传文件失败：${error.message}`)
        }
        // 体积核对：分片缺失或错位时立刻报错，不让残缺文件流到解析环节
        let finalSize = 0
        try {
          finalSize = fs.statSync(target).size
        } catch (_) {
          finalSize = 0
        }
        if (session.size && finalSize !== session.size) {
          try {
            fs.rmSync(target, { force: true })
          } catch (_) {
            /* 忽略 */
          }
          throw new Error(`上传数据不完整（${finalSize}/${session.size} 字节），请重新选择文件`)
        }
        session.path = target
        session.ready = true
      }
      return { done, fileId, path: session.path || '', size: session.size, name: session.name }
    },
    /** 取已上传文件的绝对路径 */
    resolve(fileId) {
      const session = sessions.get(str(fileId))
      if (!session) throw new Error('文件已失效，请重新选择源文件')
      if (session.ready && session.path && fs.existsSync(session.path)) return session.path
      throw new Error('文件尚未上传完成，请重新选择源文件')
    },
    read(fileId) {
      const filePath = this.resolve(fileId)
      return fs.readFileSync(filePath)
    },
  }
}

/* ------------------------------------------------------------------ *
 * 路由实现
 * ------------------------------------------------------------------ */

function buildRuntime(ctx, config) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const workDir = defaultWorkDir(settings)
  const store = createSessions(workDir)

  const defaultTemplatePath = expandPlaceholders(str(settings.defaultTemplatePath).trim())
  const defaultOutputDir = expandPlaceholders(str(settings.defaultOutputDir).trim())

  function templateExists(filePath) {
    try {
      return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    } catch (_) {
      return false
    }
  }

  /* ------------------------------------------------------------------ *
   * 模版自动找回：模版被改名或移走时，按内容在同一目录里找回来
   * ------------------------------------------------------------------ */

  /**
   * 判断这份表是不是"已经写过图"的导出件。
   * 判据：表里有真实图片文件，且结构式列上挂着图片锚点。
   * 注意：空模版可能自带没有图片文件的空锚点（占位框），那仍然算空模版。
   * @param {Buffer} buffer
   * @param {number} colIndex0 目标列的 0 基列号（F 列 = 5）
   */
  function hasImagesInTargetColumn(buffer, colIndex0) {
    try {
      const { byName } = readZip(buffer)
      const hasMedia = [...byName.keys()].some((name) => name.startsWith('xl/media/'))
      if (!hasMedia) return false
      for (const [name, data] of byName) {
        if (!/^xl\/drawings\/drawing\d+\.xml$/.test(name)) continue
        const xml = data.toString('utf8')
        const pattern = new RegExp(`<xdr:col>${colIndex0}</xdr:col>`, 'g')
        if (pattern.test(xml)) return true
      }
    } catch (_) {
      /* 读不出来就当没有 */
    }
    return false
  }

  /** 候选目录：配置路径所在目录 → 输出目录 → 系统桌面 */
  function searchDirs() {
    const dirs = []
    const push = (dir) => {
      if (!dir) return
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return
      } catch (_) {
        return
      }
      if (!dirs.includes(dir)) dirs.push(dir)
    }
    if (defaultTemplatePath) push(path.dirname(defaultTemplatePath))
    if (defaultOutputDir) push(defaultOutputDir)
    push(path.join(os.homedir(), 'Desktop'))
    return dirs
  }

  /**
   * 在候选目录里找一个「有结构式列、且结构式列里没有图」的 xlsx。
   * @returns {{path: string, name: string}|null}
   */
  function findTemplateCandidate() {
    for (const dir of searchDirs()) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (_) {
        continue
      }
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => /\.xlsx?$/i.test(name))
        .filter((name) => !name.startsWith('~$')) // Excel 临时锁文件
        .filter((name) => !name.startsWith('结构式')) // 自己的导出件
        .map((name) => {
          const full = path.join(dir, name)
          let stat = null
          try {
            stat = fs.statSync(full)
          } catch (_) {
            stat = null
          }
          return { path: full, name, size: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0 }
        })
        .filter((item) => item.size > 0 && item.size < 20 * 1024 * 1024)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 12)
      for (const item of files) {
        try {
          const buffer = fs.readFileSync(item.path)
          const info = inspectTemplate(buffer)
          if (!info || !info.targetTitle || !info.targetTitle.includes('结构式')) continue
          if (hasImagesInTargetColumn(buffer, info.targetColumn - 1)) continue
          return { path: item.path, name: item.name }
        } catch (_) {
          continue
        }
      }
    }
    return null
  }

  /** 当前生效的模版：优先配置的路径，否则自动找回 */
  function resolveTemplate() {
    if (defaultTemplatePath && templateExists(defaultTemplatePath)) {
      return { path: defaultTemplatePath, exists: true, fallback: false, configured: defaultTemplatePath }
    }
    const found = findTemplateCandidate()
    if (found) {
      return { path: found.path, exists: true, fallback: true, configured: defaultTemplatePath }
    }
    return { path: defaultTemplatePath, exists: false, fallback: false, configured: defaultTemplatePath }
  }

  /** 读取模版字节：优先按路径，其次按上传文件 */
  function readTemplateBytes(body) {
    const templatePath = expandPlaceholders(str(body.templatePath).trim())
    if (templatePath) {
      if (!templateExists(templatePath)) throw new Error(`找不到模版文件：${templatePath}`)
      return { buffer: fs.readFileSync(templatePath), path: templatePath }
    }
    const templateFileId = str(body.templateFileId).trim()
    if (templateFileId) {
      const filePath = store.resolve(templateFileId)
      return { buffer: fs.readFileSync(filePath), path: filePath }
    }
    const resolved = resolveTemplate()
    if (resolved.exists) {
      return { buffer: fs.readFileSync(resolved.path), path: resolved.path }
    }
    throw new Error('还没有选择固定模版')
  }

  const dispatch = {
    async defaults() {
      const resolved = resolveTemplate()
      return {
        defaultTemplatePath: resolved.path,
        defaultTemplateExists: resolved.exists,
        defaultTemplateFallback: resolved.fallback,
        defaultTemplateConfigured: resolved.configured,
        defaultOutputDir: defaultOutputDir || (resolved.exists ? path.dirname(resolved.path) : ''),
        workDir,
        version: PLUGIN_VERSION,
        build: PLUGIN_BUILD,
        requiresClientBuild: CLIENT_BUILD_REQUIRED,
      }
    },

    async upload(body) {
      return store.append(body)
    },

    async extract(body) {
      const fileId = str(body.fileId)
      const filePath = store.resolve(fileId)
      const buffer = fs.readFileSync(filePath)
      const name = path.basename(filePath)
      const { kind, items } = extractImages(buffer, name)
      return {
        source: { name, kind, size: buffer.length, path: filePath },
        count: items.length,
        items: items.map((item) => ({
          index: item.index,
          name: item.name,
          mime: item.mime,
          width: item.width,
          height: item.height,
          bytes: item.bytes.length,
          context: item.context,
          sheet: item.sheet || '',
          row: item.row || 0,
          col: item.col || 0,
        })),
      }
    },

    async preview(body) {
      const fileId = str(body.fileId)
      const filePath = store.resolve(fileId)
      const buffer = fs.readFileSync(filePath)
      const { items } = extractImages(buffer, path.basename(filePath))
      const index = Number(body.index)
      const item = items.find((it) => it.index === index)
      if (!item) throw new Error(`第 ${index + 1} 张图片不存在`)
      return {
        index: item.index,
        name: item.name,
        mime: item.mime,
        width: item.width,
        height: item.height,
        context: item.context,
        dataUrl: `data:${item.mime};base64,${item.bytes.toString('base64')}`,
      }
    },

    async 'template.inspect'(body) {
      const { buffer, path: templatePath } = readTemplateBytes(body)
      const info = inspectTemplate(buffer)
      return {
        path: templatePath,
        sheetName: info.sheetName,
        targetColumn: info.targetColumnLetter,
        targetTitle: info.targetTitle,
        mergeEndColumn: info.mergeEndColumnLetter,
        headerRow: info.headerRow,
        dataStartRow: info.dataStartRow,
        availableRows: info.availableRows,
        headers: info.headers,
        summary:
          `${info.sheetName} 工作表 · ${info.targetColumnLetter} 列「${info.targetTitle}」` +
          ` · 第 ${info.dataStartRow} 行起 · 模板可放 ${info.availableRows} 张`,
      }
    },

    async fill(body) {
      const sourceFileId = str(body.sourceFileId)
      const filePath = store.resolve(sourceFileId)
      const sourceBuffer = fs.readFileSync(filePath)
      const { items } = extractImages(sourceBuffer, path.basename(filePath))

      const rawIndexes = Array.isArray(body.indexes) ? body.indexes : []
      const indexes = rawIndexes
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b)
      if (!indexes.length) throw new Error('请至少勾选一张结构式')
      const picked = indexes.map((index) => items.find((it) => it.index === index))
      const missing = indexes.filter((index) => !items.find((it) => it.index === index))
      if (missing.length) throw new Error(`有 ${missing.length} 张图片已失效，请重新提取`)

      const { buffer: templateBuffer, path: templatePath } = readTemplateBytes(body)
      const info = inspectTemplate(templateBuffer)

      const result = fillTemplate(templateBuffer, picked, {
        sheetPartPath: info.sheetPartPath,
        targetColumn: info.targetColumn,
        mergeEndColumn: info.mergeEndColumn,
        dataStartRow: info.dataStartRow,
        columns: info.columns,
        defaultColWidth: info.defaultColWidth,
        rowHeights: info.rowHeights,
      })

      /* 输出位置：
       *   ① outputPath —— 明确给了完整路径（用户自己在「另存为」里选的，或脚本/测试用）
       *   ② outputDir —— 用户用系统目录选择器选的目录
       *   ③ 都没有 —— 先落在工作目录的 output/ 下，界面上把路径给出来
       */
      const stamp = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const autoName = `结构式_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.xlsx`
      let outputPath = str(body.outputPath).trim()
      const pickedDir = str(body.outputDir).trim()
      const pickedName = str(body.filename).trim()
      const isAuto = !outputPath && !pickedDir
      if (!outputPath) {
        const dir = pickedDir || path.join(workDir, 'output')
        outputPath = path.join(dir, pickedName ? safeName(pickedName) : autoName)
      }
      outputPath = path.resolve(outputPath)
      if (outputPath.toLowerCase() === path.resolve(templatePath).toLowerCase()) {
        throw new Error('不能覆盖模版文件本身，请换一个输出文件名')
      }
      const outputDir = path.dirname(outputPath)
      if (!fs.existsSync(outputDir)) {
        // 只有"先落在工作目录"才自动建目录；用户指定的目录不存在要明确报错
        if (!isAuto) throw new Error(`输出目录不存在：${outputDir}`)
        fs.mkdirSync(outputDir, { recursive: true })
      }
      /* 用户选目录时，同名文件不静默覆盖，自动加序号（避免毁掉上一次的导出） */
      if (pickedDir && fs.existsSync(outputPath)) {
        const ext = path.extname(outputPath)
        const stem = outputPath.slice(0, outputPath.length - ext.length)
        for (let n = 2; n < 100; n += 1) {
          const candidate = `${stem} (${n})${ext}`
          if (!fs.existsSync(candidate)) {
            outputPath = candidate
            break
          }
        }
      }
      fs.writeFileSync(outputPath, result.buffer)
      /* 回读校验：写盘字节数必须与内存里的结果一致 */
      const writtenBytes = fs.statSync(outputPath).size
      if (writtenBytes !== result.buffer.length) {
        throw new Error(`落盘校验不一致：应为 ${result.buffer.length} 字节，实际 ${writtenBytes} 字节`)
      }

      const outputToken = crypto.randomBytes(8).toString('hex')

      return {
        outputPath,
        outputName: path.basename(outputPath),
        outputToken,
        written: result.written,
        firstRow: result.firstRow,
        lastRow: result.lastRow,
        templatePath,
        targetColumn: info.targetColumnLetter,
        targetTitle: info.targetTitle,
        sheetName: info.sheetName,
        size: result.buffer.length,
        templateRows: info.availableRows,
        extendedRows: result.written > info.availableRows,
        savedByUser: !!pickedDir,
      }
    },

    async reveal(body) {
      const target = path.resolve(str(body.path))
      if (!fs.existsSync(target)) throw new Error(`文件不存在：${target}`)
      try {
        const { spawn } = await import('node:child_process')
        if (process.platform === 'win32') {
          spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref()
        } else if (process.platform === 'darwin') {
          spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref()
        } else {
          spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' }).unref()
        }
        return { revealed: true, path: target }
      } catch (error) {
        return { revealed: false, path: target, note: `无法自动打开：${error.message}` }
      }
    },
  }

  return { settings, dispatch, workDir, store }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx, config) {
  try {
    const runtime = buildRuntime(ctx, config)

    const handler = async (req, res) => {
      try {
        const rawUrl = str(req.url) || '/'
        const pathname = rawUrl.split('?')[0]
        const index = pathname.indexOf(API_PREFIX)
        const tail = index >= 0 ? pathname.slice(index + API_PREFIX.length) : pathname
        const route = tail.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()

        let body = {}
        if (str(req.method).toUpperCase() !== 'GET') {
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error.message })
            return
          }
        }

        const action = runtime.dispatch[route]
        if (!action) {
          sendJson(res, 404, { ok: false, error: `未知路由：${route || '(空)'}` })
          return
        }
        const data = await action(body || {})
        sendJson(res, 200, { ok: true, data })
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        sendJson(res, 200, { ok: false, error: message })
      }
    }

    const bind = (fn) => (typeof ctx.effect === 'function' ? ctx.effect(fn) : fn())
    const webServer =
      ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : ctx && ctx.webServer
    if (!webServer) {
      console.warn('[inquiry-structure-workbench] 未注入 webServer 服务：HTTP 路由不会注册。')
      return
    }
    if (typeof webServer.register !== 'function') {
      console.warn('[inquiry-structure-workbench] webServer 服务形状不符：HTTP 路由不会注册。')
      return
    }
    bind(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
  } catch (error) {
    console.warn('[inquiry-structure-workbench] apply 失败（已隔离）:', error)
  }
}

apply.inject = inject

export default { apply, inject }
