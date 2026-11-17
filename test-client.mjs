// 客户端半部逻辑自测：用 vm 加载 lib/client.js，stub react / react-dom / window / fetch，
// 把闭包里的 computeCost / matchEntry 抽出来对真实价目跑一遍。
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SRC = 'F:/杂项/dsh-cost-forecast/lib/client.js'
const src = readFileSync(SRC, 'utf8').replace(
  'return module.exports',
  'module.exports.__test = { computeCost, matchEntry, formatMoney, normalizeKey, convert, pickByPeriod, peakWindow, isPeakAt }; return module.exports',
)

let captured = null
const noop = () => {}
const reactStub = {
  createElement: (...args) => ({ args }),
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop,
  useRef: () => ({ current: null }),
  Fragment: 'Fragment',
}
const requireStub = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react-dom') return { createPortal: noop }
  throw new Error('unexpected require: ' + id)
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (def) => {
        captured = def
      },
    },
  },
  document: { head: { appendChild: noop }, getElementById: () => null, createElement: () => ({}) },
  fetch: () => Promise.reject(new Error('no network in test')),
  console,
  setInterval: () => 0,
  clearInterval: noop,
  Date,
  Math,
  Number,
  JSON,
}
createContext(sandbox)
runInContext(src, sandbox, { filename: SRC })

if (!captured) throw new Error('factory 未被捕获')
const mod = captured.factory(requireStub)
const T = mod.__test
if (!T) throw new Error('__test 抽口缺失')

// ---- 真实价目（复用宿主半部的解析逻辑）----
const { apply } = await import('file:///F:/杂项/dsh-cost-forecast/index.js')
const routes = []
apply({
  webServer: { prefixes: new Map(), register: (spec) => (routes.push(spec), noop) },
  dshHomePath: (...segs) => join(homedir(), '.dsh', ...segs),
  effect: (fn) => fn(),
})
const res = { writeHead: noop, end(b) { this.body = b } }
await routes[0].handler({ method: 'GET', url: '/cost-forecast/catalogue' }, res)
const catalogue = JSON.parse(res.body).catalogue
const config = JSON.parse(res.body).config

const assert = (cond, msg) => {
  if (!cond) throw new Error('断言失败: ' + msg)
  console.log('  ✓ ' + msg)
}

console.log('价目条目:', catalogue.entries.length, '| 基币:', catalogue.baseCurrency, '| fx:', catalogue.fxRate, '| offPeak:', catalogue.deepseekOffPeak)

// ---- 1. 模型名匹配 ----
console.log('\n[1] 模型名匹配')
const m1 = T.matchEntry(catalogue.entries, 'deepseek-v4.1-flash-1017', true)
assert(m1 && m1.period === 'offPeak', 'dagster a6api 的 deepseek-v4.1-flash-1017 → 谷时条目')
const m1p = T.matchEntry(catalogue.entries, 'deepseek-v4.1-flash-1017', false)
assert(m1p && m1p.period === 'peak', '同时刻切峰时 → 峰时条目')
const m2 = T.matchEntry(catalogue.entries, 'grok-4.7', false)
assert(m2 && m2.vendor === 'x-ai', 'grok-4.7 → x-ai')
const m3 = T.matchEntry(catalogue.entries, 'glm-5.3-flash', false)
assert(m3 && m3.vendor === 'z-ai', 'glm-5.3-flash → z-ai')
const m4 = T.matchEntry(catalogue.entries, 'deepseek-v4.1-flash', false)
assert(m4 && m4.key === 'deepseekv41flash1017', '短名 deepseek-v4.1-flash 前缀退化匹配到 1017')
const m5 = T.matchEntry(catalogue.entries, 'no-such-model-xyz', false)
assert(m5 === null, '未知模型 → null')

