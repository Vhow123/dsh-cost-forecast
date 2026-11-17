// 对话费用预测（宿主半部）— 价目表读取 + 配置读写 + HTTP 接口
//
// 数据通道：HTTP（/cost-forecast 前缀路由），浏览器半部 fetch 调用。
// 价目来源：~/.dsh/token-ledger/rates.json（token-ledger 插件维护，models.dev + 厂商中文页）
//   catalogue.vendors[].models[] = { id, name, prices:{input,output,cacheRead,cacheWrite}, period? }
//   prices 单位：每百万 token；vendor 级 currency 字段存在时用它，否则取 catalogue.currency
// 持久化：~/.dsh/storages/dsh-cost-forecast/config.json（手工单价覆盖 / 币种 / 开关）
// 热重载：profile patch 里给 hmr 打开本目录监听后，保存本文件即重载宿主半部。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { effectiveHolidays } from './holidays.js'

export const name = 'dsh-cost-forecast'
export const inject = ['webServer', 'dshHomePath', 'llm']

/** 价目文件相对 dsh home 的路径 */
const RATES_SEGMENTS = ['token-ledger', 'rates.json']
/** 价目文件重读节流（ms）：statSync + 解析都是同步 IO，别每请求都做 */
const RATES_CACHE_MS = 30_000
/**
 * DeepSeek 峰谷窗口（北京时间，单位：分钟）。
 * 2026-08-17 00:00 起生效：工作日 09:00–12:00、14:00–18:00 为高峰，其余时段空闲；
 * 2026-08-23 起周六、周日全天空闲；法定节假日与调休上班的周末也全天空闲。
 * 空闲价 = 高峰价的一半。
 */
const DEEPSEEK_PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]
/** 默认币种符号 */
const SYMBOLS = { CNY: '¥', USD: '$', EUR: '€' }
/** 站点价目（new-api /api/pricing）成功结果缓存时长 */
const SITE_CACHE_MS = 10 * 60_000
/** 站点价目失败结果缓存时长：短一点，网络抖动后能尽快自愈 */
const SITE_FAIL_CACHE_MS = 60_000
/** new-api 的 quota 基准：500000 quota = $1，故 ratio 1 = $2 / 百万 token */
const NEWAPI_QUOTA_PER_USD = 500_000

/** 最近请求留痕：用于判断浏览器端是否真的挂上了 dock（只有浏览器会带 UA/Origin） */
const probeLog = []

