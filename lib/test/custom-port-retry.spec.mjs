import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const INDEX = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const TUNNEL = fs.readFileSync(new URL('../tunnel.mjs', import.meta.url), 'utf8')
const CLIENT = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const CUSTOM = fs.readFileSync(new URL('../custom-server.mjs', import.meta.url), 'utf8')

function bodyOf(src, fnName) {
  const start = src.indexOf('const ' + fnName + ' =')
  assert.ok(start > 0, '找不到 ' + fnName)
  const rest = src.slice(start + 10)
  const next = rest.search(/\n  (const |let |function |\/\*)/)
  return next > 0 ? rest.slice(0, next) : rest
}

test('#1721 tunnel.mjs 导出清扫函数与冲突闩重置（A 的地基）', () => {
  assert.match(TUNNEL, /export function sweepStrayFrpc\(/, 'sweepStrayFrpc 必须能被宿主同步调用')
  assert.match(TUNNEL, /export function resetConflictLatch\(/, 'resetConflictLatch 必须导出')
  const fn = TUNNEL.slice(TUNNEL.indexOf('export function resetConflictLatch'))
  const body = fn.slice(0, fn.indexOf('}'))
  assert.match(body, /conflictHandled = false/, '必须清掉「本轮已报过冲突」的闩')
  assert.match(body, /conflictHandledAt = 0/, '必须清掉闩的时间戳')
})

test('#1721 index.js 真的把这两个函数导进来了', () => {
  const m = INDEX.match(/import \{([^}]+)\} from '\.\/tunnel\.mjs'/)
  assert.ok(m, '找不到 tunnel.mjs 的 import')
  assert.match(m[1], /sweepStrayFrpc/, '没导入 sweepStrayFrpc ⇒ 重试时清不掉残留进程')
  assert.match(m[1], /resetConflictLatch/, '没导入 resetConflictLatch ⇒ 第二次冲突会被 60 秒闩吞掉')
})

test('#1721 两个时间常量必须是 60 秒重试窗 / 45 秒结算', () => {
  assert.match(INDEX, /const CUSTOM_CONFLICT_RETRY_MS = 60000/, '同端口 60 秒内只允许重试一次')
  assert.match(INDEX, /const CUSTOM_RETRY_SETTLE_MS = 45000/, '重试后 45 秒没连上要认输去避让')
})

test('#1721 A：首次冲突先原地重试，不许直接避让', () => {
  const fn = bodyOf(INDEX, 'onCustomTunnelConflict')
  const retryAt = fn.indexOf('retryCustomPortInPlace(port)')
  const shiftAt = fn.indexOf('shiftCustomPort(port)')
  assert.ok(retryAt > 0, '冲突入口必须能原地重试')
  assert.ok(shiftAt > 0, '冲突入口仍要保留最终避让')
  assert.ok(retryAt < shiftAt, '重试必须排在避让之前')
  const guardAt = fn.indexOf('shouldRetryCustomPort(port)')
  assert.ok(guardAt > 0 && guardAt < retryAt, '重试前必须先过「同端口 60 秒只一次」的闸')
})

test('#1721 A：原地重试 = 同步清残留 + 重拉原端口，且不写 custom.json', () => {
  const fn = bodyOf(INDEX, 'retryCustomPortInPlace')
  assert.match(fn, /sweepStrayFrpc\(\{ sync: true \}\)/, '必须同步清扫（异步清扫等于没清，竞态照撞）')
  assert.match(fn, /resetConflictLatch\(\)/, '重拉前要重置闩，否则重撞那条报不上来')
  assert.match(fn, /ensureTunnel\(\)/, '清完要重拉')
  assert.ok(!/setCustom\(/.test(fn), '原地重试不许落盘改端口 —— 一落盘用户就永久失联了')
  assert.match(fn, /customRetrySettleTimer = setTimeout/, '必须有 45 秒结算定时器兜底哑火')
})

test('#1721 A：结算定时器到点只在「还没连上且端口没变」时才避让', () => {
  const fn = bodyOf(INDEX, 'retryCustomPortInPlace')
  const t = fn.slice(fn.indexOf('customRetrySettleTimer = setTimeout'))
  const body = t.slice(0, t.indexOf('}, CUSTOM_RETRY_SETTLE_MS)'))
  assert.match(body, /phase === 'connected'/, '连上了就别再挪端口')
  assert.match(body, /Number\(cur\.remotePort\) !== p/, '用户中途改了端口 ⇒ 旧定时器必须收手')
  assert.match(body, /shiftCustomPort\(p\)/, '确实没连上才避让')
})

test('#1721 A：避让后要告诉用户「重启 DSH 会再试原端口」', () => {
  const fn = bodyOf(INDEX, 'shiftCustomPort')
  assert.match(fn, /重启 DSH 会再试一次/, '日志里必须留这条，排障时能对上用户描述')
  assert.match(fn, /autoShiftedFrom: cur\.autoShiftedFrom \|\| cur\.remotePort/, '避让必须记住原端口，B 才有得回')
  assert.match(fn, /clearCustomRetrySettle\(\)/, '真避让了就要把延迟避让定时器收掉，别二次挪')
})

test('#1721 B：启动先回原端口，成功才清标记', () => {
  const fn = bodyOf(INDEX, 'restoreCustomPortOnce')
  assert.match(fn, /customRestoreDone/, '同一次启动只能回试一次')
  assert.match(fn, /remotePort: back/, '要把端口改回 autoShiftedFrom')
  assert.match(fn, /autoShiftedFrom: 0/, '改回去的同时清标记，否则面板一直提示已避让')
  assert.match(fn, /back === Number\(cur\.remotePort\)/, 'autoShiftedFrom 和 remotePort 相同的脏数据要单独处理')

  const boot = INDEX.slice(INDEX.indexOf('const bootTunnel ='))
  const branch = boot.slice(boot.indexOf('if (customOn())'), boot.indexOf('if (customOn())') + 1400)
  const restoreAt = branch.indexOf('restoreCustomPortOnce()')
  const syncAt = branch.indexOf('syncProxyName(customPath, log)')
  const startAt = branch.indexOf('startTunnel(')
  assert.ok(restoreAt > 0, 'bootTunnel 的自定义分支必须先调 restoreCustomPortOnce')
  assert.ok(restoreAt < syncAt && restoreAt < startAt, '回原端口要在同步代理名/起隧道之前，顺序反了就白改')
  assert.match(branch, /onConflict: onCustomTunnelConflict/, '自定义分支必须接新入口，不能还是裸 shiftCustomPort')
})

test('#1721 连上后清避让标记（否则面板永远挂着「已自动改用 9001」）', () => {
  const fn = bodyOf(INDEX, 'settleCustomPortOk')
  assert.match(fn, /clearCustomRetrySettle\(\)/, '连上了要收掉延迟避让定时器')
  assert.match(fn, /forgetCustomConflict\(0\)/, '连上了要清冲突计时，否则下次冲突直接判成二次')
  assert.match(fn, /autoShiftedFrom: 0/, '连上就把避让标记落盘清掉')

  const ens = bodyOf(INDEX, 'ensureTunnel')
  assert.match(ens, /st\.phase === 'connected'[\s\S]{0,120}settleCustomPortOk\(\)/, 'ensureTunnel 在 connected 时必须结算一次')
})

test('#1721 手动保存端口要尊重用户：清掉定时器和冲突计时', () => {
  const at = INDEX.indexOf("op === 'customServerSet'")
  assert.ok(at > 0, '找不到 customServerSet')
  const seg = INDEX.slice(at, at + 1600)
  assert.match(seg, /clearCustomRetrySettle\(\)/, '不清的话旧定时器会把用户刚填的端口再挪走')
  assert.match(seg, /forgetCustomConflict\(0\)/, '手动保存 = 重新开始，冲突计时也要清')
})

test('#1721 面板文案：避让后提示重启会回原端口（用户 m00092 拍板，不做 C）', () => {
  const m = CLIENT.match(/"custom\.shifted": "([^"]+)"/)
  assert.ok(m, '找不到 custom.shifted 文案')
  assert.match(m[1], /重启 DSH/, '必须告诉用户重启会重新尝试原端口')
  assert.match(m[1], /\{from\}/, '要带上原端口号')
  assert.match(m[1], /\{to\}/, '要带上临时端口号')
  assert.match(m[1], /\{url\}/, '手机上要填的地址不能丢')
})

test('#1721 给 AI 的建站口令也改了：先原地重试，重启回原端口', () => {
  assert.match(CUSTOM, /重启 DSH 会重新尝试我填的原端口/, 'AI 口令里的旧说法（撞了就往后挪）会误导用户')
  assert.match(CUSTOM, /同一端口一分钟内再撞才往后挪/, '要说清重试窗口，否则用户以为插件乱改端口')
})
