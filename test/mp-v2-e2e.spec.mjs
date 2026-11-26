import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { startLanServer } from '../lib/lan-server.mjs'
import { attachMp } from '../lib/mp-support.mjs'
import { ALLOW } from '../lib/mp-contract.mjs'

// v2 真栈测试：真起 HTTP 服务 + 真 attachMp，只伪造宿主 runCommand。
// 目的：抓「白名单 / 路由 / attachMp wiring」这类单测抓不到的错。
let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)
const noop = () => {}

async function boot() {
  const calls = []
  const prompts = []
  const fsReturn = {
    fsDrives: { ok: true, drives: ['C:', 'D:'], home: 'C:\\Users\\t' },
    fsMkdir: { ok: true },
    fsStat: { ok: true, path: 'C:\\a.txt', name: 'a.txt', dir: false, size: 3, mtime: 1, mime: 'text/plain' },
    readFile: { ok: true, path: 'C:\\a.txt', name: 'a.txt', mime: 'text/plain', bytes: 3, b64: 'aGk=' },
    wsCreate: { ok: true, created: true, id: 'ws-1', path: 'C:\\w', title: 'W' },
    wsDelete: { ok: true, removed: true },
    permissionCatalog: { ok: true, presets: [{ value: 'fixed', name: '只读' }], current: 'fixed' },
    permissionSet: { ok: true, current: 'danger-full-access' },
    create: { ok: true, sessionId: 'sess-9' },
  }

  const ctl = {
    async list() { return { items: [] } },
    async prompt(req) { prompts.push(req); return { accepted: true } },
  }
  const ctx = { get: (k) => (k === 'sessionController' ? ctl : null) }

  const lan = startLanServer({
    port: 0,
    allowShift: true,
    getToken: () => 'tok',
    getInfo: () => ({ name: 'PC', nodeId: 'node-1', host: 'h', dshOk: true, version: '0.6.0' }),
    listSessions: async () => [],
    runCommand: async (op, payload, meta) => { calls.push({ op, payload, meta }); return fsReturn[op] || { ok: true } },
    log: noop,
  })
  const info = await lan.start()

  const mp = attachMp(ctx, {
    log: noop,
    config: {},
    // 必须隔离设备库：否则会读到真实 ~/.dsh 里已配对的设备，测试不hermetic
    devicesPath: path.join(os.tmpdir(), 'dsh-mp-v2-devices-' + process.pid + '-' + Date.now() + '.json'),
    revokedPath: path.join(os.tmpdir(), 'dsh-mp-v2-revoked-' + process.pid + '-' + Date.now() + '.json'),
    isPairCode: (code) => code === lan.peekPairCode(),
    runCommand: async (op, payload, meta) => { calls.push({ op, payload, meta }); return fsReturn[op] || { ok: true } },
    gatewayStatus: () => ({
      ok: true, hostName: 'PC',
      lan: { on: true, port: info.port, urls: [] },
      wan: { on: false, ready: false, kind: 'cloud' },
      remotePair: true, uptime: 5,
    }),
    hostVersion: '0.6.0',
  })
  lan.setMp({ branch: mp.branch, onUpgrade: null })

  const base = 'http://127.0.0.1:' + info.port
  const pair = await fetch(base + '/mp/pair/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: lan.peekPairCode(), deviceName: 'Mate 70', deviceModel: 'Mate 70' }),
  })
  assert.equal(pair.status, 200, 'pairing failed')
  const cookie = pair.headers.get('set-cookie').split(';')[0]

  async function rpc(method, payload, extraHeaders) {
    const res = await fetch(base + '/mp/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie, ...(extraHeaders || {}) },
      body: JSON.stringify({ rpcId: 'x', payload: payload || {} }),
    })
    return (await res.json()).result
  }

  return { calls, prompts, base, cookie, rpc, stop: () => { mp.dispose(); lan.stop() } }
}

section('v2 方法必须经过真路由')