function recordProbe(req, route, query) {
  try {
    probeLog.push({
      at: Date.now(),
      route,
      query: String(query || ''),
      method: req.method || '',
      ua: String(req.headers['user-agent'] || ''),
      origin: String(req.headers.origin || ''),
      referer: String(req.headers.referer || ''),
    })
    if (probeLog.length > 30) probeLog.shift()
  } catch {
    /* 留痕失败不影响主流程 */
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** webserver.register() 的 disposer 不随 fiber 注销，同名重复注册会抛错，所以先清残留 */
function claimRoute(ctx, spec) {
  const table = ctx.webServer?.[spec.kind === 'exact' ? 'exact' : 'prefixes']
  if (table && typeof table.delete === 'function' && table.has(spec.path)) table.delete(spec.path)
  return ctx.webServer.register(spec)
}

/** 归一化模型名：仅保留小写字母与数字 —— `DeepSeek-V4.1-Flash-1017` 与 `deepseek-v4.1-flash-1017` 归一 */
function normalizeKey(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** 按北京时间取分钟数、星期（0 = 周日）与日期（YYYY-MM-DD） */
function beijingParts(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600_000)
  return {
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
    date: shifted.toISOString().slice(0, 10),
  }
}

/** 现在是否落在高峰时段：节假日与周末全天空闲，工作日只按两个高峰窗口计 */
export function isDeepseekPeak(now = new Date(), rule = 'deepseek', holidays = []) {
  const { minutes, weekday, date } = beijingParts(now)
  if (Array.isArray(holidays) && holidays.includes(date)) return false
  if (weekday === 0 || weekday === 6) return false
  return DEEPSEEK_PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end)
}

/** 取正数，否则用兜底 */
function positiveOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * new-api `/api/pricing` 一条记录 → 单价（USD / 百万 token）。
 * 折算依据：one-api/new-api 里 1 token 的 quota 成本 = model_ratio × group_ratio，
 * 而 500000 quota = $1，所以「百万 token 美元价」= ratio × group_ratio × 2。
 * 输出/缓存价都是相对输入价的倍数（completion_ratio / cache_ratio / create_cache_ratio）。
 */
function newApiEntryPrice(row, groupRatio) {
  const group = positiveOr(groupRatio, 1)
  if (row?.quota_type === 1) {
    const perCall = Number(row?.model_price)
    if (!Number.isFinite(perCall) || perCall < 0) return null
    return { perCall: perCall * group, input: null, output: null, cacheRead: null, cacheWrite: null }
  }
  const ratio = Number(row?.model_ratio)
  if (!Number.isFinite(ratio) || ratio < 0) return null
  const input = (ratio * group * 1_000_000) / NEWAPI_QUOTA_PER_USD
  return {
    perCall: null,
    input,
    output: input * positiveOr(row?.completion_ratio, 1),
    cacheRead: input * positiveOr(row?.cache_ratio, 1),
    cacheWrite: input * positiveOr(row?.create_cache_ratio, 1),
  }
}

/** 站点默认分组倍率：优先 default，其次唯一分组，否则 1 */
function pickGroupRatio(doc) {
  const table = doc?.group_ratio
  if (!table || typeof table !== 'object') return 1
  if (Number.isFinite(Number(table.default))) return Number(table.default)
  const values = Object.values(table).map(Number).filter((n) => Number.isFinite(n))
  return values.length === 1 ? values[0] : 1
}

const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  /** 展示币种：CNY / USD */
  currency: 'CNY',
  /** 小数位数 */
  decimals: 4,
  /** 预估下一轮输出 token（历史不足时的兜底） */
  defaultOutputTokens: 1000,
  /** 手工单价覆盖：`"<provider>/<model>" | "<model>"` → { input, output, cacheRead, cacheWrite }，单位同 rates.json */
  overrides: {},
  /**
   * 是否使用中转站自己公布的站点价（`<baseURL origin>/api/pricing`）。
   * 默认关闭：new-api 的 model_ratio×group_ratio×2 折算出来的数与实际扣费口径对不上，改用官方价目 + 手动覆盖。
   */
  useSitePricing: false,
  /** 本次对话预算（展示币种）；0 表示不设预算 */
  budget: 0,
  /**
   * 峰谷规则：
   * - `deepseek`（默认）：工作日 09:00–12:00、14:00–18:00 为高峰，其余时段、周末与节假日全天空闲；
   * - `none`：不判断峰谷，面板不显示峰时/谷时与倒计时。
   */
  peakRule: 'deepseek',
  /** 自动套用内置的中国法定节假日表（holidays.js）；false 时只用 peakHolidays */
  peakAutoHolidays: true,
  /** 按空闲计费的日期（YYYY-MM-DD，北京时间），在内置表之外补充，如未来年份或调休日 */
  peakHolidays: [],
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const overrides = {}
  if (src.overrides && typeof src.overrides === 'object') {
    for (const [key, value] of Object.entries(src.overrides)) {
      if (!value || typeof value !== 'object') continue
      const item = {}
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const n = Number(value[field])
        if (Number.isFinite(n) && n >= 0) item[field] = n
      }
      if (Object.keys(item).length > 0) overrides[key] = item
    }
  }
  const decimals = Number(src.decimals)
  const peakRule = src.peakRule === 'none' ? 'none' : 'deepseek'
  const peakHolidays = Array.isArray(src.peakHolidays)
    ? [...new Set(src.peakHolidays.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)))].slice(0, 366)
    : []
  return {
    version: 1,
    enabled: src.enabled !== false,
    currency: src.currency === 'USD' ? 'USD' : 'CNY',
    decimals: Number.isFinite(decimals) ? Math.min(8, Math.max(0, Math.trunc(decimals))) : DEFAULT_CONFIG.decimals,
    defaultOutputTokens:
      Number.isFinite(Number(src.defaultOutputTokens)) && Number(src.defaultOutputTokens) > 0
        ? Math.min(100_000, Math.trunc(Number(src.defaultOutputTokens)))
        : DEFAULT_CONFIG.defaultOutputTokens,
    overrides,
    useSitePricing: src.useSitePricing === true,
    budget: Number.isFinite(Number(src.budget)) && Number(src.budget) > 0 ? Number(src.budget) : 0,
    peakRule,
    peakAutoHolidays: src.peakAutoHolidays !== false,
    peakHolidays,
  }
}

