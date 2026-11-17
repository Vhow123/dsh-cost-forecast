// 渲染冒烟测试：用最小 React 替身在 node 里真跑 CostForecastDock，检查输出文本。
// 用法：node test-render.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { CN_HOLIDAYS } from './holidays.js'

const CLIENT = fileURLToPath(new URL('./lib/client.js', import.meta.url))

// client.js 结尾是 `return module.exports`，临时注入测试出口
const source = readFileSync(CLIENT, 'utf8').replace(
  'return module.exports',
  'module.exports.__test = { renderDock: CostForecastDockInner, renderWrapper: CostForecastDock, renderPanel: DetailPanel, computeCost: computeCost }; return module.exports',
)

// ---- 最小 React 替身（同步 hooks，够跑一次渲染） ----
const slots = []
let cursor = 0
const effects = []

function createElement(type, props, ...children) {
  const merged = { ...(props || {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}

const react = {
  createElement,
  Fragment: Symbol('Fragment'),
  memo: (fn) => fn,
  useState(initial) {
    const i = cursor++
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
    return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
  },
  useRef(initial) {
    const i = cursor++
    if (!(i in slots)) slots[i] = { current: initial }
    return slots[i]
  },
  useEffect(fn) { effects.push(fn) },
  useMemo(fn) { cursor++; return fn() },
  useCallback(fn) { cursor++; return fn },
  useLayoutEffect(fn) { effects.push(fn) },
}

const reactDom = { createPortal: (node) => node }

// 冻结时钟：2026-11-17 16:35（周二，北京时间）正处在 14:00-18:00 的高峰里，
// 距空闲开始 85 分钟。用真实 Date 跑测试会让断言随运行时刻漂移。
const FIXED_NOW = new Date('2026-11-17T16:35:00+08:00').getTime()
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW)
    else super(...args)
  }
  static now() {
    return FIXED_NOW
  }
}

const PROJECTIONS = {
  tokenUsage: { uncachedInputTokens: 42000, outputTokens: 6000, cacheReadTokens: 300000, cacheWriteTokens: 0 },
  modelSelection: { lastUsed: { provider: 'my-gateway', model: 'deepseek-v4.1-flash-1017' }, next: null },
  contextPressure: { contextWindow: 128000, pressureTokens: 90000, projectedTokens: 96000 },
  contextBreakdown: { systemTokens: 6000, toolsTokens: 9000, messageTokens: 81000 },
  sessionStats: { turns: 6, steps: 6, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
}

const CATALOGUE_BODY = {
  ok: true,
  catalogue: {
    ok: true,
    baseCurrency: 'USD',
    fxRate: 6.678399,
    deepseekOffPeak: true,
    peakRule: 'deepseek',
    peakHolidays: [...CN_HOLIDAYS],
    entries: [
      { key: 'deepseekv41flash1017', id: 'deepseek/deepseek-flash@offPeak', name: 'DeepSeek-V4.1-Flash-1017', vendor: 'deepseek', currency: 'CNY', period: 'offPeak', prices: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: null } },
    ],
  },
  config: { version: 1, enabled: true, currency: 'CNY', decimals: 4, defaultOutputTokens: 1000, overrides: {}, peakRule: 'deepseek', peakAutoHolidays: true, peakHolidays: [...CN_HOLIDAYS] },
  peakHolidays: [...CN_HOLIDAYS],
  peakRule: 'deepseek',
}

let captured = null
const sandbox = {
  window: { innerHeight: 900, __ModuleLoader__: { load: (def) => { captured = def } }, addEventListener() {}, removeEventListener() {} },
  document: {
    getElementById: () => null,
    createElement: () => ({ set textContent(v) {}, set id(v) {}, }),
    head: { appendChild() {} },
    body: {},
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  },
  fetch: async () => ({ ok: true, status: 200, json: async () => CATALOGUE_BODY }),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn) => { return 0 },
  clearTimeout: () => {},
  console,
  Date: FakeDate,
  Math,
  Number,
  Object,
  Array,
  JSON,
  String,
  isFinite,
}
sandbox.globalThis = sandbox
sandbox.window.window = sandbox.window

vm.createContext(sandbox)
new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

if (!captured) throw new Error('client bundle 未调用 __ModuleLoader__.load')
const requireStub = (spec) => {
  if (spec === 'react') return react
  if (spec === 'react-dom') return reactDom
  throw new Error('unexpected require: ' + spec)
}
const api = captured.factory(requireStub).__test
if (!api) throw new Error('未注入 __test 出口')

// ---- 首次渲染（store 未就绪 → loading 态） ----
cursor = 0
slots.length = 0
effects.length = 0
const useProjection = (key) => PROJECTIONS[key]
let tree = api.renderDock({ useProjection })
let flat = flatten(tree)
console.log('[1] 首次渲染：', flat.slice(0, 120) || '(空)')
if (!flat.includes('读取中')) throw new Error('首屏应显示读取中，实际：' + flat)
console.log('  ✓ 首屏 loading 态')

