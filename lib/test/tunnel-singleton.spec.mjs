import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const RT_KEY = Symbol.for('dsh.tunnel.runtime')
const OWNER_STALE_MS = 60000

function withRuntime(rt, fn) {
  const old = globalThis[RT_KEY]
  try {
    globalThis[RT_KEY] = rt
    return fn()
  } finally {
    if (old === undefined) { try { delete globalThis[RT_KEY] } catch (_) { } } else { globalThis[RT_KEY] = old }
  }
}

let seq = 0
async function freshModule() {
  return import('../tunnel.mjs?v=' + (seq++))
}

test('#1689 主人活着且有事在管 ⇒ 后来的实例必须只旁观', async () => {
  const mod = await freshModule()
  const now = Date.now()
  const d = mod.tunnelStandbyDecision(
    { owner: 1, beat: now, snapshot: { enabled: true, phase: 'connected' } }, 2, now)
  assert.equal(d, true)
})

test('#1689 主人是自己 ⇒ 不许把自己判成旁观者（否则谁都不干活）', async () => {
  const mod = await freshModule()
  const now = Date.now()
  const d = mod.tunnelStandbyDecision(
    { owner: 7, beat: now, snapshot: { enabled: true, phase: 'connected' } }, 7, now)
  assert.equal(d, false)
})

test('#1689 还没有主人 ⇒ 谁都可以抢', async () => {
  const mod = await freshModule()
  const d = mod.tunnelStandbyDecision({ owner: 0, beat: 0, snapshot: null }, 3, Date.now())
  assert.equal(d, false)
})

test('#1689 主人的心跳过期（实例已经没了）⇒ 允许别人接手', async () => {
  const mod = await freshModule()
  const now = Date.now()
  const d = mod.tunnelStandbyDecision(
    { owner: 1, beat: now - OWNER_STALE_MS - 1000, snapshot: { enabled: true, phase: 'connected' } }, 2, now)
  assert.equal(d, false, '心跳停了就说明那个实例已经不在，僵死的主人不能被旁观者永远续命')
})

test('#1689 主人那边 phase=disabled（自己决定不收工）⇒ 不挡别人', async () => {
  const mod = await freshModule()
  const now = Date.now()
  const d = mod.tunnelStandbyDecision(
    { owner: 1, beat: now, snapshot: { enabled: false, phase: 'disabled' } }, 2, now)
  assert.equal(d, false)
})

test('#1689 主人那边是 error 态 ⇒ 也算有主（主人自己在退避重试，别抢）', async () => {
  const mod = await freshModule()
  const now = Date.now()
  const d = mod.tunnelStandbyDecision(
    { owner: 1, beat: now, snapshot: { enabled: true, phase: 'error' } }, 2, now)
  assert.equal(d, true, 'error 也算有主：抢过来重拉只会造出第二个 frpc')
})

test('#1689 跨模块命名空间真的共享同一个哨兵（这是整条修法的地基）', async () => {
  const a = await freshModule()
  const rt = { seq: 100, owner: 0, beat: 0, snapshot: null }
  const b = await withRuntime(rt, async () => await freshModule())

  assert.ok(typeof a.tunnelIsStandby === 'function')
  assert.ok(typeof b.tunnelIsStandby === 'function')
  assert.equal(a.tunnelStandbyDecision(rt, 101, Date.now()), false, '还没有主人时谁都能抢')
})

test('#1689 tunnel.mjs 三处闸都在位（静态断言，防手滑回退）', () => {
  const src = fs.readFileSync(new URL('../tunnel.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes("const TUNNEL_RT_KEY = Symbol.for('dsh.tunnel.runtime')"), '哨兵必须挂在 globalThis 的 Symbol.for 上（同进程共享）')
  assert.ok(src.includes('export function tunnelStandbyDecision'), '判定必须是可单测的纯函数')
  assert.ok(src.includes('export function tunnelIsStandby'), '宿主侧 watchdog 需要它做内存级判断')

  const i = src.indexOf('export function startTunnel')
  const seg = src.slice(i, i + 4000)
  assert.ok(seg.includes('tunnelStandbyDecision(gateRt'), 'startTunnel 开头必须有单实例闸')
  assert.ok(seg.indexOf('claimTunnelOwner()') > seg.indexOf('tunnelStandbyDecision(gateRt'), '先判闸、再认领')

  const j = src.indexOf('export function stopTunnel')
  const seg2 = src.slice(j, j + 1200)
  assert.ok(seg2.includes('tunnelStandbyDecision(stopRt'), '旁观者不许 stopTunnel 主人的 frpc')
  assert.ok(seg2.includes('rel.owner = 0'), '主人收工必须让出哨兵，不然别人永远抢不回来')

  const k = src.indexOf('function spawnFrpc()')
  const seg3 = src.slice(k, k + 600)
  assert.ok(seg3.includes('sweepStrayFrpc({ sync: true })'), 'spawnFrpc 前必须清掉用同一份 toml 的残留 frpc')
})

test('#1689 index.js 巡检定时器可清、旁观者不重复拉起（静态断言）', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('let tunnelWatchdog = null'), '句柄必须提到外层，cleanup 才摸得到')
  assert.ok(src.includes('clearInterval(tunnelWatchdog)'), '插件 reload 必须清掉旧定时器（老版本没清，旧实例继续 30 秒一轮）')
  assert.ok(src.includes('if (!tunnelIsStandby()) bootTunnel()'), '旁观者不许再起第二个 frpc')
  assert.ok(src.includes('if (tunnelIsStandby()) return'), '旁观者的 watchdog 直接返回，不必读配置')
})
