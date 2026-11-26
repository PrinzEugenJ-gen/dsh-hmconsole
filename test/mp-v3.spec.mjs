import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { createDispatcher } from '../lib/mp-dispatch.mjs'
import { ALLOW, WAN_FILE_DOWNLOAD_MAX } from '../lib/mp-contract.mjs'

// D1(32MB 统一) / D3(steer) / B5(权限) / webImport 的分发器级契约
let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)
const noLog = () => {}

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/deepseek-share.json', import.meta.url), 'utf8'))

function fakeCtl() {
  const prompts = []
  return {
    prompts,
    async list() { return { items: [] } },
    async prompt(req) { prompts.push(req); return { accepted: true } },
  }
}

function mk(state, ctl = fakeCtl()) {
  const dispatcher = createDispatcher({ get: (k) => (k === 'sessionController' ? ctl : null) }, noLog, null, { pins: new Set(), ...state })
  return { d: dispatcher, ctl }
}

function recorder(returnFor = {}) {
  const calls = []
  const runCommand = async (op, payload, meta) => {
    calls.push({ op, payload, meta })
    const v = returnFor[op]
    return typeof v === 'function' ? v(payload, meta) : (v || { ok: true })
  }
  return { calls, runCommand }
}

section('D1 · 公网配额统一 32MB')

{
  const { d } = mk({})
  const r = await d('mp.hello', {}, 'h')
  assert.equal(r.result.value.limits.uploadBodyWan, WAN_FILE_DOWNLOAD_MAX)
  assert.equal(r.result.value.limits.fileDownloadWan, 32 * 1024 * 1024)
  assert.equal(r.result.value.limits.uploadBodyWan, r.result.value.limits.fileDownloadWan)
  ok('上传/下载同报 32MB，不再是 32/36 两套数')
}

section('D3 · steer 保留但默认排队')

{
  const { d, ctl } = mk({})
  await d('session.prompt', { sessionId: 's1', text: '继续' }, 'p1')
  assert.equal(ctl.prompts[0].mode, 'queue', '默认必须 queue')
  ok('不传 busyMode 时默认排队')

  await d('session.prompt', { sessionId: 's1', text: '打断一下', busyMode: 'steer' }, 'p2')
  assert.equal(ctl.prompts[1].mode, 'steer')
  ok('显式 busyMode:"steer" 才插话')

  await d('session.prompt', { sessionId: 's1', text: 'x', busyMode: 'STEER' }, 'p3')
  assert.equal(ctl.prompts[2].mode, 'queue', '大小写不对按 queue 处理')
  await d('session.prompt', { sessionId: 's1', text: 'x', busyMode: 'anything' }, 'p4')
  assert.equal(ctl.prompts[3].mode, 'queue')
  ok('非法 busyMode 值一律退回 queue，不做猜测')
}

section('B5 · 权限目录与切换')

{
  const { calls, runCommand } = recorder({
    permissionCatalog: { ok: true, presets: [{ value: 'fixed', name: '只读' }], current: 'fixed', defaultPreset: 'fixed' },
    permissionSet: { ok: true, preset: 'danger-full-access', current: 'danger-full-access' },
  })
  const { d } = mk({ runCommand })

  const cat = await d('permission.catalog', { sessionId: 's1' }, 'c1')
  assert.equal(cat.result.ok, true)
  assert.equal(cat.result.value.presets[0].value, 'fixed')
  assert.equal(calls[0].op, 'permissionCatalog')
  assert.equal(calls[0].payload.sessionId, 's1')
  ok('permission.catalog 把 sessionId 透给宿主，原样返回预置')

  const set = await d('permission.set', { sessionId: 's1', permission: 'danger-full-access' }, 'c2')
  assert.equal(set.result.value.current, 'danger-full-access')
  assert.equal(calls[1].op, 'permissionSet')
  ok('permission.set 落到宿主 permissionSet')

  const noSid = await d('permission.set', { permission: 'x' }, 'c3')
  assert.equal(noSid.result.error.code, 'bad-request')
  const noPerm = await d('permission.set', { sessionId: 's1' }, 'c4')
  assert.equal(noPerm.result.error.code, 'bad-request')
  ok('缺 sessionId / permission 都报 bad-request')
}

section('webImport · probe')

{
  const { d } = mk({})
  const good = await d('webImport.probe', { url: 'https://chat.deepseek.com/share/engtbxuvz0v6g8mldl' }, 'i1')
  assert.equal(good.result.value.sourceId, 'engtbxuvz0v6g8mldl')
  assert.equal(good.result.value.kind, 'share')
  assert.deepEqual(good.result.value.channels, ['share', 'clipboard'])
  ok('probe 识别真实分享链接')

  const bad = await d('webImport.probe', { url: 'https://example.com/x' }, 'i2')
  assert.equal(bad.result.error.code, 'bad-request')
  ok('别家链接报 bad-request')
}

