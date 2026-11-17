// 宿主峰谷判定单测：内置节假日表 + 工作日/周末/旧规则/开关
// 用法：node test-peak.mjs
import { isDeepseekPeak } from './index.js'
import { CN_HOLIDAYS, effectiveHolidays, coveredYears } from './holidays.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed += 1
    console.error('  ✗ ' + msg)
    return
  }
  console.log('  ✓ ' + msg)
}
const at = (text, rule = 'deepseek', holidays = CN_HOLIDAYS) =>
  isDeepseekPeak(new Date(text + '+08:00'), rule, holidays)

console.log('节假日表:', CN_HOLIDAYS.length, '天 | 覆盖年份:', coveredYears().join(', '))

console.log('\n[1] 工作日峰谷（09:00–12:00、14:00–18:00）')
assert(at('2026-11-17T09:00:00') === true, '周二 09:00 是高峰')
assert(at('2026-11-17T10:00:00') === true, '周二 10:00 是高峰')
assert(at('2026-11-17T12:00:00') === false, '周二 12:00 转空闲')
assert(at('2026-11-17T12:30:00') === false, '周二 12:30 是空闲')
assert(at('2026-11-17T14:00:00') === true, '周二 14:00 转高峰')
assert(at('2026-11-17T16:35:00') === true, '周二 16:35 是高峰')
assert(at('2026-11-17T18:00:00') === false, '周二 18:00 转空闲')
assert(at('2026-11-17T08:59:00') === false, '周二 08:59 是空闲')
assert(at('2026-11-17T22:00:00') === false, '周二 22:00 是空闲')

console.log('\n[2] 周末全天空闲（含调休上班的周末）')
assert(at('2026-11-21T10:00:00') === false, '周六 10:00 是空闲')
assert(at('2026-11-22T15:00:00') === false, '周日 15:00 是空闲')
assert(at('2026-10-10T10:00:00') === false, '国庆后补班的周六仍按空闲')

console.log('\n[3] 内置法定节假日')
assert(at('2026-10-01T10:00:00') === false, '国庆 10/1（周四）按空闲')
assert(at('2026-10-06T15:00:00') === false, '国庆 10/6（周二）按空闲')
assert(at('2026-02-16T10:00:00') === false, '春节 2/16（周一）按空闲')
assert(at('2026-09-25T10:00:00') === false, '中秋 9/25（周五）按空闲')
assert(at('2026-05-04T10:00:00') === false, '劳动节 5/4（周一）按空闲')
assert(at('2026-10-08T10:00:00') === true, '国庆后 10/8（周四）恢复高峰')

console.log('\n[4] 未收录年份只有周末判断')
assert(at('2027-01-04T10:00:00') === true, '2027-01-04（周一）按高峰')
assert(at('2027-01-02T10:00:00') === false, '2027-01-02（周六）按空闲')

console.log('\n[5] 开关与自定义日期')
assert(effectiveHolidays({}).includes('2026-10-01'), '默认合并内置表')
assert(!effectiveHolidays({ peakAutoHolidays: false }).includes('2026-10-01'), '关闭自动后不含内置表')
assert(at('2026-10-01T10:00:00', 'deepseek', effectiveHolidays({ peakAutoHolidays: false })) === true, '关闭自动后国庆按工作日高峰')
assert(
  at('2026-12-25T10:00:00', 'deepseek', effectiveHolidays({ peakHolidays: ['2026-12-25'] })) === false,
  '自定义日期按空闲',
)

console.log('\n[6] 已移除的旧规则回落到工作日峰谷')
assert(at('2026-11-17T02:00:00', 'legacy') === false, 'legacy 不再单独处理，02:00 按工作日规则是空闲')
assert(at('2026-11-17T16:35:00', 'legacy') === true, 'legacy 不再单独处理，16:35 按工作日规则是高峰')

if (failed > 0) {
  console.error('\n失败 ' + failed + ' 项')
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
