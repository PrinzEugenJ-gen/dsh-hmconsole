
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { createLiveUpgrade } from '../lib/mp-ws-live.mjs'

const SID = 'Z7YLZH8T32E6QZ3'
const SECRET = 'a'.repeat(48)
let n = 0
const ok = (name) => { n++; console.log('  ok - ' + name) }

function serve(store) {
  const onUpgrade = createLiveUpgrade({
    log: () => {},
    store,
    tracker: null,
    ctx: { on: () => () => {} },
    onStream: null,
  })

  const server = http.createServer((req, res) => { res.writeHead(404).end() })
  server.on('upgrade', (req, socket, head) => onUpgrade(req, socket, head))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }))
  })
}

function handshake(port, path, cookie) {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.setTimeout(1500, () => finish('TIMEOUT'))
      sock.on('data', (b) => {
        buf += b.toString('latin1')
        if (buf.length > 40) finish(buf.split('\r\n')[0])
      })
      sock.on('close', () => finish(buf.split('\r\n')[0] || 'CLOSED-EMPTY'))
      sock.on('error', (e) => finish('ERR:' + e.message))
      let req = 'GET ' + path + ' HTTP/1.1\r\n'
        + 'Host: gaoshou25.cn\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      if (cookie !== undefined && cookie !== '') req += 'Cookie: mp_device=' + cookie + '\r\n'
      sock.write(req + '\r\n')
    })
    const finish = (v) => {
      if (done) return
      done = true
      try { sock.destroy() } catch (e) { }
      resolve(v)
    }
  })
}

const pairedStore = { isPaired: (s) => s === SECRET }
const { port, server } = await serve(pairedStore)

console.log('\n第1681节 · 公网 WebSocket 升级（带短号前缀）')

assert.equal(await handshake(port, '/mp/api/ws/mux', SECRET), 'HTTP/1.1 101 Switching Protocols')
ok('裸路径照旧能升级（局域网口径不变）')

assert.equal(await handshake(port, '/dsh-hmconsole/' + SID + '/mp/api/ws/mux', SECRET),
  'HTTP/1.1 101 Switching Protocols')
ok('公网带短号路径能升级 —— 本节修的就是这条')

assert.equal(await handshake(port, '/dafeiyu/ABCDEFGHIJKLMNO/mp/api/ws/host', SECRET),
  'HTTP/1.1 101 Switching Protocols')
ok('老厂牌前缀 + 任意短号也能升级')

const bad = await handshake(port, '/dsh-hmconsole/' + SID + '/nope', SECRET)
assert.notEqual(bad, 'TIMEOUT', '认不出的 upgrade 绝不能晾着（晾着 = 客户端干等超时且零日志）')
assert.match(bad, /^HTTP\/1\.1 404/)
ok('认不出的 upgrade 立刻 404 并关连接，不再静默挂死')

assert.equal(await handshake(port, '/dsh-hmconsole/' + SID + '/mp/api/ws/mux', ''),
  'HTTP/1.1 401 Unauthorized')
ok('带前缀路径上，无 Cookie 仍必须 401（闸门没被放宽）')

assert.equal(await handshake(port, '/dsh-hmconsole/' + SID + '/mp/api/ws/mux', 'b'.repeat(48)),
  'HTTP/1.1 401 Unauthorized')
ok('未登记的 secret 同样 401')

server.close()
console.log('\n' + n + ' 项 WS 前缀回归断言通过')
