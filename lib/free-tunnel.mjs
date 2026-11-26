// 免费公网隧道（免注册、免充值）
//
// 思路：插件本机监听 127.0.0.1:8898，这里用系统自带的 ssh 做「反向端口转发」，
// 接到公共服务商的免费隧道上（localhost.run / pinggy / serveo），拿到一个公网
// HTTPS 地址。手机在蜂窝网直接访问这个地址即可，不需要任何账号、会员或兑换码。
//
// 与 frpc 那套的区别：
//   * frpc 需要一台自己的公网服务器（自建 frps），地址固定；
//   * 免费隧道不需要服务器，但地址是随机的、服务商可能限速/掉线。
// 两者二选一，都在面板「连接与安全」里开关。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const FREE_TUNNEL_CONFIG = path.join(os.homedir(), '.dsh', 'dsh-hmconsole-free-tunnel.json')

export const FREE_TUNNEL_PROVIDERS = [
  {
    id: 'serveo',
    label: 'serveo.net',
    host: 'serveo.net',
    sshTarget: 'serveo.net',
    buildArgs: (port) => [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=' + os.devNull,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', '80:127.0.0.1:' + port,
      'serveo.net'
    ]
  },
  {
    id: 'pinggy',
    label: 'pinggy.io',
    host: 'a.pinggy.io',
    sshTarget: 'a.pinggy.io',
    buildArgs: (port) => [
      '-p', '443',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=' + os.devNull,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-R0:127.0.0.1:' + port,
      'a.pinggy.io'
    ]
  },
  {
    // localhost.run 现在要求先有 SSH key 才会给出地址，留作备选
    id: 'localhostrun',
    label: 'localhost.run',
    host: 'localhost.run',
    sshTarget: 'nokey@localhost.run',
    buildArgs: (port) => [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=' + os.devNull,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', '80:127.0.0.1:' + port,
      'nokey@localhost.run'
    ]
  }
]

const URL_RE = /(https:\/\/[a-z0-9][a-z0-9.-]*\.(?:lhr\.life|localhost\.run|pinggy\.link|a\.pinggy\.link|serveo\.net|trycloudflare\.com))\b/i

const PROVIDER_URL_RE = {
  serveo: /https:\/\/[a-z0-9][a-z0-9.-]*\.(?:serveousercontent\.com|serveo\.net)\b/i,
  pinggy: /https:\/\/[a-z0-9][a-z0-9-]*\.(?:a\.pinggy\.link|pinggy\.link)\b/i,
  localhostrun: /https:\/\/[a-z0-9][a-z0-9-]*\.lhr\.life\b/i
}

// 只在真正握手失败时记错误；banner 里那句 "If you get a permission denied error…"
// 不能当成错误（实测踩过：把欢迎语当成了失败原因）。
const HARD_ERROR_RE = /(Permission denied \(publickey|Connection refused|Connection timed out|Could not resolve hostname|exit status 255|Host key verification failed)/i

const ANSI_RE = /\u001b\[[0-9;?]*[a-zA-Z]/g

const RETRY_MIN_MS = 4000
const RETRY_MAX_MS = 60000
const CONNECT_TIMEOUT_MS = 60000

function textOf(v) { return String(v == null ? '' : v).trim() }

export function providerOf(id) {
  const want = textOf(id)
  for (const p of FREE_TUNNEL_PROVIDERS) if (p.id === want) return p
  return FREE_TUNNEL_PROVIDERS[0]
}

export function normalizeFreeTunnel(j) {
  const src = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}
  return {
    enabled: src.enabled === true || src.on === true,
    provider: providerOf(src.provider).id,
    sshPath: textOf(src.sshPath)
  }
}

export function readFreeTunnelConfig(cfgPath = FREE_TUNNEL_CONFIG, log) {
  try {
    if (!fs.existsSync(cfgPath)) return { ok: true, exists: false, cfg: normalizeFreeTunnel(null) }
    return { ok: true, exists: true, cfg: normalizeFreeTunnel(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))) }
  } catch (e) {
    if (typeof log === 'function') log('[free-tunnel] 配置读不了，按关闭处理：' + ((e && e.message) || e))
    return { ok: false, exists: false, cfg: normalizeFreeTunnel(null) }
  }
}

export function writeFreeTunnelConfig(cfg, cfgPath = FREE_TUNNEL_CONFIG) {
  const c = normalizeFreeTunnel(cfg)
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2), { mode: 0o600 })
  return c
}

export function parsePublicUrl(chunk, providerId) {
  const s = String(chunk || '').replace(ANSI_RE, '')
  const re = PROVIDER_URL_RE[providerId]
  if (re) {
    const m = s.match(re)
    if (m) return m[0]
  }
  const m = s.match(URL_RE)
  if (!m) return ''
  if (/^https:\/\/admin\./i.test(m[0])) return ''
  return m[0]
}

