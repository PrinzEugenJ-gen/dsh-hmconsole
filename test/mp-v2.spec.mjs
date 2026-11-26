import assert from 'node:assert/strict'
import { createDispatcher } from '../lib/mp-dispatch.mjs'
import { ALLOW, APP_PROTOCOL, WAN_FILE_READ_MAX } from '../lib/mp-contract.mjs'

// v2 新增 RPC 的契约测试：全部走分发器，真起服务端的用例在 mp-e2e 里
let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)
const noLog = () => {}

const fakeCtl = { async list() { return { items: [] } } }
const ctx = { get: (k) => (k === 'sessionController' ? fakeCtl : null) }

function recorder(returnFor = {}) {
  const calls = []
  const runCommand = async (op, payload, meta) => {
    calls.push({ op, payload, meta })
    if (typeof returnFor[op] === 'function') return returnFor[op](payload, meta)
    return returnFor[op] || { ok: true }
  }
  return { calls, runCommand }
}

const mk = (state) => createDispatcher(ctx, noLog, null, { pins: new Set(), ...state })

section('白名单与能力协商')

{
  const added = [
    'mp.hello', 'host.drives', 'host.mkdir', 'host.stat', 'host.readFile',
    'workspace.remove', 'binding.list', 'gateway.status',
  ]
  for (const m of added) assert.ok(ALLOW.includes(m), 'ALLOW missing ' + m)
  ok('v2 的 8 个方法都在白名单里')

  const { runCommand } = recorder()
  const d = mk({ runCommand, hostVersion: '0.6.0' })
  const r = await d('mp.hello', {}, 'h1')
  assert.equal(r.result.ok, true)
  const v = r.result.value
  assert.equal(v.appProtocol, APP_PROTOCOL)
  assert.equal(v.hostVersion, '0.6.0')
  assert.deepEqual(v.methods, [...v.methods].sort(), 'methods 必须是排序过的')
  assert.equal(v.methods.length, ALLOW.length, 'handler 表与白名单条数必须一致')
  for (const m of ALLOW) assert.ok(v.methods.includes(m), 'hello 少报方法: ' + m)
  assert.equal(v.features.ws, true)
  assert.deepEqual(v.features.webImport, ['share', 'clipboard'], '只报已实现的通道，account 通道未实现不许报')
  assert.equal(v.limits.fileReadWan, WAN_FILE_READ_MAX)
  ok('mp.hello 的方法表由 handler 生成，与 ALLOW 一致，未实现功能如实报空')
}

section('工作区')

{
  const { calls, runCommand } = recorder({ wsCreate: { ok: true, created: true, id: 'ws-9', path: 'C:\\work', title: 'T' } })
  const d = mk({ runCommand })
  const r = await d('workspace.create', { path: 'C:\\work', title: 'T' }, 'w1')
  assert.equal(r.result.ok, true)
  assert.equal(r.result.value.workspaceId, 'ws-9')
  assert.equal(r.result.value.created, true)
  assert.equal(calls[0].op, 'wsCreate')
  assert.equal(calls[0].payload.path, 'C:\\work')
  ok('workspace.create 委托宿主 wsCreate，并把 id 映射成 workspaceId')

  const bad = await d('workspace.create', { path: 'relative/x' }, 'w2')
  assert.equal(bad.result.error.code, 'bad-request')
  const trav = await d('workspace.create', { path: 'C:\\work\\..\\windows' }, 'w3')
  assert.equal(trav.result.error.code, 'bad-request')
  ok('workspace.create 拒绝相对路径与 .. 穿越')

  const d2 = mk({ runCommand: recorder({ wsDelete: { ok: true, removed: true } }).runCommand })
  const rm = await d2('workspace.remove', { workspaceId: 'ws-9' }, 'w4')
  assert.equal(rm.result.value.removed, true)
  const rmEmpty = await d2('workspace.remove', {}, 'w5')
  assert.equal(rmEmpty.result.error.code, 'bad-request')
  ok('workspace.remove 走 wsDelete，缺参报 bad-request')
}

section('文件系统')

