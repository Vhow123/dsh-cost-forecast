# dsh-cost-forecast

在 DSH 输入框正上方显示一条费用带（与输入框卡片左右等宽）：

```
¥ 本次 ¥0.0720 · 下一轮 ¥0.0175   缓存 88%   站点价  ▴
```

- **本次**：当前会话累计已花（四类 token × 单价，按会话投影 `tokenUsage` 实测）
- **下一轮**：下一次请求的预测费用（prompt 规模取 `contextPressure.projectedTokens`，按本会话实测缓存命中率拆命中/未命中，输出取历史每轮均值）
- 徽章：缓存命中率、预算占用、覆盖价/站点价、峰谷时段 + 距切换倒计时
- 点击展开明细面板：模型、下一轮 4 行拆解、本次已花 4 行拆解 + **成本构成条**、上下文档位、**还能聊几轮**、**每轮均价**、**峰谷倒计时**、**换模型单轮成本对比**、预算进度、单价（可编辑）、价目来源、币种切换

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半部：读 `~/.dsh/token-ledger/rates.json`、抓当前中转站 `/api/pricing`、提供 `/cost-forecast` HTTP 接口、读写配置 |
| `lib/client.js` | 浏览器半部：注册 `conversation.input.dock` 席位，拉价目 + 计算 + 渲染 |
| `cordis.patch.yml` | 插件树插入条目 |
| `test-client.mjs` | 计算层自测（`node:vm` 打桩） |
| `test-render.mjs` | 渲染冒烟测试（React 替身） |
| `test-site.mjs` | 宿主侧中转站价目抓取联调 |

## 数据来源

- 用量：会话投影 `tokenUsage` / `modelSelection` / `contextPressure` / `contextBreakdown` / `sessionStats`
- **官方价目（默认）**：`~/.dsh/token-ledger/rates.json`
  - vendor 带 `currency` 字段时用它（deepseek / tencent 为 CNY），否则继承 `catalogue.currency`（USD），再按 `fx.rate` 折算成展示币种
  - DeepSeek 峰谷价：条目带 `period: peak | offPeak`，宿主按 `config.peakRule` 判当前时段并下发 `deepseekOffPeak`
    - `deepseek`（默认）：2026-08-17 起的官方规则——工作日 09:00–12:00、14:00–18:00 为高峰，其余时段空闲；周六、周日与法定节假日全天空闲；空闲价为高峰价的一半
    - `none`：不判断峰谷，面板不显示峰时/谷时与倒计时
    - 条目 `period` 与当前实际时段不一致时，徽标标 `data-state="warn"`，鼠标悬停说明价目用的是哪个时段的价格
    - 法定节假日**自动识别**：`holidays.js` 内置国务院办公厅公告的放假日期（当前收录 2026 年共 33 天：元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动节 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7），来源见文件头注释的 [gov.cn 通知](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)；`config.peakAutoHolidays` 置 `false` 可关闭
    - 只列放假当天：周六日本来就空闲，调休上班的周末按官方口径同样计空闲，所以不必区分补班日
    - `config.peakHolidays`：`["2026-10-01", ...]` 这类北京时间日期，**叠加**在内置表之上，用于未来年份或临时安排；周末已自动按空闲处理，不需要列进去
    - 未收录的年份只按周末判断；面板设置区的「节假日」按钮显示当前生效的天数与覆盖年份
- **站点价（默认关闭）**：`config.useSitePricing: true` 才启用，见下节
- 手工覆盖（最高优先）：`overrides`，按展示币种直接使用
- 配置：`~/.dsh/storages/dsh-cost-forecast/config.json`

## 站点价（默认关闭）

```jsonc
{ "useSitePricing": true }
```

开启后宿主会请求 `<provider baseURL origin>/api/pricing`（new-api 方言），按
`百万 token 价 = model_ratio × group_ratio × 2` 折算。**已默认关闭**：这条公式默认按
「500000 quota = $1」折算成美元再乘汇率，而人民币站的 500000 quota 实际是 ¥1，
两者差一个汇率，算出来会比实际扣费高约 6.7 倍。要按站点口径算请打开开关并同时用
`overrides` 校准，或直接把谈定的单价写进 `overrides`。