section('webImport · pull')

{
  const webFetch = async (url) => {
    assert.ok(String(url).includes('share_id=engtbxuvz0v6g8mldl'), 'URL 要带 share_id')
    return { status: 200, ok: true, async text() { return JSON.stringify(FIXTURE) } }
  }
  const { d } = mk({ webFetch })
  const r = await d('webImport.pull', { url: 'https://chat.deepseek.com/share/engtbxuvz0v6g8mldl' }, 'u1')
  assert.equal(r.result.ok, true)
  assert.equal(r.result.value.count, 2)
  assert.equal(r.result.value.title, '幺正变换')
  ok('pull 用注入的 fetch 拿到并解析会话（不碰真网络）')

  const { d: d2 } = mk({
    webFetch: async () => ({ status: 200, ok: true, async text() { return '<html>' } }),
  })
  const bad = await d2('webImport.pull', { url: 'https://chat.deepseek.com/share/engtbxuvz0v6g8mldl' }, 'u2')
  assert.equal(bad.result.error.code, 'parse-failed')
  ok('接口返回非 JSON 时如实报 parse-failed')
}

section('webImport · commit')

{
  const dir = path.join(os.tmpdir(), 'dsh-import-test-' + process.pid + '-' + Date.now())
  const importsPath = path.join(dir, 'index.json')
  const { calls, runCommand } = recorder({ create: { ok: true, sessionId: 'sess-9', cwd: dir } })
  const { d } = mk({ runCommand, importsPath })

  const conv = JSON.parse(JSON.stringify(FIXTURE)).data.biz_data.messages
  const first = await d('webImport.commit', {
    targetDir: dir,
    source: 'deepseek-share',
    sourceId: 'engtbxuvz0v6g8mldl',
    title: '幺正变换',
    messages: [
      { role: 'user', text: conv[0].fragments[0].content },
      { role: 'assistant', text: conv[1].fragments[1].content, reasoning: conv[1].fragments[0].content },
    ],
  }, 'c1')
  assert.equal(first.result.ok, true, JSON.stringify(first.result))
  assert.equal(first.result.value.duplicate, false)
  assert.equal(first.result.value.sessionId, 'sess-9')
  const file = path.join(dir, 'imports', 'engtbxuvz0v6g8mldl.md')
  assert.ok(existsSync(file), '必须写 imports/<id>.md')
  const md = readFileSync(file, 'utf8')
  assert.ok(md.includes('## 用户') && md.includes('## 助手'))
  assert.equal(calls.find((c) => c.op === 'create').payload.cwd, dir, '建会话要落在目标目录')
  ok('commit 写盘、建会话、返回 sessionId')

  const again = await d('webImport.commit', {
    targetDir: dir, source: 'deepseek-share', sourceId: 'engtbxuvz0v6g8mldl',
    messages: [{ role: 'user', text: '幺正变换' }, { role: 'assistant', text: '解释' }],
  }, 'c2')
  assert.equal(again.result.value.duplicate, true)
  assert.equal(again.result.value.sessionId, 'sess-9')
  ok('重复导入返回 duplicate + 已有 sessionId，不重复建会话')

  const rel = await d('webImport.commit', { targetDir: 'relative', messages: [{ role: 'user', text: 'x' }] }, 'c3')
  assert.equal(rel.result.error.code, 'bad-request')
  ok('targetDir 必须是绝对路径')

  const empty = await d('webImport.commit', { targetDir: dir }, 'c4')
  assert.equal(empty.result.error.code, 'bad-request')
  ok('既没有 messages 也没有可用 url 时报 bad-request')

  try { rmSync(dir, { recursive: true, force: true }) } catch (e) { }
}

section('白名单一致性')

{
  for (const m of ['permission.catalog', 'permission.set', 'webImport.probe', 'webImport.pull', 'webImport.commit']) {
    assert.ok(ALLOW.includes(m), m)
  }
  const { d } = mk({})
  const hello = await d('mp.hello', {}, 'h2')
  assert.equal(hello.result.value.methods.length, ALLOW.length)
  assert.ok(hello.result.value.features.webImport.includes('share'))
  assert.ok(hello.result.value.features.webImport.includes('clipboard'))
  ok('5 个新方法进白名单，hello 如实报 share+clipboard')
}

console.log(`\n${n} 项 v3 契约断言通过`)