{
  const { calls, runCommand } = recorder({ fsDrives: { ok: true, drives: ['C:', 'D:'], home: 'C:\\Users\\x' } })
  const d = mk({ runCommand })
  const r = await d('host.drives', {}, 'd1')
  assert.deepEqual(r.result.value.drives, [
    { name: 'C:', path: 'C:\\' },
    { name: 'D:', path: 'D:\\' },
  ])
  assert.equal(r.result.value.home, 'C:\\Users\\x')
  ok('host.drives 把盘符映射成 {name,path}')

  const { calls: c2, runCommand: rc2 } = recorder({ fsDrives: { ok: true, drives: [] } })
  const r2 = await mk({ runCommand: rc2 })('host.drives', {}, 'd2')
  assert.deepEqual(r2.result.value.drives, [{ name: '/', path: '/' }])
  ok('没有盘符时（非 Windows）退化成根目录，而不是空列表')

  const { calls: c3, runCommand: rc3 } = recorder({ fsMkdir: { ok: true } })
  const d3 = mk({ runCommand: rc3 })
  await d3('host.mkdir', { path: 'C:\\work\\new' }, 'm1')
  assert.equal(c3[0].op, 'fsMkdir')
  const badMk = await d3('host.mkdir', { path: '../etc' }, 'm2')
  assert.equal(badMk.result.error.code, 'bad-request')
  ok('host.mkdir 走 fsMkdir，并拒绝越界路径')

  const { runCommand: rc4 } = recorder({ fsStat: { ok: true, path: 'C:\\a.txt', name: 'a.txt', dir: false, size: 12, mtime: 99, mime: 'text/plain' } })
  const st = await mk({ runCommand: rc4 })('host.stat', { path: 'C:\\a.txt' }, 's1')
  assert.deepEqual(st.result.value, { path: 'C:\\a.txt', name: 'a.txt', dir: false, size: 12, mtime: 99, mime: 'text/plain' })
  ok('host.stat 透传 size/mtime/mime')
}

section('readFile 的公网配额')

{
  const { calls, runCommand } = recorder({ readFile: { ok: true, path: 'C:\\a.bin', name: 'a.bin', mime: 'application/octet-stream', bytes: 5, b64: 'AAAA' } })
  const d = mk({ runCommand })

  const lan = await d('host.readFile', { path: 'C:\\a.bin', maxBytes: 10 * 1024 * 1024 }, 'r1', { wan: false })
  assert.equal(lan.result.ok, true)
  assert.equal(calls[0].meta.wan, false)
  assert.equal(calls[0].payload.maxBytes, 10 * 1024 * 1024, '局域网不夹 maxBytes')
  ok('局域网读文件保留客户端给的 maxBytes')

  const wan = await d('host.readFile', { path: 'C:\\a.bin', maxBytes: 99 * 1024 * 1024 }, 'r2', { wan: true })
  assert.equal(wan.result.ok, true)
  assert.equal(calls[1].meta.wan, true)
  assert.equal(calls[1].payload.maxBytes, WAN_FILE_READ_MAX, '公网必须夹到 3MB，不许被 maxBytes 绕过')
  ok('公网读文件把 maxBytes 夹到 3MB')

  const wan2 = await d('host.readFile', { path: 'C:\\a.bin' }, 'r3', { wan: true })
  assert.equal(calls[2].payload.maxBytes, WAN_FILE_READ_MAX, '公网没给 maxBytes 也要带默认上限')
  ok('公网没传 maxBytes 时补默认 3MB 上限')
}

section('设备与网关')

{
  const d = mk({ deviceList: () => ([
    { deviceId: 'dev-1', name: 'Mate 70', model: 'Mate 70', account: 'me', pairedAt: 1, lastSeen: 2, secrets: ['s1', 's2'] },
  ]) })
  const r = await d('binding.list', {}, 'b1')
  assert.equal(r.result.value.items.length, 1)
  assert.equal(r.result.value.items[0].deviceId, 'dev-1')
  assert.equal(r.result.value.items[0].secrets, undefined, '绝不能把 secret 发给 App')
  ok('binding.list 只吐脱敏字段，不带 secret')

  const d2 = mk({ gatewayStatus: () => ({ ok: true, hostName: 'PC', lan: { on: true, port: 8898, urls: [] }, wan: { on: false }, uptime: 3 }) })
  const g = await d2('gateway.status', {}, 'g1')
  assert.equal(g.result.value.hostName, 'PC')
  assert.equal(g.result.value.lan.port, 8898)
  ok('gateway.status 透传宿主状态')

  const d3 = mk({})
  const g3 = await d3('gateway.status', {}, 'g2')
  assert.equal(g3.result.ok, true)
  assert.equal(g3.result.value.lan.port, 0, '没有宿主数据时给安全默认值，不报错')
  ok('gateway.status 在宿主缺数据时给安全默认值')
}

section('失败面')

{
  const d = mk({})
  const r = await d('mp.hello', {}, 'f1')
  assert.equal(r.result.ok, true)
  assert.equal(r.result.value.hostVersion, '')
  ok('mp.hello 在缺 hostVersion 时仍可协商（返回空串，不崩）')

  const u = await d('no.such.method', {}, 'f2')
  assert.equal(u.result.error.code, 'forbidden')
  ok('未知方法仍然是 forbidden，不是异常')
}

console.log(`\n${n} 项 v2 契约断言通过`)
