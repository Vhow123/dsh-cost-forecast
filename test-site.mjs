// 宿主半部站点价目联调：模拟 ctx + llm 服务，跑 apply 并请求 /cost-forecast/catalogue?provider=a6api
import { apply } from './index.js'

const routes = new Map()
const ctx = {
  webServer: {
    prefixes: routes,
    register(spec) {
      routes.set(spec.path, spec)
      return () => routes.delete(spec.path)
    },
  },
  dshHomePath: (...segments) => ['C:/Users/Administrator/.dsh', ...segments].join('/'),
  effect(fn) {
    const dispose = fn()
    return dispose
  },
  get(name) {
    if (name !== 'llm') return undefined
    return {
      listProviders: () => [
        { id: 'a6api', name: 'a6api', baseUrl: 'https://a6api.vip/v1' },
        { id: 'apiling', name: 'apiling', baseUrl: 'https://api.apiling.xyz/v1' },
      ],
    }
  },
}

apply(ctx)
console.log('注册路由', [...routes.keys()])

const spec = routes.get('/cost-forecast')
function call(path) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const res = {
      writeHead() {},
      end(text) {
        resolve(JSON.parse(String(text)))
      },
    }
    const req = {
      method: 'GET',
      url: path,
      headers: { 'user-agent': 'test-host' },
      on() {},
    }
    spec.handler(req, res).catch(reject)
  })
}

const a6 = await call('/cost-forecast/catalogue?provider=a6api')
console.log('a6api site ok:', a6.site?.ok, 'url:', a6.site?.url, 'groupRatio:', a6.site?.groupRatio, 'entries:', a6.site?.entries?.length)
const target = a6.site?.entries?.find((e) => e.model === 'deepseek-v4.1-flash-1017')
console.log('deepseek-v4.1-flash-1017 站点价:', JSON.stringify(target))
const sol = a6.site?.entries?.find((e) => e.model === 'gpt-6.1-sol')
console.log('gpt-6.1-sol 站点价:', JSON.stringify(sol))
const grok = a6.site?.entries?.find((e) => e.model === 'grok-4.7')
console.log('grok-4.7 站点价:', JSON.stringify(grok))

const ap = await call('/cost-forecast/catalogue?provider=apiling')
console.log('apiling site:', JSON.stringify(ap.site).slice(0, 200))