export function createFreeTunnel(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const cfgPath = textOf(opts.cfgPath) || FREE_TUNNEL_CONFIG
  const getPort = typeof opts.getPort === 'function' ? opts.getPort : () => 8898

  let cfg = readFreeTunnelConfig(cfgPath, log).cfg

  let child = null
  let phase = 'disabled'
  let lastError = ''
  let publicUrl = ''
  let since = 0
  let retryTimer = null
  let retryMs = RETRY_MIN_MS
  let connectTimer = null
  let stopping = false
  // 代数：每次 start/stop 自增。旧子进程的 data/exit/超时回调只认自己那一代，
  // 避免「旧孩子退出 → 触发重连 → 又多一个孩子」的重复进程问题（实测踩过）。
  let gen = 0

  function snapshot() {
    const provider = providerOf(cfg.provider)
    return {
      enabled: cfg.enabled === true,
      ready: phase === 'connected' && publicUrl !== '',
      phase: phase,
      lastError: lastError,
      serverAddr: provider.host,
      remotePort: 0,
      since: since,
      publicUrl: publicUrl,
      provider: provider.id,
      providerLabel: provider.label,
      sshPath: cfg.sshPath,
      kind: 'free'
    }
  }

  function clearTimers() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
  }

  function scheduleRetry() {
    if (!cfg.enabled) return
    if (retryTimer) return
    const myGen = gen
    const wait = retryMs
    retryMs = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, retryMs * 2))
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (myGen !== gen) return
      if (cfg.enabled) start()
    }, wait)
    if (retryTimer.unref) retryTimer.unref()
    log('[free-tunnel] ' + Math.round(wait / 1000) + ' 秒后重试')
  }

  function onExit(code, signal) {
    clearTimers()
    if (!cfg.enabled) { phase = 'disabled'; return }
    if (stopping) { stopping = false; return }
    phase = 'reconnecting'
    lastError = '隧道断开（code=' + code + (signal ? ', signal=' + signal : '') + '），正在重连'
    log('[free-tunnel] ' + lastError)
    scheduleRetry()
  }

  function handleOutput(buf) {
    const s = String(buf || '').replace(ANSI_RE, '')
    if (s === '') return
    if (HARD_ERROR_RE.test(s)) {
      lastError = '连不上隧道服务器：' + s.replace(/\s+/g, ' ').trim().slice(0, 180)
      log('[free-tunnel] ' + lastError)
    }
    const u = parsePublicUrl(s, cfg.provider)
    if (u && u !== publicUrl) {
      publicUrl = u
      phase = 'connected'
      since = Date.now()
      lastError = ''
      retryMs = RETRY_MIN_MS
      log('[free-tunnel] 已连上：' + u)
    }
  }

  function start() {
    if (!cfg.enabled) return snapshot()
    if (child) return snapshot()
    const provider = providerOf(cfg.provider)
    const port = Number(getPort()) || 8898
    const ssh = cfg.sshPath !== '' ? cfg.sshPath : 'ssh'
    phase = 'starting'
    lastError = ''
    publicUrl = ''
    stopping = false
    const myGen = ++gen
    let c = null
    try {
      c = spawn(ssh, provider.buildArgs(port), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      c = null
      phase = 'error'
      lastError = '启动 ssh 失败：' + ((e && e.message) || e)
      log('[free-tunnel] ' + lastError)
      scheduleRetry()
      return snapshot()
    }
    child = c
    c.stdout.setEncoding('utf8')
    c.stderr.setEncoding('utf8')
    c.stdout.on('data', (b) => { if (myGen === gen) handleOutput(b) })
    c.stderr.on('data', (b) => { if (myGen === gen) handleOutput(b) })
    c.on('error', (e) => {
      if (myGen !== gen) return
      lastError = 'ssh 进程出错：' + ((e && e.message) || e)
      log('[free-tunnel] ' + lastError)
    })
    c.on('exit', (code, sig) => {
      if (myGen !== gen) return
      child = null
      onExit(code, sig)
    })
    connectTimer = setTimeout(() => {
      connectTimer = null
      if (myGen !== gen) return
      if (phase === 'starting') {
        lastError = '连接 ' + provider.host + ' 超时（' + Math.round(CONNECT_TIMEOUT_MS / 1000) + ' 秒没拿到地址）'
        log('[free-tunnel] ' + lastError)
        try { stopChild() } catch (e) {  }
        phase = 'reconnecting'
        scheduleRetry()
      }
    }, CONNECT_TIMEOUT_MS)
    if (connectTimer.unref) connectTimer.unref()
    log('[free-tunnel] 正在连接 ' + provider.label + '（本机 127.0.0.1:' + port + '）')
    return snapshot()
  }

  function killChild(c) {
    if (!c) return
    const pid = c.pid
    try { c.kill() } catch (e) {  }
    // Windows 上 child.kill() 有时只杀掉外壳、ssh 本身还活着（实测会漏成孤儿进程），
    // 这里再按 PID 整棵进程树强杀一次。
    try {
      if (process.platform === 'win32' && pid) {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
    } catch (e) {  }
  }

  function stopChild() {
    gen += 1
    stopping = true
    const c = child
    child = null
    killChild(c)
  }

  function stop() {
    clearTimers()
    stopChild()
    stopping = false
    phase = 'disabled'
    lastError = ''
    publicUrl = ''
    since = 0
    retryMs = RETRY_MIN_MS
    return snapshot()
  }

  function setConfig(next) {
    const want = normalizeFreeTunnel(Object.assign({}, cfg, next || {}))
    const wasEnabled = cfg.enabled === true
    const providerChanged = want.provider !== cfg.provider
    cfg = writeFreeTunnelConfig(want, cfgPath)
    if (cfg.enabled !== true) { stop(); return snapshot() }
    if (!wasEnabled || providerChanged || phase !== 'connected') {
      stopChild()
      clearTimers()
      retryMs = RETRY_MIN_MS
      phase = 'starting'
      start()
    }
    return snapshot()
  }

  function boot() {
    if (cfg.enabled !== true) { phase = 'disabled'; return snapshot() }
    start()
    return snapshot()
  }

  return { snapshot, start, stop, setConfig, boot, config: () => Object.assign({}, cfg) }
}