- 抓取结果缓存 10 分钟（失败 60 秒），落盘 `~/.dsh/storages/dsh-cost-forecast/site-prices.json`
- provider baseURL 取法：`llm.listProviders()` 只回 `{id,name}`，因此回退解析 `~/.dsh/profiles/*/cordis.patch.yml` 里 `providers:` 段的 `baseURL:`；`/cost-forecast/debug` 可看解析结果

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cost-forecast/catalogue` | 摊平的官方价目 + 当前配置（`useSitePricing` 开启时附带 `site`） |
| GET | `/cost-forecast/site?provider=<id>` | 只取站点价（关闭时返回 `ok:false`） |
| GET | `/cost-forecast/config` | 读配置 |
| POST | `/cost-forecast/config` | 合并写配置（`currency` / `defaultOutputTokens` / `enabled` / `overrides`） |
| GET | `/cost-forecast/probe` | 最近 30 条请求留痕（诊断 dock 是否挂载） |
| GET | `/cost-forecast/debug` | llm 运行时形态 + profile patch 里 baseURL 解析结果 |

## 配置项

```jsonc
{
  "currency": "CNY",          // 展示币种：CNY | USD
  "decimals": 4,
  "defaultOutputTokens": 1000, // 历史不足时预估输出 token
  "useSitePricing": false,     // 是否用中转站站点价（默认关）
  "budget": 0.5,               // 本次对话预算（展示币种）；0 = 不设，达 80% 提示、超出报警
  "overrides": {               // 手工单价覆盖，键为 "provider/model" 或裸 model
    "a6api/deepseek-v4.1-flash-1017": { "input": 2, "output": 8, "cacheRead": 0.04 }
  }
}
```

覆盖价优先级高于站点价与官方价目，`overrides` 里的数值按**展示币种**直接使用，不做汇率折算。

## 单价自定义（面板内直接改）

点费用带 → 明细面板 →「单价（每百万 token）」右侧的**编辑**：

- 四个输入框：输入 / 输出 / 缓存读取 / 缓存写入，单位是当前**展示币种**、每百万 token
- 「用站点价」「用官方价」一键回填到草稿（都已折算成展示币种），再微调
- 「保存」写入 `config.overrides["<provider>/<model>"]`，立即生效，费用带徽章变为「覆盖价」
- 已存在覆盖价时，编辑态多一个「恢复自动」，删掉该键回落到站点价/官方价

写盘后 `~/.dsh/storages/dsh-cost-forecast/config.json` 形如：

```jsonc
{
  "overrides": {
    "a6api/deepseek-v4.1-flash-1017": { "input": 6.68, "output": 6.68, "cacheRead": 6.68, "cacheWrite": 6.68 }
  }
}
```

## 启用

1. `~/.dsh/profiles/desktop/package.json`
   - `dependencies`: `"dsh-cost-forecast": "link:F:/杂项/dsh-cost-forecast"`
   - `dsh.profile.bundles`: 追加 `"dsh-cost-forecast"`
2. `~/.dsh/profiles/desktop/node_modules/dsh-cost-forecast` → 目录 junction
3. `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `- id: hmr` → `config.root` 追加 `'F:/杂项/dsh-cost-forecast'`（宿主半部热重载）
4. 重启 DSH（profile 层改动只在启动时组合）

## 备注

- 官方价目缓存 30s（按 `rates.json` 的 mtime 失效），站点价缓存 10 分钟，浏览器端 60s 拉一次
- `prices.cacheWrite` 为 `null` 时不收缓存写费，按输入价计
- 未匹配到模型价目时，费用带显示「费用：未匹配价目」，明细面板给出提示；可在 `overrides` 里补
- 布局：`.dcf-bar` 宽 `calc(100% - 2 × --dsh-composer-side-clearance)`、上限 `--dsh-composer-card-max-width`、`margin: 0 auto`，与输入框卡片严格等宽对齐
