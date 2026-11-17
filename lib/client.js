// 对话费用预测（浏览器半部）— 输入框上方的费用条
//
// 数据通道：fetch 宿主半部的 /cost-forecast 接口（价目表、配置）。
// 用量数据：会话投影 tokenUsage / modelSelection / contextPressure / contextBreakdown / sessionStats。
// UI：conversation.input.dock 席位（输入框正上方），一条紧凑费用带 + 点击展开的明细面板。
window.__ModuleLoader__.load({
  id: 'dsh-cost-forecast',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var ReactDOM = require('react-dom')
    var h = React.createElement

    var API = '/cost-forecast'
    var STYLE_ID = 'dsh-cost-forecast-style'
    var CATALOGUE_TTL_MS = 60_000
    /** 未命中价目时，DeepSeek 缓存读约为输入价的 2%：仅用于不显示 0 */
    var FALLBACK_HIT_RATIO = 0.8
    /**
     * 峰谷规则表（北京时间）。`windows` 为高峰窗口，单位分钟。
     * - deepseek：2026-08-17 起官方规则，工作日 09:00–12:00、14:00–18:00 为高峰，
     *   其余时段空闲，周六周日与法定节假日全天空闲，空闲价为高峰价的一半。
     * - none：不判断，面板不显示峰时/谷时与倒计时。
     */
    var PEAK_RULES = {
      deepseek: {
        label: '工作日峰谷',
        windows: [
          [9 * 60, 12 * 60],
          [14 * 60, 18 * 60],
        ],
        weekendOffPeak: true,
      },
      none: { label: '不判断' },
    }
    /** 预算告警档位：达到 80% 提示，100% 报警 */
    var BUDGET_WARN_RATIO = 0.8

    /** 设置面板里显示节假日表收录情况：天数与年份 */
    function holidayNote(catalogue) {
      // 传进来的可能是路由返回的整包，也可能只是其中的 catalogue 子对象
      var source = catalogue && catalogue.catalogue ? catalogue.catalogue : catalogue
      var list = source && Array.isArray(source.peakHolidays) ? source.peakHolidays : []
      if (!list.length) return '未收录'
      var years = {}
      list.forEach(function (day) {
        var year = String(day).slice(0, 4)
        if (/^\d{4}$/.test(year)) years[year] = true
      })
      var keys = Object.keys(years).sort()
      return keys.length ? list.length + ' 天 · ' + keys.join('/') : list.length + ' 天'
    }

    //#region 样式
    var CSS = [
      '.dcf-bar{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px));max-width:var(--dsh-composer-card-max-width,952px);margin:0 auto;min-height:30px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:left;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
      '.dcf-bar:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}',
      '.dcf-bar:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dcf-bar[data-state="warn"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dcf-bar[data-state="loading"]{opacity:.72}',
      '.dcf-bar[data-state="loading"] .dcf-lead{color:var(--dsw-alias-label-tertiary)}',
      '.dcf-lead{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:16px;height:16px;font-size:12px;font-weight:600;color:var(--dsw-alias-brand-primary)}',
      '.dcf-main{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dcf-sep{color:var(--dsw-alias-label-dimmed)}',
      '.dcf-item{white-space:nowrap}',
      '.dcf-item b{font-weight:600;color:var(--dsw-alias-label-primary);margin-left:3px}',
      '.dcf-spacer{flex:1 1 auto}',
      '.dcf-badge{flex:0 0 auto;padding:0 6px;border-radius:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3,#0000000a)}',
      '.dcf-chevron{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:10px;transition:transform .12s ease}',
      '.dcf-bar[aria-expanded="true"] .dcf-chevron{transform:rotate(180deg)}',
      '.dcf-panel{position:fixed;z-index:2147483000;box-sizing:border-box;width:352px;max-width:calc(100vw - 24px);max-height:min(70vh,520px);overflow:auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dcf-title{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:2px}',
      '.dcf-title-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dcf-title-value{font-size:15px;font-weight:700;color:var(--dsw-alias-brand-primary)}',
      '.dcf-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:8px;word-break:break-all}',
      '.dcf-rule{height:1px;margin:8px 0;background:var(--dsw-alias-border-l2)}',
      '.dcf-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:1px 0}',
      '.dcf-row dt{color:var(--dsw-alias-label-tertiary);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dcf-row dd{margin:0;flex:0 0 auto;color:var(--dsw-alias-label-primary)}',
      '.dcf-row[data-strong="true"] dd{font-weight:600}',
      '.dcf-row[data-accent="true"] dd{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.dcf-section{margin:2px 0 4px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}',
      '.dcf-section-row{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dcf-link{padding:0;border:0;background:transparent;font-size:11px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dcf-link:hover{text-decoration:underline}',
      '.dcf-edit{display:flex;flex-direction:column;gap:6px;margin-top:2px}',
      '.dcf-field{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dcf-field-label{flex:0 0 auto}',
      '.dcf-field-input{display:flex;align-items:center;gap:4px;flex:0 1 150px;justify-content:flex-end}',
      '.dcf-field-symbol{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dcf-input{flex:1 1 auto;min-width:0;width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);font-size:12px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right;outline:none}',
      '.dcf-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dcf-edit-actions{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}',
      '.dcf-btn-sm{padding:2px 8px;font-size:11px}',
      '.dcf-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dcf-actions{display:flex;align-items:center;gap:6px;margin-top:10px}',
      '.dcf-btn{flex:0 0 auto;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dcf-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dcf-btn[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dcf-note{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-dimmed)}',
      '.dcf-note[data-state="warn"]{color:var(--dsw-alias-state-error-primary)}',
      '.dcf-note[data-state="warnable"]{color:var(--dsw-alias-state-business-primary,#c98a00)}',
      // 成本构成条
      '.dcf-stack{display:flex;height:6px;margin:6px 0 4px;border-radius:3px;overflow:hidden;background:var(--dsw-alias-bg-layer-3,#0000000a)}',
      '.dcf-stack-seg{height:100%;min-width:0}',
      '.dcf-stack-seg[data-kind="input"]{background:var(--dsw-alias-brand-primary)}',
      '.dcf-stack-seg[data-kind="cacheRead"]{background:var(--dsw-alias-state-success-primary,#2ea043)}',
      '.dcf-stack-seg[data-kind="cacheWrite"]{background:var(--dsw-alias-state-business-primary,#c98a00)}',
      '.dcf-stack-seg[data-kind="output"]{background:var(--dsw-alias-state-error-primary,#d13c3c);opacity:.75}',
      '.dcf-legend{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dcf-legend span{display:inline-flex;align-items:center;gap:3px}',
      '.dcf-legend i{width:6px;height:6px;border-radius:2px;font-style:normal}',
      // 预算条
      '.dcf-budget{margin:4px 0 2px}',
      '.dcf-budget-track{height:5px;border-radius:3px;overflow:hidden;background:var(--dsw-alias-bg-layer-3,#0000000a);margin-top:4px}',
      '.dcf-budget-fill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s ease}',
      '.dcf-budget[data-state="warn"] .dcf-budget-fill{background:var(--dsw-alias-state-business-primary,#c98a00)}',
      '.dcf-budget[data-state="over"] .dcf-budget-fill{background:var(--dsw-alias-state-error-primary,#d13c3c)}',
      // 换模型比价
      '.dcf-alt{margin-top:2px}',
      '.dcf-alt-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:1px 0;font-size:11px}',
      '.dcf-alt-name{color:var(--dsw-alias-label-secondary);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dcf-alt-cost{flex:0 0 auto;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dcf-alt-row[data-current="true"] .dcf-alt-name{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.dcf-alt-tag{margin-left:4px;font-size:10px;color:var(--dsw-alias-state-success-primary,#2ea043)}',
      '.dcf-budget-set{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dcf-hint{font-size:10px;color:var(--dsw-alias-label-dimmed);white-space:nowrap}',
      '.dcf-budget-set .dcf-input{width:64px;flex:0 0 auto;}',
      '.dcf-actions{gap:6px;flex-wrap:wrap}',
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }
    //#endregion

    //#region 价目表与配置
    /** 模块级缓存：所有会话共享一份价目表；providerKey 变了（换模型）就重取 */
    var catalogueCache = { at: 0, data: null, config: null, site: null, error: null, providerKey: '' }
    var catalogueInflight = null

    function loadCatalogue(force, provider) {
      var key = String(provider || '').toLowerCase()
      var fresh =
        catalogueCache.data !== null &&
        catalogueCache.providerKey === key &&
        Date.now() - catalogueCache.at < CATALOGUE_TTL_MS
      if (!force && fresh) return Promise.resolve(catalogueCache)
      if (catalogueInflight && catalogueInflight.key === key) return catalogueInflight.promise
      var url = API + '/catalogue'
      var promise = fetch(url, { headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
        .then(function (body) {
          var catalogue = body && body.catalogue
          if (!catalogue || catalogue.ok !== true) {
            throw new Error((catalogue && catalogue.error) || '价目表不可用')
          }
          catalogueCache = {
            at: Date.now(),
            data: catalogue,
            config: body.config || null,
            site: body.site || null,
            error: null,
            providerKey: key,
          }
          return catalogueCache
        })
        .catch(function (error) {
          catalogueCache = {
            at: Date.now(),
            data: catalogueCache.data,
            config: catalogueCache.config,
            site: catalogueCache.site,
            error: String((error && error.message) || error),
            providerKey: key,
          }
          return catalogueCache
        })
        .then(function (value) {
          catalogueInflight = null
          return value
        })
      catalogueInflight = { key: key, promise: promise }
      return promise
    }

    function saveConfig(patch) {
      return fetch(API + '/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then(function (res) {
          return res.json()
        })
        .then(function (body) {
          if (body && body.config) {
            catalogueCache = {
              at: catalogueCache.at,
              data: catalogueCache.data,
              config: body.config,
              error: catalogueCache.error,
            }
          }
          return body
        })
        .catch(function () {
          return null
        })
    }
    //#endregion

    //#region 计价
    function normalizeKey(text) {
      return String(text == null ? '' : text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
    }

    /** 从价目条目里挑出与当前时段匹配的一条（DeepSeek 峰谷双价共用同名 key） */
    function pickByPeriod(candidates, offPeak) {
      var periodic = candidates.filter(function (entry) {
        return entry.period === 'peak' || entry.period === 'offPeak'
      })
      if (periodic.length === 0) return candidates[0] || null
      var wanted = offPeak ? 'offPeak' : 'peak'
      for (var i = 0; i < periodic.length; i += 1) {
        if (periodic[i].period === wanted) return periodic[i]
      }
      return periodic[0]
    }

    /** 模型名 → 价目条目。先精确归一匹配，再退化为包含匹配（取最贴近的一条）。 */
    function matchEntry(entries, model, offPeak) {
      if (!Array.isArray(entries) || entries.length === 0) return null
      var key = normalizeKey(model)
      if (key === '') return null

      var exact = entries.filter(function (entry) {
        return entry.key === key
      })
      if (exact.length > 0) return pickByPeriod(exact, offPeak)

      var loose = []
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i]
        if (!entry.key) continue
        var longer = entry.key.length >= key.length ? entry.key : key
        var shorter = entry.key.length >= key.length ? key : entry.key
        if (longer.indexOf(shorter) === 0) loose.push(entry)
      }
      if (loose.length === 0) return null
      loose.sort(function (a, b) {
        return Math.abs(a.key.length - key.length) - Math.abs(b.key.length - key.length)
      })
      return pickByPeriod(loose, offPeak)
    }

    /** 价目币种 → 展示币种 */
    function convert(price, fromCurrency, toCurrency, fxRate) {
      if (price == null || !Number.isFinite(price)) return null
      if (fromCurrency === toCurrency) return price
      var rate = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : null
      if (!rate) return price
      if (fromCurrency === 'USD' && toCurrency === 'CNY') return price * rate
      if (fromCurrency === 'CNY' && toCurrency === 'USD') return price / rate
      return price
    }

    function symbolOf(currency) {
      if (currency === 'USD') return '$'
      if (currency === 'EUR') return '€'
      return '¥'
    }

    /** 自适应精度：小额多留位数，大额收窄（保证至少 3 位有效数字） */
    function formatMoney(value, currency) {
      if (value == null || !Number.isFinite(value)) return '—'
      var abs = Math.abs(value)
      var digits = 2
      if (abs >= 1000) {
        return symbolOf(currency) + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      }
      if (abs === 0) digits = 2
      else if (abs < 0.0001) digits = 8
      else if (abs < 0.001) digits = 6
      else if (abs < 0.01) digits = 5
      else if (abs < 0.1) digits = 4
      else if (abs < 1) digits = 3
      return symbolOf(currency) + value.toFixed(digits)
    }

    function formatTokens(count) {
      var n = Number(count)
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + 'M'
      if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'k'
      return String(Math.round(n))
    }

    /** 时长：分钟 → 「2h10m」/「43m」 */
    function formatDuration(minutes) {
      var m = Math.max(0, Math.round(Number(minutes) || 0))
      if (m < 60) return m + 'm'
      var h = Math.floor(m / 60)
      var rest = m % 60
      return rest === 0 ? h + 'h' : h + 'h' + rest + 'm'
    }

    /**
     * 某一时刻是否处于高峰（北京时间）。`holidays` 里的日期全天空闲。
     * 周末在 `weekendOffPeak` 规则下全天空闲——2026-08-23 起官方就是这么算的，
     * 调休上班的周末同样按空闲计费，所以这里不区分是否调休。
     */
    function isPeakAt(rule, when, holidays) {
      var shifted = new Date(when.getTime() + 8 * 3600000)
      var minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
      var weekday = shifted.getUTCDay()
      var date = shifted.toISOString().slice(0, 10)
      if (Array.isArray(holidays) && holidays.indexOf(date) >= 0) return false
      if (rule.weekendOffPeak && (weekday === 0 || weekday === 6)) return false
      return (rule.windows || []).some(function (w) {
        return minutes >= w[0] && minutes < w[1]
      })
    }

    /**
     * 峰谷窗口。返回 { offPeak, minutes, rule, label }：
     * minutes 为距下一次峰谷切换的分钟数，rule 为 none 时两者都为 null。
     * 逐分钟向前找第一个状态不同的时刻——最多扫 7 天，纯算术，不用逐日枚举窗口边界。
     */
    function peakWindow(now, ruleName, holidays) {
      var key = PEAK_RULES[ruleName] ? ruleName : 'deepseek'
      var rule = PEAK_RULES[key]
      if (key === 'none') return { offPeak: null, minutes: null, rule: key, label: rule.label }
      var date = now instanceof Date ? now : new Date()
      var peak = isPeakAt(rule, date, holidays)
      var minutes = null
      for (var i = 1; i <= 7 * 24 * 60; i += 1) {
        if (isPeakAt(rule, new Date(date.getTime() + i * 60000), holidays) !== peak) {
          minutes = i
          break
        }
      }
      return { offPeak: !peak, minutes: minutes, rule: key, label: rule.label }
    }
    //#endregion

    //#region 费用计算
    /**
     * 计算本次对话已花费用 + 下一轮预测费用。
     * - 已花：四类 token × 单价（每百万 token）
     * - 下一轮：contextPressure.projectedTokens 作为 prompt 规模，按历史缓存命中率拆成
     *   未命中 / 命中两段；输出按历史每轮均值（不足时用配置兜底）
     */
    function computeCost(input) {
      var usage = input.usage || null
      var pressure = input.pressure || null
      var breakdown = input.breakdown || null
      var stats = input.stats || null
      var selection = input.selection || null
      var catalogue = input.catalogue || null
      var config = input.config || null

      var currency = (config && config.currency) || 'CNY'
      var fallbackOutput = (config && config.defaultOutputTokens) || 1000

      var uncached = numberOr(usage && usage.uncachedInputTokens, 0)
      var cacheRead = numberOr(usage && usage.cacheReadTokens, 0)
      var cacheWrite = numberOr(usage && usage.cacheWriteTokens, 0)
      var output = numberOr(usage && usage.outputTokens, 0)
      var billed = uncached + cacheRead + cacheWrite

      var target = selection && (selection.next || selection.lastUsed)
      var provider = target && target.provider ? String(target.provider) : ''
      var model = target && target.model ? String(target.model) : ''

      var entries = (catalogue && catalogue.entries) || []
      var offPeak = Boolean(catalogue && catalogue.deepseekOffPeak)
      var entry = matchEntry(entries, model, offPeak)

      // 手工覆盖优先（key 支持 "provider/model" 与裸 model 两种写法）
      var override = null
      if (config && config.overrides) {
        override =
          (provider && model && config.overrides[provider + '/' + model]) ||
          (model && config.overrides[model]) ||
          null
      }

      // 其次用当前 provider（中转站）自己公布的价目（默认关闭：站点价口径与实收不符）
      var site = input.site || null
      var siteHit = null
      var siteEnabled = Boolean(config && config.useSitePricing === true)
      if (siteEnabled && !override && site && site.ok === true && Array.isArray(site.entries)) {
        siteHit = matchEntry(site.entries, model, false)
      }

      var fxRate = catalogue && catalogue.fxRate
      var chosen = null
      var priceSourceKind = 'none'
      if (override) {
        chosen = { prices: override, currency: currency }
        priceSourceKind = 'override'
      } else if (siteHit) {
        chosen = { prices: siteHit.prices, currency: siteHit.currency || 'USD' }
        priceSourceKind = 'site'
      } else if (entry) {
        chosen = { prices: entry.prices, currency: entry.currency }
        priceSourceKind = 'catalogue'
      }

      var originCurrency = chosen ? chosen.currency : currency
      var priceSource = chosen ? chosen.prices : null

      function priceOf(field, fallbackField) {
        if (!priceSource) return null
        var raw = priceSource[field]
        if (raw == null && fallbackField) raw = priceSource[fallbackField]
        return convert(raw, originCurrency, currency, fxRate)
      }

      var price = {
        input: priceOf('input'),
        output: priceOf('output'),
        // DeepSeek 等厂商不单独收缓存写费：缓存写按输入价计
        cacheRead: priceOf('cacheRead', 'input'),
        cacheWrite: priceOf('cacheWrite', 'input'),
      }

      var priced = price.input != null && price.output != null
      var perMillion = function (tokens, unitPrice) {
        if (unitPrice == null || !Number.isFinite(tokens)) return 0
        return (tokens / 1_000_000) * unitPrice
      }

      var spentParts = {
        input: perMillion(uncached, price.input),
        cacheRead: perMillion(cacheRead, price.cacheRead),
        cacheWrite: perMillion(cacheWrite, price.cacheWrite),
        output: perMillion(output, price.output),
      }
      var spent = spentParts.input + spentParts.cacheRead + spentParts.cacheWrite + spentParts.output

      // 历史缓存命中率：本会话实测；新会话按经验值
      var hitRatio = billed > 0 ? cacheRead / billed : FALLBACK_HIT_RATIO
      if (!Number.isFinite(hitRatio) || hitRatio < 0) hitRatio = 0
      if (hitRatio > 1) hitRatio = 1

      var promptTokens = numberOr(pressure && pressure.projectedTokens, 0)
      if (promptTokens <= 0 && breakdown) {
        promptTokens =
          numberOr(breakdown.systemTokens, 0) +
          numberOr(breakdown.toolsTokens, 0) +
          numberOr(breakdown.messageTokens, 0)
      }

      var turns = numberOr(stats && stats.turns, 0)
      var avgOutput = turns > 0 && output > 0 ? output / turns : fallbackOutput
      if (!Number.isFinite(avgOutput) || avgOutput <= 0) avgOutput = fallbackOutput

      var nextParts = {
        promptCached: perMillion(promptTokens * hitRatio, price.cacheRead),
        promptFresh: perMillion(promptTokens * (1 - hitRatio), price.input),
        output: perMillion(avgOutput, price.output),
      }
      var predicted = nextParts.promptCached + nextParts.promptFresh + nextParts.output

      // —— 派生指标 ——
      // 每轮均价：本会话已花 / 轮数
      var perTurn = turns > 0 ? spent / turns : 0

      // 上下文余量：按「每轮新增消息 token」外推还能聊几轮
      var contextWindow = numberOr(pressure && pressure.contextWindow, 0)
      var growthPerTurn =
        turns > 0 && breakdown && Number(breakdown.messageTokens) > 0 ? Number(breakdown.messageTokens) / turns : 0
      var remainingTurns =
        contextWindow > 0 && growthPerTurn > 0
          ? Math.max(0, Math.floor((contextWindow - promptTokens) / growthPerTurn))
          : null

      // 预算：config.budget 为本次对话预算（展示币种）
      var budget = numberOr(config && config.budget, 0)
      var budgetRatio = budget > 0 ? spent / budget : 0
      var budgetState =
        budget <= 0 ? 'none' : budgetRatio >= 1 ? 'over' : budgetRatio >= BUDGET_WARN_RATIO ? 'warn' : 'ok'

      // 峰谷倒计时（规则可在设置里切换：工作日峰谷 / 不判断）
      // 节假日由宿主把内置表与用户自填日期合并后随 catalogue 下发，这里直接用
      var holidays =
        catalogue && Array.isArray(catalogue.peakHolidays)
          ? catalogue.peakHolidays
          : (catalogue && catalogue.catalogue && Array.isArray(catalogue.catalogue.peakHolidays) && catalogue.catalogue.peakHolidays) ||
            (config && config.peakHolidays) ||
            []
      var peak = peakWindow(new Date(), config && config.peakRule, holidays)

      // 成本构成占比
      var partsTotal = spent > 0 ? spent : 0
      var composition = [
        { key: 'input', label: '输入', value: spentParts.input, ratio: partsTotal > 0 ? spentParts.input / partsTotal : 0 },
        {
          key: 'cacheRead',
          label: '缓存读',
          value: spentParts.cacheRead,
          ratio: partsTotal > 0 ? spentParts.cacheRead / partsTotal : 0,
        },
        {
          key: 'cacheWrite',
          label: '缓存写',
          value: spentParts.cacheWrite,
          ratio: partsTotal > 0 ? spentParts.cacheWrite / partsTotal : 0,
        },
        { key: 'output', label: '输出', value: spentParts.output, ratio: partsTotal > 0 ? spentParts.output / partsTotal : 0 },
      ]

      function priceView(prices, fromCurrency) {
        if (!prices) return null
        return {
          input: convert(prices.input, fromCurrency, currency, fxRate),
          output: convert(prices.output, fromCurrency, currency, fxRate),
          cacheRead: convert(prices.cacheRead == null ? prices.input : prices.cacheRead, fromCurrency, currency, fxRate),
          cacheWrite: convert(
            prices.cacheWrite == null ? prices.input : prices.cacheWrite,
            fromCurrency,
            currency,
            fxRate,
          ),
        }
      }

      return {
        currency,
        symbol: symbolOf(currency),
        provider,
        model,
        priced,
        price,
        priceSource: priceSourceKind,
        // 编辑单价时用来「用站点价 / 用官方价」一键回填（都已折算成展示币种）
        sources: {
          site: siteHit ? priceView(siteHit.prices, siteHit.currency || 'USD') : null,
          catalogue: entry ? priceView(entry.prices, entry.currency) : null,
          override: override ? priceView(override, currency) : null,
        },
        priceKey: provider && model ? provider + '/' + model : model,
        originCurrency,
        entryName: siteHit ? siteHit.model : entry ? entry.name : '',
        entryVendor: siteHit ? provider : entry ? entry.vendor : '',
        entryPeriod: siteHit ? null : entry ? entry.period : null,
        siteProvider: siteEnabled && site && site.provider ? String(site.provider) : '',
        siteUrl: siteEnabled && site && site.url ? String(site.url) : '',
        siteFetchedAt: siteEnabled && site ? numberOr(site.fetchedAt, 0) : 0,
        siteError: siteEnabled && site && site.ok !== true ? String(site.error || '') : '',
        siteEnabled,
        offPeak,
        fxRate: Number.isFinite(fxRate) ? fxRate : null,
        tokens: {
          uncached,
          cacheRead,
          cacheWrite,
          output,
          billed,
          hitRatio,
          promptTokens,
          avgOutput,
          turns,
        },
        spent,
        spentParts,
        predicted,
        nextParts,
        contextWindow: numberOr(pressure && pressure.contextWindow, 0),
        // —— 派生指标 ——
        perTurn,
        growthPerTurn,
        remainingTurns,
        budget,
        budgetRatio,
        budgetState,
        peak,
        composition,
        alternatives: buildAlternatives(entries, {
          promptTokens,
          avgOutput,
          hitRatio,
          toCurrency: currency,
          fxRate,
          offPeak,
          perMillion,
          convertRaw: convert,
        }),
      }
    }

    /**
     * 同规模 next-turn 下其它模型的单轮成本（「换模型能省多少」）。
     * 只取能算出 input/output 的条目，按成本升序，最多 5 条。
     */
    function buildAlternatives(entries, opts) {
      if (!Array.isArray(entries) || entries.length === 0) return []
      if (!(opts.promptTokens > 0)) return []
      var seen = {}
      var rows = []
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i]
        if (!entry || !entry.prices) continue
        var input = opts.convertRaw(entry.prices.input, entry.currency, opts.toCurrency, opts.fxRate)
        var output = opts.convertRaw(entry.prices.output, entry.currency, opts.toCurrency, opts.fxRate)
        if (input == null || output == null) continue
        var cacheReadRaw = entry.prices.cacheRead == null ? entry.prices.input : entry.prices.cacheRead
        var cacheRead = opts.convertRaw(cacheReadRaw, entry.currency, opts.toCurrency, opts.fxRate)
        if (cacheRead == null) cacheRead = input
        // 同一底座的 peak / offPeak 只保留当前时段
        var baseKey = String(entry.key || entry.id || '').replace(/(peak)$/i, '')
        if (seen[baseKey] && entry.period !== (opts.offPeak ? 'offPeak' : 'peak')) continue
        seen[baseKey] = true
        var total =
          opts.perMillion(opts.promptTokens * opts.hitRatio, cacheRead) +
          opts.perMillion(opts.promptTokens * (1 - opts.hitRatio), input) +
          opts.perMillion(opts.avgOutput, output)
        if (!Number.isFinite(total) || total <= 0) continue
        var label = entry.name || entry.id || entry.key
        if (entry.period === 'offPeak') label += '（谷时）'
        else if (entry.period === 'peak') label += '（峰时）'
        rows.push({ key: baseKey + '|' + (entry.period || ''), label: label, model: entry.id, total: total })
      }
      rows.sort(function (a, b) {
        return a.total - b.total
      })
      return rows.slice(0, 5)
    }

    function numberOr(value, fallback) {
      var n = Number(value)
      return Number.isFinite(n) ? n : fallback
    }
    //#endregion

    //#region 组件
    function Row(props) {
      return h(
        'div',
        {
          className: 'dcf-row',
          'data-strong': props.strong ? 'true' : 'false',
          'data-accent': props.accent ? 'true' : 'false',
        },
        h('dt', null, props.label),
        h('dd', null, props.value),
      )
    }

    var PRICE_FIELDS = [
      { key: 'input', label: '输入' },
      { key: 'output', label: '输出' },
      { key: 'cacheRead', label: '缓存读取' },
      { key: 'cacheWrite', label: '缓存写入' },
    ]

    /** 面板「编辑单价」用的草稿：统一成展示币种，方便直接改 */
    function priceDraft(cost) {
      var price = cost.price || {}
      var draft = {}
      for (var i = 0; i < PRICE_FIELDS.length; i += 1) {
        var field = PRICE_FIELDS[i].key
        var value = price[field]
        draft[field] = value == null ? '' : String(Number(value.toFixed(8)))
      }
      return draft
    }

    function stringifyDraft(view) {
      var draft = {}
      for (var i = 0; i < PRICE_FIELDS.length; i += 1) {
        var field = PRICE_FIELDS[i].key
        var value = view ? view[field] : null
        draft[field] = value == null || !Number.isFinite(Number(value)) ? '' : String(Number(Number(value).toFixed(8)))
      }
      return draft
    }

    function parsePriceInput(text) {
      var raw = String(text == null ? '' : text).trim()
      if (raw === '') return null
      var n = Number(raw)
      return Number.isFinite(n) && n >= 0 ? n : null
    }

    /** 成本构成：一行堆叠条 + 图例（按已花金额占比） */
    function compositionBlock(cost, currency) {
      return h(
        'div',
        { className: 'dcf-composition' },
        h(
          'div',
          { className: 'dcf-stack', role: 'img', 'aria-label': '成本构成' },
          cost.composition.map(function (part) {
            if (!(part.ratio > 0)) return null
            return h('div', {
              key: part.key,
              className: 'dcf-stack-seg',
              'data-kind': part.key,
              style: { width: (part.ratio * 100).toFixed(2) + '%' },
              title: part.label + ' ' + (part.ratio * 100).toFixed(0) + '%',
            })
          }),
        ),
        h(
          'div',
          { className: 'dcf-legend' },
          cost.composition.map(function (part) {
            if (!(part.ratio > 0)) return null
            return h(
              'span',
              { key: part.key },
              h('i', { 'data-kind': part.key, style: colorOf(part.key) }),
              part.label + ' ' + (part.ratio * 100).toFixed(0) + '%',
            )
          }),
        ),
      )
    }

    function colorOf(kind) {
      if (kind === 'input') return { background: 'var(--dsw-alias-brand-primary)' }
      if (kind === 'cacheRead') return { background: 'var(--dsw-alias-state-success-primary,#2ea043)' }
      if (kind === 'cacheWrite') return { background: 'var(--dsw-alias-state-business-primary,#c98a00)' }
      return { background: 'var(--dsw-alias-state-error-primary,#d13c3c)', opacity: 0.75 }
    }

    /** 预算进度条：达到 80% 变黄，超出变红 */
    function budgetBlock(cost, currency) {
      var ratio = Math.min(1, Math.max(0, cost.budgetRatio))
      return h(
        'div',
        { className: 'dcf-budget', 'data-state': cost.budgetState },
        h(
          'div',
          { className: 'dcf-row' },
          h('dt', null, '预算'),
          h(
            'dd',
            null,
            formatMoney(cost.spent, currency) +
              ' / ' +
              formatMoney(cost.budget, currency) +
              '（' +
              (cost.budgetRatio * 100).toFixed(0) +
              '%）',
          ),
        ),
        h('div', { className: 'dcf-budget-track' }, h('div', { className: 'dcf-budget-fill', style: { width: (ratio * 100).toFixed(2) + '%' } })),
        cost.budgetState === 'over'
          ? h('div', { className: 'dcf-note', 'data-state': 'warn' }, '已超出本次对话预算，注意继续对话会继续计费。')
          : cost.budgetState === 'warn'
            ? h('div', { className: 'dcf-note', 'data-state': 'warnable' }, '已用掉八成预算。')
            : null,
      )
    }

    /** 换模型比价：同 prompt 规模下其它模型的单轮成本 */
    function alternativesBlock(cost, currency) {
      var cheapest = cost.alternatives[0]
      return h(
        'div',
        { className: 'dcf-alt' },
        h('div', { className: 'dcf-rule' }),
        h('div', { className: 'dcf-section' }, '换模型单轮成本'),
        cost.alternatives.map(function (row) {
          var isCurrent = cost.entryName && row.label.indexOf(cost.entryName) === 0
          var diff = row.total - cost.predicted
          return h(
            'div',
            { key: row.key, className: 'dcf-alt-row', 'data-current': isCurrent ? 'true' : 'false' },
            h(
              'span',
              { className: 'dcf-alt-name', title: row.model },
              row.label,
              !isCurrent && row === cheapest ? h('span', { className: 'dcf-alt-tag' }, '最低') : null,
            ),
            h(
              'span',
              { className: 'dcf-alt-cost' },
              formatMoney(row.total, currency),
              !isCurrent && Math.abs(diff) > 1e-9
                ? h('span', { className: 'dcf-alt-tag' }, diff < 0 ? '省 ' + formatMoney(-diff, currency) : '贵 ' + formatMoney(diff, currency))
                : null,
            ),
          )
        }),
        h('div', { className: 'dcf-note' }, '按当前 prompt 规模与输出预估换算，仅供参考。'),
      )
    }

    function DetailPanel(props) {
      var cost = props.cost
      var panelRef = React.useRef(null)
      var editingState = React.useState(false)
      var editing = editingState[0]
      var setEditing = editingState[1]
      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var budgetState = React.useState(null)
      var budgetDraft = budgetState[0]
      var setBudgetDraft = budgetState[1]
      var rect = props.anchorRect || { left: 0, top: 0, width: 0 }
      var style = {
        left: Math.max(12, Math.min(rect.left, (window.innerWidth || 1024) - 364)) + 'px',
        bottom: Math.max(12, (window.innerHeight || 768) - rect.top + 8) + 'px',
      }

      var config = props.config || {}
      var currency = cost.currency

      return ReactDOM.createPortal(
        h(
          'section',
          { ref: panelRef, className: 'dcf-panel', role: 'dialog', style: style, 'data-cost-forecast-panel': 'true' },
          h(
            'div',
            { className: 'dcf-title' },
            h('span', { className: 'dcf-title-label' }, '本次对话费用'),
            h('span', { className: 'dcf-title-value' }, formatMoney(cost.spent + cost.predicted, currency)),
          ),
          h(
            'div',
            { className: 'dcf-sub' },
            (cost.provider ? cost.provider + ' / ' : '') + (cost.model || '未知模型'),
          ),

          h('div', { className: 'dcf-rule' }),

          h('div', { className: 'dcf-section' }, '下一轮预测'),
          h(Row, { label: 'Prompt 规模', value: formatTokens(cost.tokens.promptTokens) + ' tok' }),
          h(Row, {
            label: '缓存命中率',
            value: (cost.tokens.hitRatio * 100).toFixed(0) + '%' + (cost.tokens.billed > 0 ? '（实测）' : '（经验值）'),
          }),
          h(Row, { label: '预估输出', value: formatTokens(cost.tokens.avgOutput) + ' tok' }),
          h(Row, {
            label: '本轮合计',
            value: formatMoney(cost.predicted, currency),
            accent: true,
          }),

          h('div', { className: 'dcf-rule' }),

          h('div', { className: 'dcf-section' }, '本次已花'),
          h(Row, {
            label: '未命中输入 ' + formatTokens(cost.tokens.uncached),
            value: formatMoney(cost.spentParts.input, currency),
          }),
          h(Row, {
            label: '缓存读取 ' + formatTokens(cost.tokens.cacheRead),
            value: formatMoney(cost.spentParts.cacheRead, currency),
          }),
          h(Row, {
            label: '缓存写入 ' + formatTokens(cost.tokens.cacheWrite),
            value: formatMoney(cost.spentParts.cacheWrite, currency),
          }),
          h(Row, {
            label: '输出 ' + formatTokens(cost.tokens.output),
            value: formatMoney(cost.spentParts.output, currency),
          }),
          h(Row, { label: '小计', value: formatMoney(cost.spent, currency), strong: true }),

          cost.spent > 0 ? compositionBlock(cost, currency) : null,

          cost.budget > 0 ? budgetBlock(cost, currency) : null,

          cost.contextWindow > 0
            ? h(Row, {
                label: '上下文档位',
                value:
                  formatTokens(cost.tokens.promptTokens) +
                  ' / ' +
                  formatTokens(cost.contextWindow) +
                  '（' +
                  ((cost.tokens.promptTokens / cost.contextWindow) * 100).toFixed(0) +
                  '%）',
              })
            : null,

          cost.remainingTurns != null
            ? h(Row, {
                label: '按当前速度还能聊',
                value: '约 ' + formatTokens(cost.remainingTurns) + ' 轮',
              })
            : null,

          cost.tokens.turns > 0
            ? h(Row, { label: '每轮均价', value: formatMoney(cost.perTurn, currency) })
            : null,

          cost.entryPeriod
            ? h(Row, {
                label: cost.peak.offPeak ? '谷时剩余' : '距谷时',
                value: formatDuration(cost.peak.minutes),
              })
            : null,

          cost.alternatives && cost.alternatives.length > 0
            ? alternativesBlock(cost, currency)
            : null,

          h('div', { className: 'dcf-rule' }),

          h(
            'div',
            { className: 'dcf-section dcf-section-row' },
            h('span', null, '单价（每百万 token）'),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-link',
                onClick: function () {
                  if (editing) {
                    setEditing(false)
                    setDraft(null)
                  } else {
                    setDraft(priceDraft(cost))
                    setEditing(true)
                  }
                },
              },
              editing ? '取消' : '编辑',
            ),
          ),

          editing
            ? h(
                'div',
                { className: 'dcf-edit' },
                PRICE_FIELDS.map(function (field) {
                  return h(
                    'label',
                    { key: field.key, className: 'dcf-field' },
                    h('span', { className: 'dcf-field-label' }, field.label),
                    h('span', { className: 'dcf-field-input' }, [
                      h('span', { key: 'sym', className: 'dcf-field-symbol' }, symbolOf(currency)),
                      h('input', {
                        key: 'inp',
                        type: 'number',
                        min: '0',
                        step: '0.0001',
                        className: 'dcf-input',
                        value: draft ? draft[field.key] : '',
                        onChange: function (event) {
                          var next = event.target.value
                          setDraft(function (prev) {
                            var base = prev || priceDraft(cost)
                            var copy = {}
                            for (var i = 0; i < PRICE_FIELDS.length; i += 1) {
                              copy[PRICE_FIELDS[i].key] = base[PRICE_FIELDS[i].key]
                            }
                            copy[field.key] = next
                            return copy
                          })
                        },
                      }),
                    ]),
                  )
                }),
                h(
                  'div',
                  { className: 'dcf-edit-actions' },
                  cost.sources && cost.sources.site
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dcf-btn dcf-btn-sm',
                          onClick: function () {
                            setDraft(stringifyDraft(cost.sources.site))
                          },
                        },
                        '用站点价',
                      )
                    : null,
                  cost.sources && cost.sources.catalogue
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dcf-btn dcf-btn-sm',
                          onClick: function () {
                            setDraft(stringifyDraft(cost.sources.catalogue))
                          },
                        },
                        '用官方价',
                      )
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dcf-btn dcf-btn-sm dcf-btn-primary',
                      onClick: function () {
                        var source = draft || priceDraft(cost)
                        var next = {}
                        for (var i = 0; i < PRICE_FIELDS.length; i += 1) {
                          var field = PRICE_FIELDS[i].key
                          var parsed = parsePriceInput(source[field])
                          if (parsed != null) next[field] = parsed
                        }
                        props.onPrices(next)
                        setEditing(false)
                        setDraft(null)
                      },
                    },
                    '保存',
                  ),
                  cost.priceSource === 'override'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dcf-btn dcf-btn-sm',
                          onClick: function () {
                            props.onPrices(null)
                            setEditing(false)
                            setDraft(null)
                          },
                        },
                        '恢复自动',
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'dcf-note' },
                  '数值按当前展示币种（' + currency + '）填写，每百万 token；保存后写入本机配置，优先级高于站点价与官方价。',
                ),
              )
            : cost.priced
              ? h('div', null, [
                  h(Row, { key: 'in', label: '输入', value: formatMoney(cost.price.input, currency) }),
                  h(Row, { key: 'out', label: '输出', value: formatMoney(cost.price.output, currency) }),
                  h(Row, {
                    key: 'cr',
                    label: '缓存读取',
                    value: cost.price.cacheRead == null ? '—' : formatMoney(cost.price.cacheRead, currency),
                  }),
                  h(Row, {
                    key: 'cw',
                    label: '缓存写入',
                    value: cost.price.cacheWrite == null ? '—' : formatMoney(cost.price.cacheWrite, currency),
                  }),
                ])
              : h('div', { className: 'dcf-note' }, '未匹配到该模型的价目，费用无法估算；点「编辑」手动填单价。'),

          h(
            'div',
            { className: 'dcf-note' },
            cost.priceSource === 'override'
              ? '来源：手工覆盖单价'
              : cost.priceSource === 'site'
                ? '来源：站点 ' +
                  (cost.siteProvider || '中转站') +
                  ' · ' +
                  (cost.entryName || cost.model) +
                  (cost.originCurrency !== cost.currency && cost.fxRate
                    ? ' · ' + cost.originCurrency + '→' + cost.currency + ' ' + cost.fxRate.toFixed(4)
                    : '')
                : cost.priceSource === 'catalogue'
                  ? '来源：' +
                    (cost.entryName || '价目表') +
                    (cost.entryPeriod ? '（' + (cost.entryPeriod === 'offPeak' ? '谷时' : '峰时') + '）' : '') +
                    (cost.fxRate ? ' · USD→CNY ' + cost.fxRate.toFixed(4) : '') +
                    (cost.siteProvider ? '（站点价目未覆盖，已回退官方价）' : '')
                  : '来源：无',
          ),

          cost.siteError
            ? h('div', { className: 'dcf-note' }, '站点价目不可用：' + cost.siteError + '，已回退官方价目')
            : null,

          h(
            'div',
            { className: 'dcf-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn',
                onClick: function () {
                  props.onRefresh()
                },
              },
              '刷新价目',
            ),
            h(
              'label',
              { className: 'dcf-budget-set', title: '本次对话预算，留空或 0 表示不设' },
              h('span', null, '预算'),
              h('input', {
                type: 'number',
                min: '0',
                step: '0.1',
                className: 'dcf-input',
                value: budgetDraft == null ? (cost.budget > 0 ? String(cost.budget) : '') : budgetDraft,
                onChange: function (event) {
                  setBudgetDraft(event.target.value)
                },
                onBlur: function (event) {
                  var n = parsePriceInput(event.target.value)
                  props.onBudget(n == null ? 0 : n)
                },
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn',
                'data-active': currency === 'CNY' ? 'true' : 'false',
                onClick: function () {
                  props.onCurrency('CNY')
                },
              },
              '¥ CNY',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcf-btn',
                'data-active': currency === 'USD' ? 'true' : 'false',
                onClick: function () {
                  props.onCurrency('USD')
                },
              },
              '$ USD',
            ),
            h(
              'span',
              { className: 'dcf-budget-set', title: '峰谷规则：工作日峰谷按官方 09:00–12:00、14:00–18:00 计高峰' },
              h('span', null, '峰谷'),
              ...Object.keys(PEAK_RULES).map(function (key) {
                return h(
                  'button',
                  {
                    type: 'button',
                    className: 'dcf-btn',
                    'data-active': (props.config && props.config.peakRule) === key ? 'true' : 'false',
                    onClick: function () {
                      props.onPeakRule(key)
                    },
                  },
                  PEAK_RULES[key].label,
                )
              }),
            ),
            h(
              'span',
              {
                className: 'dcf-budget-set',
                title:
                  '自动套用内置的中国法定节假日表（国务院办公厅公告），这些日子全天按空闲时段计费；自己填的日期始终叠加',
              },
              h('span', null, '节假日'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dcf-btn',
                  'data-active': props.config && props.config.peakAutoHolidays !== false ? 'true' : 'false',
                  onClick: function () {
                    props.onPeakAutoHolidays(!(props.config && props.config.peakAutoHolidays !== false))
                  },
                },
                props.config && props.config.peakAutoHolidays !== false ? '自动识别' : '已关闭',
              ),
              h(
                'span',
                { className: 'dcf-hint' },
                holidayNote(props.catalogue),
              ),
            ),
          ),

          props.error ? h('div', { className: 'dcf-note', 'data-state': 'warn' }, '价目读取失败：' + props.error) : null,
        ),
        document.body,
      )
    }

    /** 输入框上方的费用带：一行显示已花 + 下一轮预测，点击展开明细 */
    function CostForecastDockInner(props) {
      var useProjection = props.useProjection
      var usage = useProjection('tokenUsage')
      var selection = useProjection('modelSelection')
      var pressure = useProjection('contextPressure')
      var breakdown = useProjection('contextBreakdown')
      var stats = useProjection('sessionStats')

      var stateTick = React.useState(0)
      var bump = stateTick[1]
      var catalogueState = React.useState({ data: null, config: null, site: null, error: null, ready: false })
      var store = catalogueState[0]
      var setStore = catalogueState[1]

      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      var rectState = React.useState(null)
      var anchorRect = rectState[0]
      var setAnchorRect = rectState[1]

      var barRef = React.useRef(null)

      // 价目要跟着 provider 走：中转站各不相同，换模型就重取
      var selected = selection && (selection.next || selection.lastUsed)
      var providerKey = selected && selected.provider ? String(selected.provider) : ''

      React.useEffect(function () {
        ensureStyle()
        var alive = true
        function pull(force) {
          loadCatalogue(force, providerKey).then(function (value) {
            if (!alive) return
            setStore({ data: value.data, config: value.config, site: value.site, error: value.error, ready: true })
          })
        }
        pull(false)
        var timer = setInterval(function () {
          pull(false)
        }, CATALOGUE_TTL_MS)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [providerKey])

      React.useEffect(
        function () {
          if (!open) return undefined
          function onDown(event) {
            var panel = document.querySelector('[data-cost-forecast-panel="true"]')
            if (barRef.current && barRef.current.contains(event.target)) return
            if (panel && panel.contains(event.target)) return
            setOpen(false)
          }
          function onKey(event) {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', onDown, true)
          document.addEventListener('keydown', onKey, true)
          return function () {
            document.removeEventListener('mousedown', onDown, true)
            document.removeEventListener('keydown', onKey, true)
          }
        },
        [open],
      )

      var cost = computeCost({
        usage: usage,
        selection: selection,
        pressure: pressure,
        breakdown: breakdown,
        stats: stats,
        catalogue: store.data,
        site: store.site,
        config: store.config,
      })

      // 新会话、尚无任何 token 时也显示，但标灰；价目缺失时给出警示态
      var hasUsage = cost.tokens.billed > 0 || cost.tokens.output > 0
      var state = !store.ready
        ? 'loading'
        : store.error && !store.data
          ? 'warn'
          : !cost.priced
            ? 'warn'
            : cost.budgetState === 'over'
              ? 'warn'
              : 'ok'

      var label = cost.priced
        ? '本次 ' +
          formatMoney(cost.spent, cost.currency) +
          ' · 下一轮 ' +
          formatMoney(cost.predicted, cost.currency)
        : store.ready
          ? '费用：未匹配价目'
          : '费用：读取中'

      function toggle() {
        if (!open && barRef.current) {
          var box = barRef.current.getBoundingClientRect()
          setAnchorRect({ left: box.left, top: box.top, width: box.width })
        }
        setOpen(!open)
      }

      var bar = h(
        'button',
        {
          ref: barRef,
          type: 'button',
          className: 'dcf-bar',
          'data-state': state,
          'data-cost-forecast-bar': 'true',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          title: cost.priced
            ? '本次已花 ' +
              formatMoney(cost.spent, cost.currency) +
              '，下一轮预计 ' +
              formatMoney(cost.predicted, cost.currency) +
              '；点击查看明细'
            : '点击查看费用明细',
          onClick: toggle,
        },
        h('span', { className: 'dcf-lead', 'aria-hidden': true }, cost.priced ? symbolOf(cost.currency) : '…'),
        cost.priced
          ? [
              h(
                'span',
                { className: 'dcf-item', key: 'spent' },
                '本次',
                h('b', null, formatMoney(cost.spent, cost.currency)),
              ),
              h('span', { className: 'dcf-sep', key: 'sep' }, '·'),
              h(
                'span',
                { className: 'dcf-item', key: 'next' },
                '下一轮',
                h('b', null, formatMoney(cost.predicted, cost.currency)),
              ),
            ]
          : h('span', { className: 'dcf-item' }, label),
        hasUsage && cost.priced && cost.tokens.hitRatio > 0
          ? h('span', { className: 'dcf-badge' }, '缓存 ' + (cost.tokens.hitRatio * 100).toFixed(0) + '%')
          : null,
        h('span', { className: 'dcf-spacer' }),
        cost.budget > 0
          ? h(
              'span',
              { className: 'dcf-badge' },
              '预算 ' + Math.min(999, Math.round(cost.budgetRatio * 100)) + '%',
            )
          : null,
        cost.priceSource === 'override' ? h('span', { className: 'dcf-badge' }, '覆盖价') : null,
        cost.priceSource === 'site' ? h('span', { className: 'dcf-badge' }, '站点价') : null,
        cost.entryPeriod && cost.peak && cost.peak.rule !== 'none'
          ? h(
              'span',
              {
                className: 'dcf-badge',
                'data-state': cost.peak.offPeak === (cost.entryPeriod === 'offPeak') ? undefined : 'warn',
                title:
                  cost.peak.label +
                  (cost.peak.offPeak === (cost.entryPeriod === 'offPeak')
                    ? ''
                    : ' · 价目用的是' + (cost.entryPeriod === 'offPeak' ? '空闲' : '高峰') + '价，当前不在该时段'),
              },
              cost.entryPeriod === 'offPeak' ? '谷时' : '峰时',
            )
          : null,
        cost.entryPeriod && cost.peak && cost.peak.minutes != null
          ? h(
              'span',
              { className: 'dcf-badge', title: (cost.peak.offPeak ? '距高峰开始' : '距空闲开始') + ' · ' + cost.peak.label },
              (cost.peak.offPeak ? '剩 ' : '等 ') + formatDuration(cost.peak.minutes),
            )
          : null,
        h('span', { className: 'dcf-chevron', 'aria-hidden': true }, open ? '▾' : '▴'),
      )

      return h(
        React.Fragment,
        null,
        bar,
        open
          ? h(DetailPanel, {
              cost: cost,
              config: store.config,
              catalogue: store.data,
              anchorRect: anchorRect,
              error: store.error,
              onRefresh: function () {
                loadCatalogue(true, providerKey).then(function (value) {
                  setStore({ data: value.data, config: value.config, site: value.site, error: value.error, ready: true })
                  bump(function (n) {
                    return n + 1
                  })
                })
              },
              onCurrency: function (next) {
                saveConfig({ currency: next }).then(function (body) {
                  setStore({
                    data: store.data,
                    site: store.site,
                    config: (body && body.config) || Object.assign({}, store.config, { currency: next }),
                    error: store.error,
                    ready: true,
                  })
                })
              },
              onBudget: function (next) {
                saveConfig({ budget: next }).then(function (body) {
                  setStore({
                    data: store.data,
                    site: store.site,
                    config: (body && body.config) || Object.assign({}, store.config, { budget: next }),
                    error: store.error,
                    ready: true,
                  })
                  bump(function (n) {
                    return n + 1
                  })
                })
              },
              onPeakRule: function (next) {
                saveConfig({ peakRule: next }).then(function (body) {
                  setStore({
                    data: store.data,
                    site: store.site,
                    config: (body && body.config) || Object.assign({}, store.config, { peakRule: next }),
                    error: store.error,
                    ready: true,
                  })
                  bump(function (n) {
                    return n + 1
                  })
                })
              },
              onPeakAutoHolidays: function (next) {
                saveConfig({ peakAutoHolidays: next }).then(function (body) {
                  setStore({
                    data: store.data,
                    site: store.site,
                    config: (body && body.config) || Object.assign({}, store.config, { peakAutoHolidays: next }),
                    error: store.error,
                    ready: true,
                  })
                  bump(function (n) {
                    return n + 1
                  })
                  // 宿主要重新合并节假日表并随 catalogue 下发，重拉一次
                  Promise.resolve(loadCatalogue(true)).catch(function () {})
                })
              },
              onPrices: function (next) {
                var key = cost.priceKey || cost.model
                if (!key) return
                var overrides = Object.assign({}, (store.config && store.config.overrides) || {})
                if (next) overrides[key] = next
                else delete overrides[key]
                saveConfig({ overrides: overrides }).then(function (body) {
                  setStore({
                    data: store.data,
                    site: store.site,
                    config:
                      (body && body.config) ||
                      Object.assign({}, store.config, { overrides: overrides, version: store.config && store.config.version }),
                    error: store.error,
                    ready: true,
                  })
                  bump(function (n) {
                    return n + 1
                  })
                })
              },
            })
          : null,
      )
    }

    /** 包一层：宿主未提供 session 投影钩子时安静退出，不污染输入区 */
    function CostForecastDock(props) {
      if (!props || typeof props.useProjection !== 'function') return null
      return h(CostForecastDockInner, props)
    }
    //#endregion

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'cost-forecast',
            order: 10,
          },
          CostForecastDock,
        )
      })
    }

    return module.exports
  },
})
