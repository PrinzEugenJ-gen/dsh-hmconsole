import assert from 'node:assert/strict'
import {
  DISCOVERY_MAGIC, buildReply, createRateLimiter, isPrivateAddress, parseProbe,
} from '../lib/discovery.mjs'

let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)

section('报文解析')

assert.deepEqual(parseProbe(DISCOVERY_MAGIC), { version: 1, nonce: '' })
ok('v1 裸 magic 仍然被接受（旧 App 必须继续能用）')

assert.deepEqual(parseProbe('DSH-HMCONSOLE-PROBE/2 a1b2c3d4e5f60718'), { version: 2, nonce: 'a1b2c3d4e5f60718' })
ok('v2 带 nonce 能被解析')

assert.equal(parseProbe('DSH-HMCONSOLE-PROBE/2 short'), null)
assert.equal(parseProbe('DSH-HMCONSOLE-PROBE/2'), null)
assert.equal(parseProbe('DSH-HMCONSOLE-PROBE/3 a1b2c3d4e5f60718'), null)
assert.equal(parseProbe('DSH-HMCONSOLE-PROBEX/2 a1b2c3d4e5f60718'), null)
assert.equal(parseProbe('hello'), null)
assert.equal(parseProbe(''), null)
ok('版本不对/前缀不符/nonce 太短一律静默丢弃')

section('回包')

{
  const info = { port: 8898, name: 'PC', nodeId: 'node-1', host: 'h' }
  const v1 = JSON.parse(buildReply(info, { version: 1 }))
  assert.equal(v1.v, 1)
  assert.equal(v1.port, 8898)
  assert.equal(v1.nodeId, 'node-1')
  ok('v1 回包字段与旧版一致（端口/名字/nodeId/host）')

  const v2 = JSON.parse(buildReply({ ...info, shortId: 'AbCdEf123456789', tls: false }, { version: 2, nonce: 'a1b2c3d4e5f60718' }))
  assert.equal(v2.v, 2)
  assert.equal(v2.nonce, 'a1b2c3d4e5f60718')
  assert.equal(v2.shortId, 'AbCdEf123456789')
  assert.equal(v2.tls, false)
  ok('v2 回包回显 nonce 并附 shortId/tls')

  const noNonce = JSON.parse(buildReply(info, null))
  assert.equal(noNonce.v, 1)
  ok('没有 probe 时退化成 v1，不会扔出 undefined nonce')
}

section('私网判定')

for (const a of ['192.168.1.7', '10.0.0.9', '172.16.0.1', '172.31.255.254', '127.0.0.1', '169.254.3.4', '::ffff:192.168.1.7', '::1']) {
  assert.equal(isPrivateAddress(a), true, a)
}
for (const a of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '192.169.1.1', '11.0.0.1', '', 'not-an-ip']) {
  assert.equal(isPrivateAddress(a), false, a)
}
ok('只放行私网/回环，公网地址与非法输入一律拒绝')

section('限流')

{
  let t = 1000
  const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t })
  assert.equal(rl.allow('10.0.0.1'), true)
  assert.equal(rl.allow('10.0.0.1'), true)
  assert.equal(rl.allow('10.0.0.1'), true)
  assert.equal(rl.allow('10.0.0.1'), false, '第 4 次必须被挡')
  assert.equal(rl.allow('10.0.0.2'), true, '别的 IP 不受影响')
  t += 1001
  assert.equal(rl.allow('10.0.0.1'), true, '滑过窗口后恢复')
  ok('单 IP 限流按滑动窗口生效，且不误伤其他 IP')
}

console.log(`\n${n} 项发现协议断言通过`)
