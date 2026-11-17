/**
 * @local/inquiry-structure-workbench —— 询单结构式助手 · 客户端（浏览器 / React 侧）
 * ---------------------------------------------------------------------------
 * 业务流（不依赖任何会话，打开就能用）：
 *   ① 选择 Word / Excel 源文件  →  ② 按从上到下预览全部图片，勾选要用的结构式
 *   ③ 确认固定模版与输出位置      →  ④ 一键生成新的咨询表
 *
 * 约定：
 *   · React 由 require('react') 取，h = React.createElement（不引第三方 UI 库）。
 *   · 只用 ctx.get() 取服务，全部包 try/catch；apply 整体不抛。
 *   · 颜色走 --dsw-alias-* 主题令牌（浅色/深色都可读），并带 fallback。
 *   · 布局按业务容器宽度重排（容器查询），不依赖整窗断点。
 */

window.__ModuleLoader__.load({
  id: '@local/inquiry-structure-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'inquiry-structure-workbench'
    const API_BASE = '/inquiry-structure/api'
    const CHUNK_BYTES = 32 * 1024
    /** 客户端构建号：与服务端不一致说明桌面端没重启，跑的是旧界面 */
    const CLIENT_BUILD = '1.0.5-20261117'
    /** 宿主上下文（注册时拿到）：用于取宿主服务，如 uiWorkspace.pickDirectory */
    let hostCtx = null

    /** 构建号比较：a 是否比 b 旧 */
    function isOlderBuild(a, b) {
      const parse = (value) => {
        const m = /^(\d+)\.(\d+)\.(\d+)(?:-(\S+))?$/.exec(String(value || ''))
        return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || ''] : null
      }
      const ra = parse(a)
      const rb = parse(b)
      if (!ra || !rb) return false
      for (let i = 0; i < 3; i += 1) {
        if (ra[i] !== rb[i]) return ra[i] < rb[i]
      }
      return ra[3] < rb[3]
    }

    /* ---------------------------------------------------------------- *
     * 基础工具
     * ---------------------------------------------------------------- */

    async function apiPost(route, body) {
      const response = await fetch(`${API_BASE}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let json
      try {
        json = await response.json()
      } catch (error) {
        throw new Error(`服务返回异常（HTTP ${response.status}）`)
      }
      if (!json || json.ok !== true) {
        throw new Error((json && json.error) || `请求失败（HTTP ${response.status}）`)
      }
      return json.data
    }

    function bufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const step = 0x8000
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
      }
      return btoa(binary)
    }

    /** 用户主动点了「取消」 */
    function isAbortError(error) {
      const name = String((error && error.name) || '')
      if (name === 'AbortError') return true
      return name === 'NotAllowedError' && /abort|cancel|取消/i.test(String((error && error.message) || ''))
    }

    /**
     * 选一个保存目录。
     *
     * ⚠️ 为什么不用浏览器自带的 showSaveFilePicker 写文件：
     *    Electron 只实现了这个对话框，**没有实现它的写接口**
     *    （handle.createWritable() 会抛 NotAllowedError: not allowed by the user agent）。
     *    所以这里走宿主提供的**原生目录选择器**：目录由系统对话框选，
     *    真正的写盘交给服务端（node:fs），这条路径在桌面端最可靠。
     *
     * 两条来源都试：① 桌面端 preload 注入的 __DSH_DIRECTORY_PICKER__；
     *              ② 宿主服务 uiWorkspace.pickDirectory()。
     */
    function pickDirectory() {
      const bridge = typeof window !== 'undefined' ? window.__DSH_DIRECTORY_PICKER__ : null
      if (bridge && typeof bridge.pick === 'function') {
        try {
          return Promise.resolve(bridge.pick()).then((dir) =>
            typeof dir === 'string' && dir.trim() ? dir.trim() : null,
          )
        } catch (error) {
          return Promise.reject(error)
        }
      }
      let service = null
      try {
        service = hostCtx && hostCtx.uiWorkspace
        if (!service && hostCtx && typeof hostCtx.get === 'function') service = hostCtx.get('uiWorkspace')
      } catch (_) {
        service = null
      }
      if (service && typeof service.pickDirectory === 'function') {
        try {
          return Promise.resolve(service.pickDirectory()).then((dir) =>
            typeof dir === 'string' && dir.trim() ? dir.trim() : null,
          )
        } catch (error) {
          return Promise.reject(error)
        }
      }
      return Promise.reject(new Error('当前环境没有可用的目录选择器'))
    }

    /** 另存为时给用户的默认文件名 */
    function suggestFileName() {
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      return `结构式_导出_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`
    }

    function formatSize(bytes) {
      const size = Number(bytes) || 0
      if (size < 1024) return `${size} B`
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
      return `${(size / 1024 / 1024).toFixed(1)} MB`
    }

    function fileNameOf(filePath) {
      const parts = String(filePath || '').split(/[\\/]/)
      return parts[parts.length - 1] || ''
    }

    /* ---------------------------------------------------------------- *
     * 样式
     * ---------------------------------------------------------------- */

    const CSS = `
.isw-root {
  --isw-bg: var(--dsw-alias-bg-base, #f3f5f8);
  --isw-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --isw-surface-2: var(--dsw-alias-bg-layer-2, #eef1f6);
  --isw-surface-3: var(--dsw-alias-bg-layer-3, #e4e9f0);
  --isw-line: var(--dsw-alias-border-l1, rgba(16,24,40,.10));
  --isw-line-2: var(--dsw-alias-border-l2, rgba(16,24,40,.18));
  --isw-ink: var(--dsw-alias-label-primary, #16202f);
  --isw-ink-2: var(--dsw-alias-label-secondary, #4a5768);
  --isw-ink-3: var(--dsw-alias-label-tertiary, #7b8798);
  --isw-brand: var(--dsw-alias-brand-primary, #1f3a8a);
  --isw-brand-soft: var(--dsw-alias-brand-primary-soft, rgba(31,58,138,.12));
  --isw-ok: var(--dsw-alias-state-success-primary, #14804a);
  --isw-warn: var(--dsw-alias-state-warn-primary, #b45309);
  --isw-bad: var(--dsw-alias-state-error-primary, #c02626);
  --isw-hover: var(--dsw-alias-interactive-bg-hover, rgba(16,24,40,.05));
  --isw-btn-ink: var(--dsw-alias-label-primary-foreground, #ffffff);

  container-type: inline-size;
  container-name: isw;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--isw-bg);
  color: var(--isw-ink);
  font-family: var(--dsw-alias-font-family, system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif);
  font-size: 14px;
  line-height: 1.6;
}
.isw-root * { box-sizing: border-box; }

.isw-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  background: var(--isw-surface);
  border-bottom: 1px solid var(--isw-line);
}
.isw-brand { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1 1 260px; }
.isw-logo {
  width: 38px; height: 38px; flex: 0 0 38px;
  display: grid; place-items: center;
  font-size: 20px; border-radius: 10px;
  background: var(--isw-brand-soft);
  border: 1px solid var(--isw-line);
}
.isw-titles { min-width: 0; }
.isw-title { font-size: 16px; font-weight: 650; letter-spacing: .2px; overflow-wrap: anywhere; }
.isw-sub { font-size: 12.5px; color: var(--isw-ink-2); overflow-wrap: anywhere; }
.isw-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.isw-btn {
  appearance: none; border: 1px solid var(--isw-line-2); background: var(--isw-surface);
  color: var(--isw-ink); border-radius: 8px; padding: 7px 14px; font-size: 13px;
  cursor: pointer; font-family: inherit; line-height: 1.4; white-space: nowrap;
}
.isw-btn:hover:not(:disabled) { background: var(--isw-hover); }
.isw-btn:disabled { opacity: .5; cursor: not-allowed; }
.isw-btn:focus-visible { outline: 2px solid var(--isw-brand); outline-offset: 2px; }
.isw-btn.primary { background: var(--isw-brand); border-color: var(--isw-brand); color: var(--isw-btn-ink); font-weight: 600; }
.isw-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
.isw-btn.ghost { border-color: transparent; background: transparent; color: var(--isw-ink-2); }
.isw-btn.small { padding: 4px 10px; font-size: 12px; }

.isw-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 18px 20px 28px; }

.isw-steps { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.isw-step {
  display: flex; align-items: center; gap: 8px; padding: 7px 12px;
  border: 1px solid var(--isw-line); border-radius: 999px; background: var(--isw-surface);
  font-size: 12.5px; color: var(--isw-ink-3);
}
.isw-step .n {
  width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
  background: var(--isw-surface-2); color: var(--isw-ink-2); font-size: 11.5px; font-weight: 700;
}
.isw-step.active { border-color: var(--isw-brand); color: var(--isw-ink); background: var(--isw-brand-soft); }
.isw-step.active .n { background: var(--isw-brand); color: var(--isw-btn-ink); }
.isw-step.done .n { background: var(--isw-ok); color: #fff; }

.isw-card {
  background: var(--isw-surface); border: 1px solid var(--isw-line); border-radius: 12px;
  padding: 16px; margin-bottom: 14px;
}
.isw-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.isw-card-title { font-size: 14.5px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.isw-card-desc { font-size: 12.5px; color: var(--isw-ink-2); margin-top: 2px; overflow-wrap: anywhere; }

.isw-drop {
  border: 1.5px dashed var(--isw-line-2); border-radius: 12px; padding: 22px 16px; text-align: center;
  background: var(--isw-surface-2); transition: border-color .15s, background .15s;
}
.isw-drop.hot { border-color: var(--isw-brand); background: var(--isw-brand-soft); }
.isw-drop-title { font-weight: 600; margin-bottom: 4px; }
.isw-drop-hint { font-size: 12.5px; color: var(--isw-ink-2); }

.isw-file {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px;
  border: 1px solid var(--isw-line); border-radius: 10px; background: var(--isw-surface-2);
}
.isw-file-icon { font-size: 22px; }
.isw-file-name { font-weight: 600; overflow-wrap: anywhere; }
.isw-file-meta { font-size: 12px; color: var(--isw-ink-2); overflow-wrap: anywhere; }

.isw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 12px; }
.isw-pick {
  position: relative; border: 1px solid var(--isw-line); border-radius: 10px; background: var(--isw-surface);
  padding: 8px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; min-width: 0;
  transition: border-color .12s, box-shadow .12s;
}
.isw-pick:hover { border-color: var(--isw-line-2); }
.isw-pick.on { border-color: var(--isw-brand); box-shadow: 0 0 0 1px var(--isw-brand) inset; }
.isw-pick.off { opacity: .55; }
.isw-pick:focus-visible { outline: 2px solid var(--isw-brand); outline-offset: 2px; }
.isw-pick-box {
  position: absolute; top: 8px; left: 8px; width: 20px; height: 20px; border-radius: 5px;
  background: var(--isw-surface); border: 1px solid var(--isw-line-2);
  display: grid; place-items: center; font-size: 13px; color: transparent; z-index: 2;
}
.isw-pick.on .isw-pick-box { background: var(--isw-brand); border-color: var(--isw-brand); color: var(--isw-btn-ink); }
.isw-pick-idx {
  position: absolute; top: 8px; right: 8px; z-index: 2; font-size: 11px; font-variant-numeric: tabular-nums;
  background: var(--isw-surface); border: 1px solid var(--isw-line); border-radius: 999px; padding: 0 7px; color: var(--isw-ink-2);
}
.isw-thumb {
  height: 108px; display: grid; place-items: center; background: var(--isw-surface-2);
  border-radius: 8px; overflow: hidden;
}
.isw-thumb img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.isw-thumb .ph { color: var(--isw-ink-3); font-size: 12px; }
.isw-cap { font-size: 12px; color: var(--isw-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.isw-cap-meta { font-size: 11px; color: var(--isw-ink-3); font-variant-numeric: tabular-nums; }

.isw-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.isw-label { font-size: 12.5px; color: var(--isw-ink-2); font-weight: 600; }
.isw-input {
  border: 1px solid var(--isw-line-2); border-radius: 8px; padding: 8px 11px; font-size: 13px;
  background: var(--isw-surface); color: var(--isw-ink); font-family: inherit; width: 100%;
  overflow-wrap: anywhere;
}
.isw-input:focus-visible { outline: 2px solid var(--isw-brand); outline-offset: -1px; border-color: var(--isw-brand); }
.isw-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.isw-row > .isw-field { flex: 1 1 240px; margin-bottom: 0; }

.isw-banner {
  display: flex; gap: 10px; align-items: flex-start; padding: 11px 14px; border-radius: 10px;
  border: 1px solid var(--isw-line-2); background: var(--isw-surface-2); margin-bottom: 14px; font-size: 13px;
}
.isw-banner.error { border-color: var(--isw-bad); background: color-mix(in srgb, var(--isw-bad) 10%, transparent); color: var(--isw-bad); }
.isw-banner.ok { border-color: var(--isw-ok); background: color-mix(in srgb, var(--isw-ok) 10%, transparent); }
.isw-banner.info { border-color: var(--isw-brand); background: var(--isw-brand-soft); }

.isw-result { display: flex; flex-direction: column; gap: 10px; }
.isw-result-path {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px;
  background: var(--isw-surface-2); border: 1px solid var(--isw-line); border-radius: 8px; padding: 9px 11px;
  overflow-wrap: anywhere; user-select: all;
}
.isw-pill {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px;
  background: var(--isw-surface-3); font-size: 12px; color: var(--isw-ink-2); font-variant-numeric: tabular-nums;
}
.isw-empty { text-align: center; padding: 26px 12px; color: var(--isw-ink-3); font-size: 13px; }
.isw-hidden-input { display: none; }
.isw-spin {
  width: 13px; height: 13px; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent;
  display: inline-block; animation: isw-spin .8s linear infinite;
}
@keyframes isw-spin { to { transform: rotate(360deg); } }

@container isw (max-width: 720px) {
  .isw-top { padding: 12px 14px; }
  .isw-body { padding: 14px 12px 24px; }
  .isw-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
  .isw-thumb { height: 88px; }
  .isw-brand { flex: 1 1 100%; }
  .isw-actions { width: 100%; }
}
`

    function injectStyles(ctx) {
      if (typeof document === 'undefined') return
      const style = document.createElement('style')
      style.setAttribute('data-plugin', NS)
      style.textContent = CSS
      document.head.appendChild(style)
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          try {
            if (style.parentNode) style.parentNode.removeChild(style)
          } catch (error) {
            /* 忽略 */
          }
        })
      }
    }

    /* ---------------------------------------------------------------- *
     * 小组件
     * ---------------------------------------------------------------- */

    function Banner({ kind, children }) {
      if (!children) return null
      const icon = kind === 'error' ? '⚠️' : kind === 'ok' ? '✅' : 'ℹ️'
      return h('div', { className: `isw-banner ${kind || 'info'}` }, h('span', null, icon), h('div', null, children))
    }

    function Stepper({ current, labels }) {
      return h(
        'div',
        { className: 'isw-steps' },
        labels.map((label, index) => {
          const step = index + 1
          const state = step < current ? 'done' : step === current ? 'active' : ''
          return h(
            'div',
            { key: label, className: `isw-step ${state}` },
            h('span', { className: 'n' }, step < current ? '✓' : String(step)),
            h('span', null, label),
          )
        }),
      )
    }

    /* ---------------------------------------------------------------- *
     * 业务面板
     * ---------------------------------------------------------------- */

    function BusinessPanel() {
      const [stage, setStage] = useState(1)
      const [busy, setBusy] = useState(false)
      const [busyText, setBusyText] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      const [source, setSource] = useState(null) // { fileId, name, kind, size }
      const [items, setItems] = useState([])
      const [previews, setPreviews] = useState({})
      const [selected, setSelected] = useState({})

      const [template, setTemplate] = useState(null)
      const [templateAutoFound, setTemplateAutoFound] = useState(false)
      const [staleBuild, setStaleBuild] = useState(false)
      const [fileName, setFileName] = useState('')
      const [result, setResult] = useState(null)

      const sourceInputRef = useRef(null)
      const [dragHot, setDragHot] = useState(false)

      /* --- 初始：读取固定模版 --- */
      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const defaults = await apiPost('defaults', {})
            if (!alive) return
            // 桌面端没重启时，界面和服务端会是两套版本 —— 直接点破，别让用户瞎试
            if (defaults.requiresClientBuild && isOlderBuild(CLIENT_BUILD, defaults.requiresClientBuild)) {
              setStaleBuild(true)
            }
            if (defaults.defaultTemplatePath) {
              try {
                const info = await apiPost('template.inspect', { templatePath: defaults.defaultTemplatePath })
                if (!alive) return
                setTemplate(info)
                setTemplateAutoFound(!!defaults.defaultTemplateFallback)
                if (!fileName) setFileName(suggestFileName())
              } catch (error) {
                if (alive) setError(`固定模版读取失败：${error.message}`)
              }
            }
          } catch (error) {
            if (alive) setError(`无法连接本机服务：${error.message}`)
          }
        })()
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /* --- 预览图按需加载（并发 5） --- */
      useEffect(() => {
        if (!source || !items.length) return
        let alive = true
        const pending = items.filter((item) => !(item.index in previews))
        if (!pending.length) return
        const queue = pending.slice()
        const worker = async () => {
          while (queue.length && alive) {
            const item = queue.shift()
            try {
              const data = await apiPost('preview', { fileId: source.fileId, index: item.index })
              if (!alive) return
              setPreviews((prev) => ({ ...prev, [item.index]: data }))
            } catch (error) {
              if (!alive) return
              setPreviews((prev) => ({ ...prev, [item.index]: { error: error.message } }))
            }
          }
        }
        const runners = [worker(), worker(), worker(), worker(), worker()]
        return () => {
          alive = false
          runners.forEach((p) => p.catch(() => {}))
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [source, items])

      /* --- 上传 --- */
      /**
       * 分片上传。整个文件只建一个会话：
       *   · 第一个分片带空 fileId 让服务端建会话；
       *   · 其余分片（包括并发线程）一律带上同一个 fileId。
       * 否则每个并发线程都会各建一个会话，分片被拆散，永远凑不齐，
       * 服务端判定上传未完成（表现为“上传失败”）。
       */
      const uploadFile = useCallback(async (file) => {
        if (!file || !file.size) throw new Error('文件是空的，请重新选择')
        const total = Math.max(1, Math.ceil(file.size / CHUNK_BYTES))
        let fileId = ''
        let nextIndex = 0
        let sessionPromise = null

        const ensureSession = () => {
          if (!sessionPromise) {
            sessionPromise = new Promise((resolve, reject) => {
              const slice = file.slice(0, Math.min(file.size, CHUNK_BYTES))
              Promise.resolve()
                .then(() => slice.arrayBuffer())
                .then((buffer) =>
                  apiPost('upload', {
                    name: file.name,
                    size: file.size,
                    chunkSize: CHUNK_BYTES,
                    index: 0,
                    total,
                    data: bufferToBase64(buffer),
                    fileId: '',
                  }),
                )
                .then((data) => {
                  fileId = (data && data.fileId) || ''
                  nextIndex = 1
                  resolve(fileId)
                })
                .catch(reject)
            })
          }
          return sessionPromise
        }

        const workers = []
        const runOne = async () => {
          const id = await ensureSession()
          for (;;) {
            const current = nextIndex
            if (current >= total) return
            nextIndex = current + 1
            const start = current * CHUNK_BYTES
            const slice = file.slice(start, Math.min(file.size, start + CHUNK_BYTES))
            const buffer = await slice.arrayBuffer()
            await apiPost('upload', {
              name: file.name,
              size: file.size,
              chunkSize: CHUNK_BYTES,
              index: current,
              total,
              data: bufferToBase64(buffer),
              fileId: id,
            })
          }
        }
        for (let i = 0; i < 4; i += 1) workers.push(runOne())
        await Promise.all(workers)
        return fileId
      }, [])

      /* --- 选择源文件 --- */
      const handleSourceFile = useCallback(
        async (file) => {
          if (!file) return
          setError('')
          setNotice('')
          setResult(null)
          setBusy(true)
          setBusyText('正在读取文件…')
          try {
            const fileId = await uploadFile(file)
            setBusyText('正在提取图片…')
            const data = await apiPost('extract', { fileId })
            setSource({ fileId, name: file.name, kind: data.source.kind, size: data.source.size })
            setItems(data.items)
            setPreviews({})
            const all = {}
            data.items.forEach((item) => {
              all[item.index] = true
            })
            setSelected(all)
            setStage(2)
            setNotice(
              data.count
                ? `已提取 ${data.count} 张图片，请勾选要写入模版的结构式。`
                : '这个文件里没有找到图片，请确认是包含结构式的 Word 或 Excel。',
            )
          } catch (err) {
            setError(err.message)
          } finally {
            setBusy(false)
            setBusyText('')
          }
        },
        [uploadFile],
      )

      /* --- 模版由工作台固定，用户无需上传 --- */

      const toggle = useCallback((index) => {
        setSelected((prev) => ({ ...prev, [index]: !prev[index] }))
      }, [])

      const selectAll = useCallback(
        (on) => {
          const next = {}
          items.forEach((item) => {
            next[item.index] = on
          })
          setSelected(next)
        },
        [items],
      )

      const selectedIndexes = useMemo(
        () =>
          items
            .filter((item) => selected[item.index])
            .map((item) => item.index)
            .sort((a, b) => a - b),
        [items, selected],
      )

      /* --- 生成并保存到指定位置 ---
       * 交付口径（按桌面端最可靠的顺序）：
       *   ① 原生目录选择器：用户选文件夹 → 服务端直接写盘（node:fs）→ 回读校验
       *   ② 没有目录选择器时：系统「另存为」对话框取路径（Electron 下只能取路径，不能由前端写）
       *   ③ 都不行：先落在工作目录，界面上给出路径和「打开所在文件夹」
       * 模版由服务端固定，这里不传 templatePath。
       */
      const handleGenerate = useCallback(async () => {
        setError('')
        setNotice('')
        setBusy(true)
        setBusyText('正在处理…')
        try {
          const body = { sourceFileId: source.fileId, indexes: selectedIndexes }
          const filename = fileName.trim() || suggestFileName()

          /* ① 选目录 → 服务端直接写进去 */
          let dir = null
          let pickerUnavailable = false
          try {
            dir = await pickDirectory()
          } catch (pickerError) {
            pickerUnavailable = true
          }
          if (dir) {
            const data = await apiPost('fill', { ...body, outputDir: dir, filename })
            setResult({ ...data, displayPath: data.outputPath, hasFullPath: true })
            setStage(4)
            setNotice(
              `已保存到 ${data.outputPath}：${data.written} 张结构式写入第 ${data.firstRow}~${data.lastRow} 行（${data.targetColumn} 列）。`,
            )
            return
          }
          if (!pickerUnavailable) {
            /* 用户在目录对话框点了「取消」：不再弹第二个对话框，也不生成文件 */
            setNotice('已取消保存，没有生成文件。')
            return
          }

          /* ② 没有目录选择器 → 试试系统「另存为」对话框，只用它取路径 */
          if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
            let handle = null
            try {
              handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [
                  {
                    description: 'Excel 工作簿',
                    accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
                  },
                ],
              })
            } catch (err) {
              if (isAbortError(err)) {
                setNotice('已取消保存，没有生成文件。')
                return
              }
              throw err
            }
            /* Electron 没有实现 handle.createWritable()，只能从句柄反查绝对路径，
               真正的写盘交给服务端。 */
            let absPath = ''
            try {
              const file = await handle.getFile()
              if (file && typeof file.path === 'string') absPath = file.path
            } catch (_) {
              absPath = ''
            }
            if (absPath) {
              const data = await apiPost('fill', { ...body, outputPath: absPath })
              setResult({ ...data, displayPath: data.outputPath, hasFullPath: true })
              setStage(4)
              setNotice(
                `已另存为 ${data.outputPath}：${data.written} 张结构式写入第 ${data.firstRow}~${data.lastRow} 行（${data.targetColumn} 列）。`,
              )
              return
            }
            setNotice('这个环境拿不到「另存为」对话框选的路径，已改为生成到工作目录。')
          }

          /* ③ 兜底：先落在工作目录，界面上给出路径 */
          const data = await apiPost('fill', body)
          setResult({ ...data, displayPath: data.outputPath, hasFullPath: true })
          setStage(4)
          setNotice(
            `已生成（当前环境没有可选的保存位置，暂存在工作目录）：${data.written} 张结构式写入第 ${data.firstRow}~${data.lastRow} 行。`,
          )
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
          setBusyText('')
        }
      }, [source, selectedIndexes, fileName])

      const reveal = useCallback(async () => {
        if (!result || !result.hasFullPath) return
        try {
          const data = await apiPost('reveal', { path: result.outputPath })
          if (!data.revealed && data.note) setNotice(data.note)
        } catch (err) {
          setError(err.message)
        }
      }, [result])

      const copyPath = useCallback(async () => {
        if (!result) return
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(result.displayPath || result.outputPath)
            setNotice('文件路径已复制。')
          }
        } catch (error) {
          setNotice('复制失败，请手动选中路径复制。')
        }
      }, [result])

      const reset = useCallback(() => {
        setSource(null)
        setItems([])
        setPreviews({})
        setSelected({})
        setResult(null)
        setError('')
        setNotice('')
        setStage(1)
      }, [])

      const sourceLabel = source ? source.name : '还没有选择源文件'
      const sourceMeta = source
        ? `${source.kind === 'docx' ? 'Word 文档' : 'Excel 表格'} · ${formatSize(source.size)} · 共 ${items.length} 张图片`
        : '支持 .docx 与 .xlsx；图片按文档从上到下排序'

      return h(
        'div',
        { className: 'isw-root' },
        h(
          'header',
          { className: 'isw-top' },
          h(
            'div',
            { className: 'isw-brand' },
            h('div', { className: 'isw-logo' }, '🧪'),
            h(
              'div',
              { className: 'isw-titles' },
              h('div', { className: 'isw-title' }, '询单结构式助手'),
              h('div', { className: 'isw-sub' }, '从 Word / Excel 提取结构式图片，按顺序填入固定模版的「结构式/产品信息」列'),
            ),
          ),
          h(
            'div',
            { className: 'isw-actions' },
            h('button', { className: 'isw-btn ghost', onClick: reset, disabled: busy }, '重新开始'),
            h(
              'button',
              {
                className: 'isw-btn primary',
                onClick: handleGenerate,
                disabled: busy || !items.length || !selectedIndexes.length,
                title: selectedIndexes.length ? `写入 ${selectedIndexes.length} 张` : '请先勾选结构式',
              },
              busy ? h('span', { className: 'isw-spin' }) : null,
              busy ? ` ${busyText || '处理中…'}` : `生成并另存为（${selectedIndexes.length}）`,
            ),
          ),
        ),
        h(
          'main',
          { className: 'isw-body' },
          h(Stepper, { current: stage, labels: ['选择源文件', '核对结构式', '固定模版', '完成'] }),

          h(Banner, { kind: 'error' }, error),
          h(Banner, { kind: 'info' }, notice),
          staleBuild
            ? h(
                Banner,
                { kind: 'error' },
                '这个界面是旧版本，服务端已经更新过了。请完全退出 DSH Desktop（托盘图标 → 退出）后重新打开，再来一次。',
              )
            : null,

          /* ① 源文件 */
          h(
            'section',
            { className: 'isw-card' },
            h(
              'div',
              { className: 'isw-card-head' },
              h(
                'div',
                null,
                h('div', { className: 'isw-card-title' }, '① 选择源文件'),
                h('div', { className: 'isw-card-desc' }, '含有结构式图片的 Word 需求单或 Excel 表格'),
              ),
              source
                ? h(
                    'div',
                    { className: 'isw-actions' },
                    h('button', { className: 'isw-btn small', onClick: () => sourceInputRef.current && sourceInputRef.current.click(), disabled: busy }, '换一个文件'),
                  )
                : null,
            ),
            source ? (
              h(
                'div',
                { className: 'isw-file' },
                h('div', { className: 'isw-file-icon' }, source.kind === 'docx' ? '📄' : '📊'),
                h(
                  'div',
                  { style: { minWidth: 0 } },
                  h('div', { className: 'isw-file-name' }, sourceLabel),
                  h('div', { className: 'isw-file-meta' }, sourceMeta),
                ),
              )
            ) : (
              h(
                'div',
                {
                  className: `isw-drop ${dragHot ? 'hot' : ''}`,
                  onDragOver: (event) => {
                    event.preventDefault()
                    setDragHot(true)
                  },
                  onDragLeave: () => setDragHot(false),
                  onDrop: (event) => {
                    event.preventDefault()
                    setDragHot(false)
                    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]
                    handleSourceFile(file)
                  },
                },
                h('div', { className: 'isw-drop-title' }, '把 Word / Excel 文件拖到这里，或点击下方按钮选择'),
                h('div', { className: 'isw-drop-hint' }, '文件只在本机解析，不会上传到任何外部服务'),
                h(
                  'div',
                  { style: { marginTop: '12px' } },
                  h(
                    'button',
                    { className: 'isw-btn primary', onClick: () => sourceInputRef.current && sourceInputRef.current.click(), disabled: busy },
                    '选择文件',
                  ),
                ),
              )
            ),
            h('input', {
              ref: sourceInputRef,
              className: 'isw-hidden-input',
              type: 'file',
              accept: '.docx,.xlsx',
              onChange: (event) => {
                const file = event.target.files && event.target.files[0]
                event.target.value = ''
                handleSourceFile(file)
              },
            }),
          ),

          /* ② 结构式核对 */
          items.length
            ? h(
                'section',
                { className: 'isw-card' },
                h(
                  'div',
                  { className: 'isw-card-head' },
                  h(
                    'div',
                    null,
                    h('div', { className: 'isw-card-title' }, '② 核对结构式'),
                    h('div', { className: 'isw-card-desc' }, '按文档从上到下排列，勾选要写入模版的图片（默认全选）'),
                  ),
                  h(
                    'div',
                    { className: 'isw-actions' },
                    h('span', { className: 'isw-pill' }, `已选 ${selectedIndexes.length} / ${items.length}`),
                    h('button', { className: 'isw-btn small', onClick: () => selectAll(true) }, '全选'),
                    h('button', { className: 'isw-btn small', onClick: () => selectAll(false) }, '全不选'),
                  ),
                ),
                h(
                  'div',
                  { className: 'isw-grid' },
                  items.map((item) => {
                    const preview = previews[item.index]
                    const on = !!selected[item.index]
                    return h(
                      'div',
                      {
                        key: item.index,
                        className: `isw-pick ${on ? 'on' : 'off'}`,
                        role: 'checkbox',
                        tabIndex: 0,
                        'aria-checked': on ? 'true' : 'false',
                        'aria-label': `第 ${item.index + 1} 张：${item.context || item.name}`,
                        onClick: () => toggle(item.index),
                        onKeyDown: (event) => {
                          if (event.key === ' ' || event.key === 'Enter') {
                            event.preventDefault()
                            toggle(item.index)
                          }
                        },
                      },
                      h('div', { className: 'isw-pick-box' }, '✓'),
                      h('div', { className: 'isw-pick-idx' }, `#${item.index + 1}`),
                      h(
                        'div',
                        { className: 'isw-thumb' },
                        preview && preview.dataUrl
                          ? h('img', { src: preview.dataUrl, alt: item.context || item.name, loading: 'lazy' })
                          : preview && preview.error
                            ? h('span', { className: 'ph' }, '加载失败')
                            : h('span', { className: 'ph' }, '加载中…'),
                      ),
                      h('div', { className: 'isw-cap', title: item.context || item.name }, item.context || item.name),
                      h(
                        'div',
                        { className: 'isw-cap-meta' },
                        `${item.width || '?'}×${item.height || '?'}px · ${formatSize(item.bytes)}`,
                      ),
                    )
                  }),
                ),
              )
            : null,

          /* ③ 固定模版（工作台维护，用户不需要上传） */
          h(
            'section',
            { className: 'isw-card' },
            h(
              'div',
              { className: 'isw-card-head' },
              h(
                'div',
                null,
                h('div', { className: 'isw-card-title' }, '③ 固定模版'),
                h('div', { className: 'isw-card-desc' }, template ? template.summary : '正在读取固定模版…'),
              ),
            ),
            template
              ? h(
                  'div',
                  { style: { marginBottom: '12px' } },
                  h(
                    'div',
                    { className: 'isw-file' },
                    h('div', { className: 'isw-file-icon' }, '📋'),
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h('div', { className: 'isw-file-name' }, fileNameOf(template.path)),
                      h('div', { className: 'isw-file-meta' }, template.path),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'isw-file-meta', style: { marginTop: '6px' } },
                    templateAutoFound
                      ? '固定模版不在原位置，已按内容自动找回上面这份。'
                      : '固定模版由工作台自动维护，你不需要上传；生成后可直接「另存为」到任意位置。',
                  ),
                )
              : null,
            h(
              'div',
              { className: 'isw-row' },
              h(
                'div',
                { className: 'isw-field' },
                h('label', { className: 'isw-label' }, '文件名（可改）'),
                h('input', {
                  className: 'isw-input',
                  value: fileName,
                  placeholder: suggestFileName(),
                  onChange: (event) => setFileName(event.target.value),
                }),
                h(
                  'div',
                  { className: 'isw-file-meta', style: { marginTop: '6px' } },
                  '点「生成并另存为」后会弹出系统目录选择器，你自己挑保存位置。',
                ),
              ),
            ),
          ),

          /* ④ 结果 */
          result
            ? h(
                'section',
                { className: 'isw-card' },
                h('div', { className: 'isw-card-title' }, '④ 已生成'),
                h(
                  'div',
                  { className: 'isw-result', style: { marginTop: '10px' } },
                  h('div', { className: 'isw-result-path' }, result.displayPath || result.outputPath),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                    h('span', { className: 'isw-pill' }, `${result.written} 张结构式`),
                    h('span', { className: 'isw-pill' }, `第 ${result.firstRow}~${result.lastRow} 行`),
                    h('span', { className: 'isw-pill' }, `${result.targetColumn} 列 ${result.targetTitle}`),
                    h('span', { className: 'isw-pill' }, formatSize(result.size)),
                    result.extendedRows
                      ? h('span', { className: 'isw-pill' }, `已自动扩到 ${result.lastRow} 行`)
                      : null,
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                    result.hasFullPath
                      ? h('button', { className: 'isw-btn primary', onClick: reveal }, '打开所在文件夹')
                      : null,
                    h('button', { className: 'isw-btn', onClick: copyPath }, '复制文件路径'),
                  ),
                ),
              )
            : null,

          !items.length && !busy && !error
            ? h(
                'div',
                { className: 'isw-empty' },
                '还没有内容 —— 先选一个含结构式图片的 Word 或 Excel 文件吧。',
              )
            : null,

          h(
            'div',
            { className: 'isw-file-meta', style: { marginTop: '14px', textAlign: 'right' } },
            `界面版本 ${CLIENT_BUILD}`,
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- *
     * 注册
     * ---------------------------------------------------------------- */

    function registerWorkbench(ctx) {
      let disposed = false
      let unregister = null
      hostCtx = ctx || null

      const register = () => {
        if (disposed) return false
        let workbenches = null
        try {
          workbenches = typeof ctx.get === 'function' ? ctx.get('desktopWorkbenches') : ctx.desktopWorkbenches
        } catch (error) {
          workbenches = null
        }
        if (!workbenches || typeof workbenches.register !== 'function') return false
        try {
          unregister = workbenches.register(
            {
              title: '询单结构式助手',
              // 工作台身份：宿主用它把客户端注册映射成工作台目录条目。
              // 指向本仓库里这个插件的真实源码位置（公开可读）。
              repository: 'https://github.com/Zhong1856572/dsh-plugins',
              description:
                '从 Word / Excel 提取结构式图片，按文档从上到下的顺序写入固定模版的「结构式/产品信息」列，导出新的咨询表。',
              panelTitle: '询单结构式助手',
              icon: '🧪',
              audience: '销售、业务与采购',
              category: '业务工具',
              customFrame: true,
            },
            BusinessPanel,
          )
          return true
        } catch (error) {
          console.warn('[inquiry-structure-workbench] 工作台注册失败：', error)
          return false
        }
      }

      let tries = 0
      const tick = () => {
        if (disposed) return
        if (!register()) {
          tries += 1
          if (tries < 40) window.setTimeout(tick, 250)
          else console.warn('[inquiry-structure-workbench] desktopWorkbenches 服务始终不可用，工作台入口未注册。')
        }
      }
      tick()

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          disposed = true
          if (typeof unregister === 'function') {
            try {
              unregister()
            } catch (error) {
              /* 忽略 */
            }
          }
        }, 'inquiry-structure-workbench: cleanup')
      }
    }

    function start(ctx) {
      try {
        injectStyles(ctx)
      } catch (error) {
        console.warn('[inquiry-structure-workbench] style injection skipped:', error)
      }
      try {
        registerWorkbench(ctx)
      } catch (error) {
        console.warn('[inquiry-structure-workbench] workbench registration failed (contained):', error)
      }
    }

    const plugin = {
      apply(ctx) {
        try {
          start(ctx)
        } catch (error) {
          try {
            console.warn('[inquiry-structure-workbench] apply failed (contained):', error)
          } catch (_) {
            /* 忽略 */
          }
        }
      },
    }
    plugin.default = { apply: plugin.apply }
    return plugin
  },
})