// ---- 2. 费用计算：DeepSeek 谷时 ----
console.log('\n[2] 费用计算（DeepSeek 谷时）')
const offPeakCatalogue = { ...catalogue, deepseekOffPeak: true }
const usage = {
  uncachedInputTokens: 12_000,
  outputTokens: 4_000,
  cacheReadTokens: 88_000,
  cacheWriteTokens: 0,
}
const cost = T.computeCost({
  usage,
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 120_000, contextWindow: 1_000_000 },
  stats: { turns: 4 },
  catalogue: offPeakCatalogue,
  config,
})
assert(cost.priced === true, '命中价目')
assert(cost.price.input === 1, '谷时输入价 = ¥1/M')
assert(cost.price.output === 4, '谷时输出价 = ¥4/M')
assert(cost.price.cacheRead === 0.02, '谷时缓存读 = ¥0.02/M')
assert(cost.price.cacheWrite === 1, 'cacheWrite 为 null 时回退输入价')
// 已花 = 12000*1/1e6 + 88000*0.02/1e6 + 4000*4/1e6 = 0.012 + 0.00176 + 0.016
const expectSpent = 0.012 + 0.00176 + 0.016
assert(Math.abs(cost.spent - expectSpent) < 1e-9, `已花 ${cost.spent.toFixed(6)} ≈ ${expectSpent.toFixed(6)}`)
assert(Math.abs(cost.tokens.hitRatio - 0.88) < 1e-9, '缓存命中率 = 88000/(12000+88000) = 88%')
assert(Math.abs(cost.tokens.avgOutput - 1000) < 1e-9, '历史均值输出 = 4000/4 = 1000')
// 下一轮 = 120000*0.88*0.02/1e6 + 120000*0.12*1/1e6 + 1000*4/1e6 = 0.002112 + 0.0144 + 0.004
const expectNext = 0.002112 + 0.0144 + 0.004
assert(Math.abs(cost.predicted - expectNext) < 1e-9, `下一轮 ${cost.predicted.toFixed(6)} ≈ ${expectNext.toFixed(6)}`)
assert(cost.priceSource === 'catalogue', '价格来源 = catalogue')

// ---- 3. 峰谷切换 ----
console.log('\n[3] 峰时（deepseekOffPeak=false）')
const peakCatalogue = { ...catalogue, deepseekOffPeak: false }
const costPeak = T.computeCost({
  usage,
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 120_000, contextWindow: 1_000_000 },
  stats: { turns: 4 },
  catalogue: peakCatalogue,
  config,
})
assert(costPeak.price.input === 2 && costPeak.price.output === 8, '峰时输入 ¥2 / 输出 ¥8')
assert(costPeak.spent > cost.spent * 1.9, '峰时费用约为谷时两倍')