export function apply(ctx) {
  const configPath = ctx.dshHomePath('storages', 'dsh-cost-forecast', 'config.json')
  const siteCachePath = ctx.dshHomePath('storages', 'dsh-cost-forecast', 'site-prices.json')
  const ratesPath = ctx.dshHomePath(...RATES_SEGMENTS)

  let config = normalizeConfig(readConfig())
  /** 价目缓存：{ at, payload } */
  let ratesCache = null
  /** 价目文件 mtime 缓存 */
  let ratesMtime = 0
  /** 站点价目缓存：provider(小写) → { at, ok, payload } */
  const siteCache = new Map()

  function readConfig() {
    try {
      if (!existsSync(configPath)) return DEFAULT_CONFIG
      return JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return DEFAULT_CONFIG
    }
  }

  /** 站点价目落盘：进程重启后先用旧值，后台再刷新 */
  function persistSiteCache() {
    try {
      const dump = {}
      for (const [key, value] of siteCache) {
        if (value?.payload?.ok) dump[key] = value.payload
      }
      mkdirSync(dirname(siteCachePath), { recursive: true })
      writeFileSync(siteCachePath, `${JSON.stringify({ version: 1, at: Date.now(), entries: dump }, null, 2)}\n`, 'utf8')
    } catch {
      /* 盘不可写时只保留内存态 */
    }
  }

  function hydrateSiteCache() {
    try {
      if (!existsSync(siteCachePath)) return
      const doc = JSON.parse(readFileSync(siteCachePath, 'utf8'))
      for (const [key, payload] of Object.entries(doc?.entries ?? {})) {
        if (payload?.ok && Array.isArray(payload.entries)) siteCache.set(key, { at: Number(payload.fetchedAt) || 0, payload })
      }
    } catch {
      /* 缓存坏了就当没有 */
    }
  }
  hydrateSiteCache()

  /** 诊断：llm 服务到底长什么样（provider baseURL 拿不到的排查入口） */
  function describeLlm() {
    const out = { hasGet: typeof ctx.get === 'function', keys: [], llmType: 'undefined', listFn: false, providers: [], error: null }
    try {
      out.keys = Object.keys(ctx).filter((k) => /llm|provider|model/i.test(k)).slice(0, 30)
      const svc = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
      out.llmType = svc ? typeof svc : 'undefined'
      out.llmKeys = svc ? Object.keys(svc).slice(0, 40) : []
      out.listFn = typeof svc?.listProviders === 'function'
      const list = out.listFn ? svc.listProviders() : []
      out.providers = (Array.isArray(list) ? list : []).map((item) => ({
        id: item?.id ?? null,
        name: item?.name ?? null,
        baseUrl: item?.baseUrl ?? item?.baseURL ?? null,
        keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 20) : [],
      }))
    } catch (error) {
      out.error = String(error?.message ?? error)
    }
    try {
      out.homePath = ctx.dshHomePath('profiles', 'desktop', 'cordis.patch.yml')
      out.homeExists = existsSync(out.homePath)
      out.probeBaseUrl = baseUrlFromProfilePatch('a6api')
    } catch (error) {
      out.homePathError = String(error?.message ?? error)
    }
    return out
  }

  /**
   * 回退：llm 的 listProviders() 只给 {id,name}，拿不到 baseURL，
   * 于是直接读 profile 的 cordis.patch.yml（llm 适配器的 providers 段）抓 `baseURL:`。
   */
  function baseUrlFromProfilePatch(provider) {
    const wanted = String(provider ?? '').trim()
    if (wanted === '') return null
    const candidates = []
    try {
      candidates.push(ctx.dshHomePath('profiles', 'desktop', 'cordis.patch.yml'))
    } catch {
      /* dshHomePath 不可用时跳过 */
    }
    let profilesDir = null
    try {
      profilesDir = ctx.dshHomePath('profiles')
    } catch {
      profilesDir = null
    }
    if (profilesDir && existsSync(profilesDir)) {
      try {
        for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
          if (entry.isDirectory()) candidates.push(join(profilesDir, entry.name, 'cordis.patch.yml'))
        }
      } catch {
        /* 目录不可读就只试 desktp 默认路径 */
      }
    }

    const pattern = new RegExp('^\\s*' + wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*$', 'i')
    for (const file of candidates) {
      if (!existsSync(file)) continue
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        if (!pattern.test(lines[i])) continue
        const indent = lines[i].match(/^\s*/)[0].length
        for (let j = i + 1; j < lines.length; j += 1) {
          const line = lines[j]
          if (line.trim() === '') continue
          const cur = line.match(/^\s*/)[0].length
          if (cur <= indent) break
          const hit = line.match(/^\s*base_?[uU][rR][lL]:\s*['"]?([^'"#\s]+)['"]?\s*$/)
          if (hit) return hit[1]
        }
      }
    }
    return null
  }

  /** 从 llm 运行时里找出 provider 的 baseURL（宿主侧才知道，客户端拿不到） */
  function providerBaseUrl(provider) {
    const wanted = String(provider ?? '').trim().toLowerCase()
    if (wanted === '') return null
    try {
      const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
      const list = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
      for (const item of Array.isArray(list) ? list : []) {
        if (String(item?.id ?? '').toLowerCase() !== wanted) continue
        const base = item?.baseUrl ?? item?.baseURL ?? null
        if (typeof base === 'string' && base !== '') return base
        // listProviders() 目前只回 {id,name}，拿不到 baseURL 时继续走 profile 回退
        break
      }
    } catch {
      /* 服务未就绪时当作拿不到 baseURL */
    }
    return baseUrlFromProfilePatch(provider)
  }

  /**
   * 抓中转站自己的价目（new-api 方言：GET <origin>/api/pricing）。
   * 拿不到就返回 ok:false，浏览器侧自动回退到 rates.json 的官方价。
   */
  async function loadSitePrices(provider) {
    const key = String(provider ?? '').trim().toLowerCase()
    if (key === '') return { ok: false, provider: '', error: '未指定 provider', entries: [], fetchedAt: Date.now() }
    const hit = siteCache.get(key)
    if (hit) {
      const ttl = hit.payload?.ok ? SITE_CACHE_MS : SITE_FAIL_CACHE_MS
      if (Date.now() - hit.at < ttl) return hit.payload
    }

    const baseUrl = providerBaseUrl(provider)
    if (!baseUrl) {
      const payload = { ok: false, provider, error: '未在 llm 运行时里找到该 provider 的 baseURL', entries: [], fetchedAt: Date.now() }
      siteCache.set(key, { at: Date.now(), payload })
      return payload
    }
    let url
    try {
      url = `${new URL(baseUrl).origin}/api/pricing`
    } catch {
      const payload = { ok: false, provider, error: `baseURL 不合法：${baseUrl}`, entries: [], fetchedAt: Date.now() }
      siteCache.set(key, { at: Date.now(), payload })
      return payload
    }

    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = await res.json()
      const rows = Array.isArray(doc?.data) ? doc.data : []
      if (rows.length === 0) throw new Error('定价接口没有返回模型')
      const groupRatio = pickGroupRatio(doc)
      const entries = []
      for (const row of rows) {
        const model = String(row?.model_name ?? '').trim()
        if (model === '') continue
        const prices = newApiEntryPrice(row, groupRatio)
        if (!prices) continue
        entries.push({
          model,
          key: normalizeKey(model),
          currency: 'USD',
          quotaType: row?.quota_type === 1 ? 1 : 0,
          prices,
        })
      }
      const payload = {
        ok: true,
        provider,
        url,
        fetchedAt: Date.now(),
        groupRatio,
        pricingVersion: doc?.pricing_version ?? null,
        usableGroup: doc?.usable_group ?? null,
        entries,
      }
      siteCache.set(key, { at: Date.now(), payload })
      persistSiteCache()
      return payload
    } catch (error) {
      const payload = {
        ok: false,
        provider,
        url,
        error: String(error?.message ?? error),
        entries: [],
        fetchedAt: Date.now(),
      }
      siteCache.set(key, { at: Date.now(), payload })
      return payload
    }
  }

  function writeConfig(next) {
    config = normalizeConfig(next)
    try {
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    } catch {
      /* 盘只读时保持内存态，不阻断 UI */
    }
    return config
  }

  /**
   * 把 rates.json 摊平成浏览器侧好用的结构。
   * 每条 = { key, id, name, vendor, currency, period, prices }
   * key 为归一化模型名（peak / offPeak 两条同 key，靠 period 区分）。
   */
  function buildCatalogue() {
    let stamp = 0
    try {
      stamp = statSync(ratesPath).mtimeMs
    } catch {
      return { ok: false, error: `价目文件不存在：${ratesPath}`, entries: [], fx: null }
    }
    if (ratesCache && ratesCache.stamp === stamp && Date.now() - ratesCache.at < RATES_CACHE_MS) {
      return ratesCache.payload
    }

    let doc
    try {
      doc = JSON.parse(readFileSync(ratesPath, 'utf8'))
    } catch (error) {
      return { ok: false, error: `价目文件解析失败：${String(error?.message ?? error)}`, entries: [], fx: null }
    }

    const catalogue = doc?.catalogue ?? {}
    const baseCurrency = String(catalogue.currency ?? 'USD').toUpperCase()
    const fx = doc?.fx ?? null
    const entries = []
    for (const vendor of Array.isArray(catalogue.vendors) ? catalogue.vendors : []) {
      const vendorCurrency = String(vendor?.currency ?? baseCurrency).toUpperCase()
      for (const model of Array.isArray(vendor?.models) ? vendor.models : []) {
        const prices = model?.prices
        if (!prices || typeof prices !== 'object') continue
        const price = (field) => {
          // null / undefined 必须保持 null：Number(null) 是 0，会把「该厂商不收此项费用」算成免费
          if (prices[field] == null) return null
          const n = Number(prices[field])
          return Number.isFinite(n) && n >= 0 ? n : null
        }
        const entry = {
          key: normalizeKey(model?.name ?? model?.id),
          id: String(model?.id ?? ''),
          name: String(model?.name ?? model?.id ?? ''),
          vendor: String(vendor?.vendor ?? ''),
          currency: vendorCurrency,
          period: typeof model?.period === 'string' ? model.period : null,
          prices: {
            input: price('input'),
            output: price('output'),
            cacheRead: price('cacheRead'),
            cacheWrite: price('cacheWrite'),
          },
        }
        if (entry.key === '') continue
        entries.push(entry)
      }
    }

    const holidays = effectiveHolidays(config)
    const payload = {
      ok: true,
      fetchedAt: Date.now(),
      ratesUpdatedAt: Number(doc?.lastRefresh ?? 0) || null,
      baseCurrency,
      fxRate: Number(fx?.rate) > 0 ? Number(fx.rate) : null,
      entries,
      deepseekOffPeak: !isDeepseekPeak(new Date(), config.peakRule, holidays),
      peakRule: config.peakRule,
      peakHolidays: holidays,
    }
    ratesCache = { at: Date.now(), stamp, payload }
    ratesMtime = stamp
    return payload
  }

  ctx.effect(
    () =>
      claimRoute(ctx, {
        kind: 'prefix',
        path: '/cost-forecast',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://localhost')
            const route = url.pathname.replace(/\/+$/, '')
            recordProbe(req, route, url.search)

            if (req.method === 'GET' && route === '/cost-forecast/debug') {
              sendJson(res, 200, { ok: true, debug: describeLlm() })
              return
            }

            if (req.method === 'GET' && route === '/cost-forecast/probe') {
              sendJson(res, 200, { ok: true, probe: probeLog })
              return
            }

            if (req.method === 'GET' && route === '/cost-forecast/catalogue') {
              const catalogue = buildCatalogue()
              const provider = String(url.searchParams.get('provider') ?? '').trim()
              const site = config.useSitePricing !== true || provider === '' ? null : await loadSitePrices(provider)
              sendJson(res, 200, { ok: true, catalogue, site, config, ratesPath, ratesMtime })
              return
            }

            if (req.method === 'GET' && route === '/cost-forecast/site') {
              const provider = String(url.searchParams.get('provider') ?? '').trim()
              const site =
                config.useSitePricing !== true || provider === ''
                  ? { ok: false, provider, error: '站点价已关闭（config.useSitePricing=false）', entries: [] }
                  : await loadSitePrices(provider)
              sendJson(res, 200, { ok: true, site })
              return
            }

            if (req.method === 'GET' && route === '/cost-forecast/config') {
              sendJson(res, 200, { ok: true, config })
              return
            }

            if (req.method === 'POST' && route === '/cost-forecast/config') {
              const body = await readJsonBody(req)
              sendJson(res, 200, { ok: true, config: writeConfig({ ...config, ...body }) })
              return
            }

            sendJson(res, 404, { ok: false, error: `未知接口：${route}` })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    'dsh-cost-forecast: http route',
  )

  // 任何一处配置改动都让价目缓存失效，避免覆盖项要等 30s 才生效
  const invalidate = () => {
    ratesCache = null
  }
  invalidate()
}