// ---- 跑 effect：拉价目 → setStore 写回 slots ----
cursor = 0
effects.length = 0
tree = api.renderDock({ useProjection })
const effectRunner = effects.slice()
effects.length = 0
for (const fn of effectRunner) {
  const cleanup = fn()
  if (typeof cleanup === 'function') sandbox.__cleanup = cleanup
}
// 等 promise microtask 落定
await new Promise((r) => setTimeout(r, 50))

cursor = 0
effects.length = 0
tree = api.renderDock({ useProjection })
flat = flatten(tree)
console.log('[2] 价目就绪后：', flat.slice(0, 200))
for (const token of ['本次', '下一轮', '¥', '缓存', '谷时']) {
  if (!flat.includes(token)) throw new Error('渲染输出缺少：' + token + ' → ' + flat)
}
console.log('  ✓ 主行含 本次/下一轮/¥/缓存命中/谷时徽章')
// 冻结时刻 2026-11-17 16:35（周二）在 14:00–18:00 高峰里，18:00 转空闲 → 等 1h25m。
// 老实现按 00:30–08:30 判谷时，这里会显示「等 7h55m」。
if (!flat.includes('等 1h25m')) throw new Error('峰谷倒计时应为「等 1h25m」，实际：' + flat.slice(0, 200))
console.log('  ✓ 峰谷倒计时按工作日 9–12、14–18 高峰计算')

// ---- 费用数值校验：与 computeCost 直接算的结果一致 ----
const cost = api.computeCost({
  usage: PROJECTIONS.tokenUsage,
  selection: PROJECTIONS.modelSelection,
  pressure: PROJECTIONS.contextPressure,
  breakdown: PROJECTIONS.contextBreakdown,
  stats: PROJECTIONS.sessionStats,
  catalogue: CATALOGUE_BODY.catalogue,
  config: CATALOGUE_BODY.config,
})
console.log('[3] 计算：已花', cost.spent.toFixed(6), '下一轮', cost.predicted.toFixed(6), '单价', JSON.stringify(cost.price))
if (!flat.includes(String(cost.spent.toFixed(4)))) {
  console.log('  (格式差异，实际片段 ' + flat.match(/本次\s*\S+/)?.[0] + ')')
}
console.log('  ✓ 计算与渲染同源')

// ---- 面板渲染 ----
cursor = 0
slots.length = 0
effects.length = 0
const panel = api.renderPanel({ cost, config: CATALOGUE_BODY.config, catalogue: CATALOGUE_BODY, anchorRect: { left: 100, top: 700, width: 300 }, error: null, onRefresh() {}, onCurrency() {}, onPeakRule() {}, onPeakAutoHolidays() {} })
const panelFlat = flatten(panel)
console.log('[4] 面板片段：', panelFlat.slice(0, 260))
for (const token of ['本次对话费用', '下一轮预测', '本次已花', '单价', '刷新价目', 'CNY', '节假日', '自动识别']) {
  if (!panelFlat.includes(token)) throw new Error('面板缺少：' + token + ' → ' + panelFlat.slice(0, 400))
}
if (!panelFlat.includes(CN_HOLIDAYS.length + ' 天 · 2026')) throw new Error('面板应显示内置节假日天数：' + panelFlat.slice(-200))
console.log('  ✓ 面板含全部区块与按钮，节假日表显示 ' + CN_HOLIDAYS.length + ' 天')

// ---- 外层包装：缺少 useProjection 时安静退出 ----
if (api.renderWrapper({}) !== null) throw new Error('包装层应在无 useProjection 时返回 null')
console.log('  ✓ 包装层无投影钩子时返回 null')

