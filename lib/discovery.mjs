// 局域网发现：纯逻辑集中在这里，便于单测；lan-server 只负责 socket 生命周期。
// 兼容原则：v1 报文（旧 App）必须继续按老格式应答，v2 只做增量。

export const DISCOVERY_MAGIC = 'DSH-HMCONSOLE-PROBE'
export const DISCOVERY_PORT = 8898

const NONCE_RE = /^[0-9a-fA-F]{16,64}$/

// v1: "DSH-HMCONSOLE-PROBE"
// v2: "DSH-HMCONSOLE-PROBE/2 <nonce:16-64hex>"
export function parseProbe(text) {
  const raw = String(text == null ? '' : text).trim()
  if (raw === '') return null
  if (raw === DISCOVERY_MAGIC) return { version: 1, nonce: '' }
  if (!raw.startsWith(DISCOVERY_MAGIC + '/')) return null
  const parts = raw.slice(DISCOVERY_MAGIC.length + 1).trim().split(/\s+/)
  if (parts[0] !== '2') return null
  const nonce = String(parts[1] || '')
  if (!NONCE_RE.test(nonce)) return null
  return { version: 2, nonce }
}

export function buildReply(info, probe) {
  const i = info || {}
  const base = {
    ok: true,
    t: 'dsh-hmconsole',
    port: Number(i.port) || 0,
    name: String(i.name || ''),
    nodeId: String(i.nodeId || ''),
    host: String(i.host || ''),
  }
  if (!probe || probe.version !== 2) return JSON.stringify({ ...base, v: 1 })
  return JSON.stringify({
    ...base,
    v: 2,
    nonce: String(probe.nonce || ''),
    shortId: String(i.shortId || ''),
    tls: i.tls === true,
  })
}

// 只应答私网/本机来源；公网地址一律静默（UDP 无转发头，按源地址判断）
export function isPrivateAddress(addr) {
  const a = String(addr == null ? '' : addr).replace(/^::ffff:/i, '')
  if (a === '::1' || a === 'localhost') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (!m) return false
  const p1 = Number(m[1])
  const p2 = Number(m[2])
  for (const x of [p1, p2, Number(m[3]), Number(m[4])]) if (!(x >= 0 && x <= 255)) return false
  if (p1 === 10 || p1 === 127) return true
  if (p1 === 192 && p2 === 168) return true
  if (p1 === 172 && p2 >= 16 && p2 <= 31) return true
  if (p1 === 169 && p2 === 254) return true
  return false
}

// 单 IP 滑动窗口限流，防放大与扫段
export function createRateLimiter(opts) {
  const o = opts || {}
  const limit = Number(o.limit) > 0 ? Math.floor(Number(o.limit)) : 5
  const windowMs = Number(o.windowMs) > 0 ? Math.floor(Number(o.windowMs)) : 1000
  const now = typeof o.now === 'function' ? o.now : Date.now
  const hits = new Map()
  return {
    allow(ip) {
      const key = String(ip == null ? '' : ip) || '?'
      const t = now()
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs)
      if (arr.length >= limit) { hits.set(key, arr); return false }
      arr.push(t)
      hits.set(key, arr)
      if (hits.size > 1024) {
        for (const [k, v] of hits) if (v.length === 0 || t - v[v.length - 1] >= windowMs) hits.delete(k)
      }
      return true
    },
    reset() { hits.clear() },
    get size() { return hits.size },
  }
}