{
  const b = await boot()
  try {
    const h = await b.rpc('mp.hello', {})
    assert.equal(h.ok, true, JSON.stringify(h))
    assert.equal(h.value.appProtocol, 2)
    assert.equal(h.value.hostVersion, '0.6.0')
    assert.equal(h.value.methods.length, ALLOW.length, '实际 ' + h.value.methods.length)
    ok('mp.hello 走通路由，方法数与白名单一致')

    const w = await b.rpc('workspace.create', { path: 'C:\\w', title: 'W' })
    assert.equal(w.ok, true, JSON.stringify(w))
    assert.equal(w.value.workspaceId, 'ws-1')
    assert.equal(b.calls[0].op, 'wsCreate')
    ok('workspace.create 在真栈里落到宿主 wsCreate')

    const d = await b.rpc('host.drives', {})
    assert.deepEqual(d.value.drives, [{ name: 'C:', path: 'C:\\' }, { name: 'D:', path: 'D:\\' }])
    ok('host.drives 走真路由')

    const mk = await b.rpc('host.mkdir', { path: 'C:\\w\\new' })
    assert.equal(mk.ok, true)
    assert.equal(b.calls.find((c) => c.op === 'fsMkdir').payload.path, 'C:\\w\\new')
    ok('host.mkdir 走真路由')

    const st = await b.rpc('host.stat', { path: 'C:\\a.txt' })
    assert.equal(st.value.size, 3)
    assert.equal(st.value.mime, 'text/plain')
    ok('host.stat 走真路由')

    const rd = await b.rpc('host.readFile', { path: 'C:\\a.txt' })
    assert.equal(rd.value.b64, 'aGk=')
    assert.equal(b.calls.filter((c) => c.op === 'readFile').pop().meta.wan, false)
    ok('局域网读文件 meta.wan=false')

    const bl = await b.rpc('binding.list', {})
    assert.equal(bl.value.items.length, 1, '隔离后的设备库里应当只有刚配对这一台')
    const dev = bl.value.items[0]
    assert.equal(dev.secrets, undefined, '绝不能带 secret')
    assert.equal(dev.name, 'Mate 70')
    assert.ok(dev.deviceId !== '', 'deviceId 必须有值')
    ok('binding.list 能读到刚配对的设备，且不带 secret')

    const g = await b.rpc('gateway.status', {})
    assert.equal(g.value.hostName, 'PC')
    assert.equal(g.value.remotePair, true)
    ok('gateway.status 走真路由')
  } finally { b.stop() }
}

section('公网判定影响配额')

{
  const b = await boot()
  try {
    const headers = { 'x-forwarded-for': '203.0.113.9' }
    const hello = await b.rpc('mp.hello', {}, headers)
    assert.equal(hello.value.wan, true, '带转发头时 hello 必须自报 wan=true')
    ok('mp.hello 能识别公网来源')

    await b.rpc('host.readFile', { path: 'C:\\a.txt', maxBytes: 50 * 1024 * 1024 }, headers)
    const last = b.calls.filter((c) => c.op === 'readFile').pop()
    assert.equal(last.meta.wan, true)
    assert.equal(last.payload.maxBytes, 3 * 1024 * 1024, '公网必须夹到 3MB')
    ok('公网读文件在真栈里也被夹到 3MB')

    const lanHello = await b.rpc('mp.hello', {})
    assert.equal(lanHello.value.wan, false)
    ok('局域网请求不会被误判成公网')
  } finally { b.stop() }
}

section('越界与失败面')

{
  const b = await boot()
  try {
    const trav = await b.rpc('host.mkdir', { path: 'C:\\w\\..\\windows' })
    assert.equal(trav.error.code, 'bad-request')
    const rel = await b.rpc('host.readFile', { path: 'a.txt' })
    assert.equal(rel.error.code, 'bad-request')
    ok('真路由上 ../ 与相对路径都被拦成 bad-request')

    const forged = await fetch(b.base + '/mp/api/host.readFile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 'x', payload: { path: 'C:\\a.txt' } }),
    })
    assert.equal(forged.status, 401, '没 cookie 必须是 401')
    ok('新方法同样受 cookie 闸保护（401）')

    const unknown = await b.rpc('host.teleport', {})
    assert.equal(unknown.error.code, 'forbidden')
    ok('不在白名单的方法仍是 forbidden')
  } finally { b.stop() }
}

section('v3 新方法也要走真路由')

{
  const b = await boot()
  try {
    const cat = await b.rpc('permission.catalog', { sessionId: 's1' })
    assert.equal(cat.ok, true, JSON.stringify(cat))
    assert.equal(cat.value.presets[0].value, 'fixed')
    const set = await b.rpc('permission.set', { sessionId: 's1', permission: 'danger-full-access' })
    assert.equal(set.value.current, 'danger-full-access')
    ok('permission.catalog / permission.set 走真路由')

    await b.rpc('session.prompt', { sessionId: 's1', text: 'a' })
    await b.rpc('session.prompt', { sessionId: 's1', text: 'b', busyMode: 'steer' })
    assert.equal(b.prompts[0].mode, 'queue')
    assert.equal(b.prompts[1].mode, 'steer')
    ok('HTTP 上的 prompt 默认 queue、显式 steer 才插话')

    const probe = await b.rpc('webImport.probe', { url: 'https://chat.deepseek.com/share/engtbxuvz0v6g8mldl' })
    assert.equal(probe.value.sourceId, 'engtbxuvz0v6g8mldl')
    ok('webImport.probe 走真路由')

    const hello = await b.rpc('mp.hello', {})
    assert.equal(hello.value.methods.length, ALLOW.length, '实际 ' + hello.value.methods.length)
    assert.ok(hello.value.methods.includes('webImport.commit'))
    ok('hello 的方法表包含 v3 新方法')
  } finally { b.stop() }
}

console.log(`\n${n} 项 v3 真栈断言通过`)