// ---- 4. USD 价目换算 ----
console.log('\n[4] USD 价目换算人民币')
const usdCost = T.computeCost({
  usage: { uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  selection: { next: { provider: 'apiling', model: 'gpt-6.1-terra' } },
  pressure: { projectedTokens: 0 },
  stats: { turns: 1 },
  catalogue: offPeakCatalogue,
  config,
})
assert(usdCost.priced, 'gpt-6.1-terra 命中')
const fx = catalogue.fxRate
assert(Math.abs(usdCost.price.input - 1 * fx) < 1e-9, `输入 $1/M → ¥${(1 * fx).toFixed(4)}/M`)
assert(Math.abs(usdCost.spent - (1 + 5) * fx) < 1e-9, `已花 = (1+5) USD × ${fx} ≈ ¥${((6) * fx).toFixed(4)}`)

// ---- 5. 手工覆盖 ----
console.log('\n[5] 手工单价覆盖')
const overrideCost = T.computeCost({
  usage: { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 0 },
  stats: { turns: 1 },
  catalogue: offPeakCatalogue,
  config: { ...config, useSitePricing: true, overrides: { 'a6api/deepseek-v4.1-flash-1017': { input: 0.5, output: 2 } } },
})
assert(overrideCost.priceSource === 'override', '覆盖生效')
assert(overrideCost.spent === 0.5, '按覆盖价 ¥0.5/M 计算')

// ---- 6. 新会话兜底 ----
console.log('\n[6] 新会话（无用量）')
const fresh = T.computeCost({ usage: undefined, selection: null, pressure: null, stats: null, catalogue, config })
assert(fresh.spent === 0, '已花 0')
assert(fresh.tokens.hitRatio === 0.8, '命中率回退经验值 80%')
assert(fresh.tokens.avgOutput === config.defaultOutputTokens, '输出回退配置值')

// ---- 7. 金额格式 ----
console.log('\n[7] 金额格式')
assert(T.formatMoney(0.000123, 'CNY') === '¥0.000123', '小额 6 位')
assert(T.formatMoney(0.0123, 'CNY') === '¥0.0123', '分位 4 位')
assert(T.formatMoney(0.0875, 'CNY') === '¥0.0875', '角分 4 位')
assert(T.formatMoney(0.5, 'CNY') === '¥0.500', '亚元 3 位')
assert(T.formatMoney(12.345, 'CNY') === '¥12.35', '元级 2 位')
assert(T.formatMoney(1234.5, 'USD') === '$1,234.50', '千分位')

// ---- 8. 站点价目（中转站 /api/pricing）优先于官方价目 ----
console.log('\n[8] 站点价目优先')
const site = {
  ok: true,
  provider: 'a6api',
  url: 'https://a6api.vip/api/pricing',
  fetchedAt: Date.now(),
  groupRatio: 1,
  entries: [
    {
      model: 'deepseek-v4.1-flash-1017',
      key: T.normalizeKey('deepseek-v4.1-flash-1017'),
      currency: 'USD',
      quotaType: 0,
      prices: { perCall: null, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    },
  ],
}
const siteUsage = { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
const siteCost = T.computeCost({
  usage: siteUsage,
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 0 },
  stats: { turns: 1 },
  catalogue: offPeakCatalogue,
  site,
  config: { ...config, useSitePricing: true },
})
assert(siteCost.priceSource === 'site', '站点价目优先于官方价目')
assert(Math.abs(siteCost.price.input - fx) < 1e-9, `站点 $1/M 输入 → ¥${fx.toFixed(4)}/M`)
assert(Math.abs(siteCost.price.output - fx) < 1e-9, '站点 $1/M 输出（completion_ratio=1）')
assert(Math.abs(siteCost.price.cacheRead - fx) < 1e-9, '站点缓存读（cache_ratio=1）不打折')
assert(Math.abs(siteCost.spent - fx) < 1e-9, `已花 = 1M × ¥${fx.toFixed(4)}`)
assert(siteCost.siteProvider === 'a6api', '记录站点 provider 供面板展示')

const siteVsOverride = T.computeCost({
  usage: siteUsage,
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 0 },
  stats: { turns: 1 },
  catalogue: offPeakCatalogue,
  site,
  config: { ...config, useSitePricing: true, overrides: { 'a6api/deepseek-v4.1-flash-1017': { input: 0.5, output: 2 } } },
})
assert(siteVsOverride.priceSource === 'override', '手工覆盖仍压过站点价')

const siteFallback = T.computeCost({
  usage: siteUsage,
  selection: { next: { provider: 'apiling', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 0 },
  stats: { turns: 1 },
  catalogue: offPeakCatalogue,
  site: { ok: false, provider: 'apiling', url: 'https://api.apiling.xyz/api/pricing', error: 'HTTP 404', entries: [] },
  config: { ...config, useSitePricing: true },
})
assert(siteFallback.priceSource === 'catalogue', '站点无定价接口 → 回退官方价目')
assert(siteFallback.siteError === 'HTTP 404', '保留站点错误信息供面板提示')

// 默认关闭站点价：即便宿主下发了 site，也只用官方价目
const siteOff = T.computeCost({
  usage: siteUsage,
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 0 },
  stats: { turns: 1 },
  catalogue: offPeakCatalogue,
  site,
  config,
})
assert(siteOff.priceSource === 'catalogue', 'config.useSitePricing 缺省时应忽略站点价')
assert(Math.abs(siteOff.price.input - 1) < 1e-9, '缺省时用官方价（DeepSeek 谷时 ¥1/M）')
assert(siteOff.sources.site === null, '关闭时不应提供「用站点价」回填源')
assert(siteOff.siteError === '', '关闭时不显示站点错误')

// —— 派生指标：每轮均价 / 上下文余量 / 预算 / 成本构成 / 换模型比价 / 峰谷倒计时 ——
const derived = T.computeCost({
  usage: {
    uncachedInputTokens: 42000,
    cacheReadTokens: 300000,
    cacheWriteTokens: 0,
    outputTokens: 6000,
  },
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 96000, contextWindow: 128000 },
  breakdown: { systemTokens: 3000, toolsTokens: 2000, messageTokens: 90000 },
  stats: { turns: 3 },
  catalogue: offPeakCatalogue,
  config,
})
assert(Math.abs(derived.perTurn - derived.spent / 3) < 1e-12, '每轮均价 = 已花 / 轮数')
assert(derived.growthPerTurn === 30000, '每轮新增消息 token = messageTokens / turns')
assert(derived.remainingTurns === 1, '上下文余量：floor((128k-96k)/30k) = 1')
assert(derived.budget === 0 && derived.budgetState === 'none', '未设预算时 budgetState=none')

const withBudget = T.computeCost({
  usage: { uncachedInputTokens: 42000, cacheReadTokens: 300000, cacheWriteTokens: 0, outputTokens: 6000 },
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 96000, contextWindow: 128000 },
  breakdown: { systemTokens: 3000, toolsTokens: 2000, messageTokens: 90000 },
  stats: { turns: 3 },
  catalogue: offPeakCatalogue,
  config: { ...config, budget: 0.08 },
})
assert(withBudget.budgetState === 'warn', '已花占预算 90% → warn')
assert(Math.abs(withBudget.budgetRatio - withBudget.spent / 0.08) < 1e-12, 'budgetRatio = 已花 / 预算')

