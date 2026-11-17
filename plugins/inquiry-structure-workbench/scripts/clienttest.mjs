/**
 * 客户端冒烟测试：在 Node 里加载 client.js，检查
 *   ① 模块入口能被捕获（window.__ModuleLoader__.load 被调用）
 *   ② factory(require) 能拿到 React 并返回插件对象
 *   ③ apply(ctx) 会向 desktopWorkbenches 注册正确的描述符
 *   ④ 业务面板组件能渲染出元素树（不抛异常）
 * 用法：node scripts/clienttest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const file = path.resolve('client.js')
const code = fs.readFileSync(file, 'utf8')

/* --- 迷你 React 桩：够跑通组件渲染路径 --- */
function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity) }
}
const ReactStub = {
  createElement,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

/* --- 假的宿主环境 --- */
let capturedSpec = null
const timers = []
const fakeWindow = {
  __ModuleLoader__: {
    load(spec) {
      capturedSpec = spec
      return { id: spec.id }
    },
  },
  setTimeout: (fn) => {
    timers.push(fn)
    return timers.length
  },
  clearTimeout: () => {},
  addEventListener: () => {},
  location: { reload: () => {} },
}

const sandbox = {
  window: fakeWindow,
  console,
  setTimeout: fakeWindow.setTimeout,
  clearTimeout: fakeWindow.clearTimeout,
  document: undefined,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => {
    throw new Error('客户端自测不应发起网络请求')
  },
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  URL,
  TextEncoder,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

function ok(label, condition, extra = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!condition) process.exitCode = 1
}

/* ① 执行入口 */
vm.runInContext(code, sandbox, { filename: 'client.js' })
ok('入口调用了 __ModuleLoader__.load', !!capturedSpec, capturedSpec && capturedSpec.id)
ok('入口 id 正确', capturedSpec && capturedSpec.id === '@local/inquiry-structure-workbench')

/* ② factory → 插件对象 */
const plugin = capturedSpec.factory((id) => {
  if (id === 'react') return ReactStub
  throw new Error('未预期的 require：' + id)
})
ok('factory 返回插件对象', !!plugin && typeof plugin.apply === 'function')

/* ③ apply → 注册工作台 */
let descriptor = null
let panel = null
const ctx = {
  effect(fn) {
    return fn()
  },
  get(name) {
    if (name === 'desktopWorkbenches') {
      return {
        register(desc, component) {
          descriptor = desc
          panel = component
          return () => {}
        },
      }
    }
    return undefined
  },
}
plugin.apply(ctx)
ok('注册了工作台入口', !!descriptor, descriptor && descriptor.title)
ok('标题正确', descriptor && descriptor.title === '询单结构式助手')
ok('整页布局（customFrame）', descriptor && descriptor.customFrame === true)
ok('带本地身份字段（repository）', descriptor && typeof descriptor.repository === 'string' && descriptor.repository.startsWith('https://github.com/'))

// 模拟宿主 desktop-workbenches 的 identityForSource：本地包没有市场安装记录、
// 也没上架，只能靠 repository 得到唯一身份；否则工作台入口会被宿主跳过（不显示）。
const repoMatch = descriptor && typeof descriptor.repository === 'string'
  ? descriptor.repository.match(/^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/i)
  : null
ok('身份可被宿主解析', !!repoMatch, repoMatch ? `${repoMatch[1]}/${repoMatch[2]}`.toLowerCase() : 'repository 格式不合规')
const identities = new Set(repoMatch ? [`${repoMatch[1]}/${repoMatch[2]}`.toLowerCase()] : [])
ok('本地包身份唯一（否则入口不显示）', identities.size === 1, `${identities.size} 个身份`)
ok('面板组件已提供', typeof panel === 'function')

/* ④.5 构建号自检：客户端与服务端版本号必须一致，否则桌面端没重启 */
const clientBuild = /const CLIENT_BUILD = '([^']+)'/.exec(code)
ok('客户端带构建号', !!clientBuild, clientBuild && clientBuild[1])
const serverCode = fs.readFileSync(path.resolve('index.js'), 'utf8')
const serverBuild = /const PLUGIN_BUILD = '([^']+)'/.exec(serverCode)
ok('服务端带构建号', !!serverBuild, serverBuild && serverBuild[1])
ok('客户端与服务端构建号一致', !!clientBuild && !!serverBuild && clientBuild[1] === serverBuild[1], `${clientBuild && clientBuild[1]} vs ${serverBuild && serverBuild[1]}`)

/* ④ 渲染 */
try {
  const tree = panel()
  ok('面板渲染未抛异常', !!tree && tree.type === 'div', tree && String(tree.type))
  const text = JSON.stringify(tree).slice(0, 20000)
  ok('渲染出关键文案', text.includes('询单结构式助手') && text.includes('选择源文件'))
  ok('渲染出生成按钮', text.includes('生成并另存为'))
} catch (error) {
  ok('面板渲染未抛异常', false, error.message)
}

/* ⑤ 交付口径：模版固定（没有上传入口）+ 保存位置由用户选 */
ok('界面里没有"更换模版"入口', !code.includes('更换模版'))
ok('界面里没有输出路径输入框', !code.includes('导出文件名（完整路径）'))
ok('有文件名输入（可改）', code.includes('文件名（可改）'))
ok('支持宿主原生目录选择器', code.includes('__DSH_DIRECTORY_PICKER__'))
ok('目录选择器有宿主服务兜底', code.includes('pickDirectory'))
ok('不用被 Electron 禁用的 createWritable 写盘', !/await\s+\w+\.createWritable\s*\(/.test(code))
ok('生成时不再指定模版（由服务端固定）', !/body\.templatePath\s*=/.test(code))

console.log('\n客户端冒烟测试结束。')