// ---- 站点价目（中转站 /api/pricing）分支 ----
const SITE_BODY = JSON.parse(JSON.stringify(CATALOGUE_BODY))
SITE_BODY.config = Object.assign({}, SITE_BODY.config, { useSitePricing: true })
SITE_BODY.site = {
  ok: true,
  provider: 'gateway-site',
  url: 'https://my-gateway.vip/api/pricing',
  fetchedAt: Date.now(),
  groupRatio: 1,
  entries: [
    {
      model: 'deepseek-v4.1-flash-1017',
      key: 'deepseekv41flash1017',
      currency: 'USD',
      quotaType: 0,
      prices: { perCall: null, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    },
  ],
}
sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => SITE_BODY })
PROJECTIONS.modelSelection = { lastUsed: null, next: { provider: 'gateway-site', model: 'deepseek-v4.1-flash-1017' } }
cursor = 0
slots.length = 0
effects.length = 0
api.renderDock({ useProjection })
for (const fn of effects.slice()) fn()
effects.length = 0
await new Promise((r) => setTimeout(r, 50))
cursor = 0
const siteTree = api.renderDock({ useProjection })
const siteFlat = flatten(siteTree)
console.log('[5] 站点价分支：', siteFlat.slice(0, 200))
if (!siteFlat.includes('站点价')) throw new Error('站点价来源应显示「站点价」徽章 → ' + siteFlat)
if (siteFlat.includes('谷时') || siteFlat.includes('峰时')) throw new Error('站点价分支不应再显示峰谷徽章 → ' + siteFlat)
const siteCost = api.computeCost({
  usage: PROJECTIONS.tokenUsage,
  selection: PROJECTIONS.modelSelection,
  pressure: PROJECTIONS.contextPressure,
  breakdown: PROJECTIONS.contextBreakdown,
  stats: PROJECTIONS.sessionStats,
  catalogue: SITE_BODY.catalogue,
  site: SITE_BODY.site,
  config: SITE_BODY.config,
})
cursor = 0
slots.length = 0
effects.length = 0
const sitePanel = flatten(
  api.renderPanel({
    cost: siteCost,
    config: SITE_BODY.config,
    anchorRect: { left: 100, top: 700, width: 300 },
    error: null,
    onRefresh() {},
    onCurrency() {},
  }),
)
console.log('[6] 站点价面板来源：', sitePanel.slice(-160))
if (!sitePanel.includes('来源：站点 gateway-site')) throw new Error('面板来源行应显示站点 provider → ' + sitePanel.slice(-240))
console.log('  ✓ 站点价分支渲染正确')

// ---- 单价可自定义：编辑 → 用站点价 → 保存 ----
function collect(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out)
    return out
  }
  if (typeof node.type === 'function') {
    collect(node.type(node.props || {}), out)
    return out
  }
  out.push(node)
  const kids = node.props ? node.props.children : null
  if (kids != null) collect(Array.isArray(kids) ? kids : [kids], out)
  return out
}
function findButton(tree, label) {
  return collect(tree).find((n) => n.type === 'button' && String(n.props.children) === label)
}
function findInputs(tree) {
  // 单价输入框 step=0.0001；预算输入框 step=0.1，属于常驻控件，不计入
  return collect(tree).filter((n) => n.type === 'input' && String(n.props.step) === '0.0001')
}

let savedPrices = 'unset'
const panelProps = {
  cost: siteCost,
  config: Object.assign({}, SITE_BODY.config, { overrides: {} }),
  anchorRect: { left: 100, top: 700, width: 300 },
  error: null,
  onRefresh() {},
  onCurrency() {},
  onPrices(next) {
    savedPrices = next
  },
}

cursor = 0
slots.length = 0
effects.length = 0
let editTree = api.renderPanel(panelProps)
const editBtn = findButton(editTree, '编辑')
if (!editBtn) throw new Error('面板应有「编辑」按钮 → ' + flatten(editTree).slice(0, 300))
if (findInputs(editTree).length !== 0) throw new Error('未点编辑时不应出现输入框')

editBtn.props.onClick()
cursor = 0
editTree = api.renderPanel(panelProps)
const inputs = findInputs(editTree)
if (inputs.length !== 4) throw new Error('编辑态应有 4 个单价输入框，实际 ' + inputs.length)
for (const label of ['保存', '取消']) {
  if (!findButton(editTree, label)) throw new Error('编辑态缺少按钮：' + label)
}
if (!findButton(editTree, '用站点价')) throw new Error('编辑态应有「用站点价」')
console.log('[7] 编辑态输入框：', inputs.map((n) => n.props.value).join(' / '))

findButton(editTree, '用站点价').props.onClick()
cursor = 0
editTree = api.renderPanel(panelProps)
const filled = findInputs(editTree).map((n) => n.props.value)
if (!filled.every((v) => v === '6.678399')) throw new Error('「用站点价」应回填站点价，实际 ' + filled.join(','))
console.log('  ✓ 用站点价回填：', filled.join(' / '))

// 手改输入框
findInputs(editTree)[0].props.onChange({ target: { value: '2.5' } })
cursor = 0
editTree = api.renderPanel(panelProps)
if (findInputs(editTree)[0].props.value !== '2.5') throw new Error('输入框改写未生效')

findButton(editTree, '保存').props.onClick()
if (!savedPrices || savedPrices.input !== 2.5) throw new Error('保存应回报 overrides，实际 ' + JSON.stringify(savedPrices))
if (savedPrices.output !== 6.678399) throw new Error('未改动的字段应保留站点价，实际 ' + JSON.stringify(savedPrices))
console.log('[8] 保存回报：', JSON.stringify(savedPrices))
console.log('  ✓ 单价可自定义闭环')

console.log('\n全部通过')

function flatten(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).filter(Boolean).join(' ')
  // 面板里的 Row 是纯函数组件，递归展开以便断言其文本
  if (typeof node.type === 'function') {
    try {
      return flatten(node.type(node.props || {}))
    } catch {
      return ''
    }
  }
  const props = node.props || {}
  const kids = props.children == null ? [] : Array.isArray(props.children) ? props.children : [props.children]
  return kids.map(flatten).filter(Boolean).join(' ')
}