const overBudget = T.computeCost({
  usage: { uncachedInputTokens: 42000, cacheReadTokens: 300000, cacheWriteTokens: 0, outputTokens: 6000 },
  selection: { next: { provider: 'a6api', model: 'deepseek-v4.1-flash-1017' } },
  pressure: { projectedTokens: 96000, contextWindow: 128000 },
  breakdown: { systemTokens: 3000, toolsTokens: 2000, messageTokens: 90000 },
  stats: { turns: 3 },
  catalogue: offPeakCatalogue,
  config: { ...config, budget: 0.05 },
})
assert(overBudget.budgetState === 'over', '已花超出预算 → over')

// 成本构成求和应等于已花
const compSum = derived.composition.reduce((sum, part) => sum + part.value, 0)
assert(Math.abs(compSum - derived.spent) < 1e-9, '构成各项之和 = 已花')
assert(Math.abs(derived.composition.reduce((s, p) => s + p.ratio, 0) - 1) < 1e-9, '构成占比之和 = 1')

// 换模型比价：至少有一条，按成本升序，且都是正数
assert(Array.isArray(derived.alternatives) && derived.alternatives.length > 0, '应给出换模型候选')
assert(
  derived.alternatives.every((row, i, arr) => i === 0 || arr[i - 1].total <= row.total),
  '候选按单轮成本升序',
)
assert(derived.alternatives.length <= 5, '候选最多 5 条')

// 峰谷倒计时：距下一次切换的分钟数应落在 (0, 7 天] 内，并带规则标签
assert(derived.peak && typeof derived.peak.minutes === 'number', '应给出峰谷倒计时')
assert(derived.peak.minutes > 0 && derived.peak.minutes <= 7 * 24 * 60, '倒计时分钟数在合理区间')
assert(derived.peak.rule === 'deepseek', '默认按工作日峰谷规则')
assert(typeof derived.peak.label === 'string' && derived.peak.label.length > 0, '倒计时应带规则标签')

// —— 峰谷规则单测：2026-08-17 起官方规则（工作日 09–12、14–18 高峰）——
const bj = (text) => new Date(text + '+08:00')
const at = (text, rule, holidays) => T.peakWindow(bj(text), rule, holidays)

// 周二 16:35 在高峰里，18:00 转空闲，等 85 分钟
const t1 = at('2026-11-17T16:35:00')
assert(t1.offPeak === false, '周二 16:35 是高峰')
assert(t1.minutes === 85, '距空闲开始 85 分钟，实际 ' + t1.minutes)
// 午休 12:30 是空闲，14:00 转高峰，等 90 分钟
const t2 = at('2026-11-17T12:30:00')
assert(t2.offPeak === true, '周二 12:30 是空闲')
assert(t2.minutes === 90, '距高峰开始 90 分钟，实际 ' + t2.minutes)
// 周六全天空闲，等到周一 09:00
const t3 = at('2026-11-21T10:00:00')
assert(t3.offPeak === true, '周六是空闲')
assert(t3.minutes === 47 * 60, '周六 10:00 距周一 09:00 为 2820 分钟，实际 ' + t3.minutes)
// 周日 20:00 同样是空闲，等 13 小时
const t4 = at('2026-11-22T20:00:00')
assert(t4.offPeak === true && t4.minutes === 13 * 60, '周日 20:00 距周一 09:00 为 780 分钟，实际 ' + t4.minutes)
// 法定节假日全天空闲：把周二当节假日
const t5 = at('2026-11-17T16:35:00', 'deepseek', ['2026-11-17'])
assert(t5.offPeak === true, '节假日按空闲计费')
// 旧规则已移除：未知规则名回落到工作日峰谷，而不是旧的 00:30–08:30 谷时
const t6 = at('2026-11-17T16:35:00', 'legacy')
assert(t6.offPeak === false && t6.minutes === 85, '未知规则按工作日峰谷算，距空闲 85 分钟，实际 ' + t6.minutes)
// 不判断时不产出倒计时
const t7 = at('2026-11-17T16:35:00', 'none')
assert(t7.minutes === null && t7.rule === 'none', 'none 规则不产出倒计时')
// 内置节假日表：9/30 17:00 仍是高峰，18:00 转空闲
const t8 = at('2026-09-30T17:00:00', 'deepseek', ['2026-10-01'])
assert(t8.offPeak === false && t8.minutes === 60, '9/30 17:00 距空闲 60 分钟，实际 ' + t8.minutes)
// 国庆第一天全天空闲，要一路等到 10/8 09:00
const national = ['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07']
const t9 = at('2026-10-01T10:00:00', 'deepseek', national)
assert(t9.offPeak === true, '10/1 按节假日算空闲')
assert(t9.minutes === 7 * 24 * 60 - 60, '10/1 10:00 距 10/8 09:00 为 10020 分钟，实际 ' + t9.minutes)

console.log('\n全部通过')
