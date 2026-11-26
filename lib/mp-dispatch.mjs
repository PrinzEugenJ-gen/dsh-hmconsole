import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, isAbsolute as isAbsPosix } from 'node:path'
import { isAbsolute as isAbsWin } from 'node:path/win32'
import {
  IMPORT_SUBDIR, dedupeKey, fetchShare, importIndexPath, parseClipboard, parseShareUrl,
  readIndex, safeStem, shareToMarkdown, writeIndex,
} from './web-import.mjs'
import {
  ALLOW, APP_PROTOCOL, MAX_UPLOAD_BYTES, SESSION_PAGE,
  WAN_FILE_READ_MAX, WAN_FILE_DOWNLOAD_MAX,
  approvalResponseBody, questionResponseBody,
  wrap, wrapBadRequest, wrapErr, wrapUnavailable,
} from './mp-contract.mjs'

const T_HISTORY = 20_000
const T_LIST = 15_000
const T_PROMPT = 120_000
const T_DEFAULT = 15_000

function timeout(ms) {
  try {
    return AbortSignal.timeout(ms)
  } catch (_) {
    return undefined
  }
}

const HIDDEN_ORIGINS = new Set(['subagent'])

function isHiddenOrigin(s) {
  const o = s && s.origin !== undefined && s.origin !== null ? String(s.origin) : ''
  return o !== '' && HIDDEN_ORIGINS.has(o)
}

function errOf(e) {
  const message = (e && e.message) || String(e)
  const code = (e && typeof e.code === 'string') ? e.code : 'error'
  return { code, message }
}

// 绝对路径校验：拒绝相对路径与任何 ".." 段，避免 App 侧路径穿越
function absPathOrThrow(raw) {
  const p = String(raw == null ? '' : raw).trim()
  if (p === '') { const e = new Error('缺少 path'); e.code = 'bad-request'; throw e }
  if (!(isAbsWin(p) || isAbsPosix(p))) { const e = new Error('必须是绝对路径：' + p); e.code = 'bad-request'; throw e }
  if (p.split(/[\\/]+/).some((seg) => seg === '..')) { const e = new Error('路径不允许包含 ..'); e.code = 'bad-request'; throw e }
  return p
}

export function createDispatcher(ctx, log, tracker, state) {
  const ctl = ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') : null
  const svc = (name) => (ctx && typeof ctx.get === 'function' ? ctx.get(name) : null)

  const can = (method) => !!ctl && typeof ctl[method] === 'function'
  const unsupported = (m) => wrapUnavailable('', `${m} 在 dsh-hmconsole 上不可用（宿主无此能力）`)

  // 复用宿主 runCommand，不复制 fs/工作区逻辑（见 02 任务书 P2「抽函数复用」）
  const bridge = (name) => (state && typeof state[name] === 'function' ? state[name] : null)
  async function runHost(op, payload, wan) {
    const run = bridge('runCommand')
    if (!run) { const e = new Error('宿主未提供 runCommand（插件版本过旧）'); e.code = 'unavailable'; throw e }
    const meta = { wan: wan === true }
    return run(op, payload || {}, meta)
  }

  function viewSession(s) {
    if (!s) return null
    const p = s.projections && s.projections.values ? s.projections.values : {}
    const id = String(s.sessionId || s.id || '')
    if (id === '') return null
    const sel = s.modelSelection || p.modelSelection || {}
    return {
      sessionId: id,
      title: String(s.title || p.title || ''),
      cwd: String(s.cwd || ''),
      updatedAt: Number(s.updatedAt) || 0,
      running: !!s.running,
      pinned: !!s.pinned,
      workspaceId: String(s.workspaceId || ''),
      model: String(sel.lastUsed || sel.next || ''),
      ...(state && state.pins && state.pins.has(id) ? { pinned: true } : {}),
    }
  }

  async function listSessions(payload) {
    if (!can('list')) throw new Error('这个 DSH 版本没有 sessionController.list')
    const r = await ctl.list({}, timeout(T_LIST))
    const items = (r && r.items ? r.items : r) || []
    const all = items.filter((s) => !isHiddenOrigin(s)).map(viewSession).filter(Boolean)

    all.sort((a, b) => b.updatedAt - a.updatedAt)
    const after = String((payload && payload.cursor) || '')
    if (after === '') {
      return { items: all.slice(0, SESSION_PAGE), hasMore: all.length > SESSION_PAGE, nextCursor: cursorOf(all[SESSION_PAGE - 1]) }
    }
    const idx = all.findIndex((s) => cursorOf(s) === after)
    if (idx === -1) {

      return { items: all.slice(0, SESSION_PAGE), hasMore: all.length > SESSION_PAGE, nextCursor: cursorOf(all[SESSION_PAGE - 1]) }
    }

    const start = idx + 1
    const next = all.slice(start, start + SESSION_PAGE)
    return {
      items: next,
      hasMore: all.length > start + next.length,
      nextCursor: cursorOf(next[next.length - 1]),
    }
  }

  function cursorOf(s) {
    return s ? `${s.updatedAt}:${s.sessionId}` : ''
  }

  function extractEvents(h) {
    if (Array.isArray(h)) return h
    if (h && Array.isArray(h.events)) return h.events
    if (h && h.value && Array.isArray(h.value.events)) return h.value.events
    if (h && h.history && Array.isArray(h.history.events)) return h.history.events
    if (h && Array.isArray(h.records)) return h.records
    return []
  }

  const handlers = {

    // 能力协商：methods[] 由 handler 表生成，避免手写清单与实际漂移
    'mp.hello': async (payload, rpcId, env) => {
      return wrap(rpcId, {
        appProtocol: APP_PROTOCOL,
        hostVersion: String((state && state.hostVersion) || ''),
        methods: Object.keys(handlers).sort(),
        features: {
          ws: true,
          fileRead: true,
          fileWrite: true,
          workspaceCreate: true,
          workspaceRemove: true,
          discovery: 'udp',
          pairTicketBridge: true,
          push: 'hms',
          webImport: ['share', 'clipboard'],
        },
        limits: {
          fileReadWan: WAN_FILE_READ_MAX,
          fileDownloadWan: WAN_FILE_DOWNLOAD_MAX,
          // D1：上传/下载/请求体统一 32MB（与 lan-server 的 FILE_WAN_MAX_BYTES 一致）
          uploadBodyWan: WAN_FILE_DOWNLOAD_MAX,
          sessionPage: SESSION_PAGE,
        },
        wan: !!(env && env.wan),
      })
    },

    'workspace.list': async (payload, rpcId) => {
      if (can('list')) {
        const r = await ctl.list({}, timeout(T_LIST))
        const items = (r && r.items ? r.items : r) || []

        return wrap(rpcId, {
          items: items.filter((s) => !isHiddenOrigin(s)).map((s) => ({
            workspaceId: String(s.workspaceId || s.cwd || ''),
            id: String(s.workspaceId || s.cwd || ''),
            path: String(s.cwd || ''),
            title: String(s.title || ''),
            sessionIds: [],
            updatedAt: Number(s.updatedAt) || 0,
          })),
        })
      }
      if (can('projections')) {
        const p = await ctl.projections({}, timeout(T_LIST))
        const items = (p && p.items) || []
        return wrap(rpcId, {
          items: items.map((w) => ({
            workspaceId: String(w.workspaceId || w.id || ''),
            id: String(w.workspaceId || w.id || ''),
            path: String(w.path || w.cwd || ''),
            title: String(w.title || ''),
            sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.map(String) : [],
            updatedAt: Number(w.updatedAt) || 0,
          })),
        })
      }
      return unsupported('workspace.list')
    },

    'workspace.create': async (payload, rpcId, env) => {
      const p = payload || {}
      const path = absPathOrThrow(p.path)
      const title = String(p.title || '').trim()
      const r = await runHost('wsCreate', title ? { path, title } : { path }, !!(env && env.wan))
      const id = String((r && (r.id || r.workspaceId)) || '')
      return wrap(rpcId, {
        workspaceId: id,
        id,
        path: String((r && r.path) || path),
        title: String((r && r.title) || title),
        created: r ? r.created !== false : true,
      })
    },

    'workspace.remove': async (payload, rpcId, env) => {
      const p = payload || {}
      const path = String(p.path || '').trim()
      const workspaceId = String(p.workspaceId || '').trim()
      if (path === '' && workspaceId === '') return wrapBadRequest(rpcId, '缺少 path 或 workspaceId')
      const r = await runHost('wsDelete', { path, workspaceId }, !!(env && env.wan))
      return wrap(rpcId, { removed: !!(r && r.removed === true) })
    },

    'host.drives': async (payload, rpcId, env) => {
      const r = await runHost('fsDrives', {}, !!(env && env.wan))
      const raw = Array.isArray(r && r.drives) ? r.drives : []
      const items = raw.map((d) => {
        const s = String(d || '').replace(/[\\/]+$/, '')
        return { name: s.endsWith(':') ? s : s + ':', path: s.endsWith(':') ? s + '\\' : s }
      })
      if (items.length === 0) items.push({ name: '/', path: '/' })
      return wrap(rpcId, { drives: items, home: String((r && r.home) || '') })
    },

    'host.mkdir': async (payload, rpcId, env) => {
      const path = absPathOrThrow((payload || {}).path)
      const r = await runHost('fsMkdir', { path }, !!(env && env.wan))
      return wrap(rpcId, { ok: true, path: String((r && r.path) || path) })
    },

    'host.stat': async (payload, rpcId, env) => {
      const path = absPathOrThrow((payload || {}).path)
      const r = await runHost('fsStat', { path }, !!(env && env.wan))
      return wrap(rpcId, {
        path: String((r && r.path) || path),
        name: String((r && r.name) || ''),
        dir: r ? r.dir === true : false,
        size: Number(r && r.size) || 0,
        mtime: Number(r && r.mtime) || 0,
        mime: String((r && r.mime) || ''),
      })
    },

    'host.readFile': async (payload, rpcId, env) => {
      const p = payload || {}
      const path = absPathOrThrow(p.path)
      const wan = !!(env && env.wan)
      const asked = Number(p.maxBytes) > 0 ? Math.floor(Number(p.maxBytes)) : 0
      // 公网一律夹到 3MB：不让客户端用 maxBytes 绕过配额
      const cap = wan ? WAN_FILE_READ_MAX : 0
      const maxBytes = cap > 0 ? (asked > 0 ? Math.min(asked, cap) : cap) : asked
      const r = await runHost('readFile', maxBytes > 0 ? { path, maxBytes } : { path }, wan)
      return wrap(rpcId, {
        path: String((r && r.path) || path),
        name: String((r && r.name) || ''),
        mime: String((r && r.mime) || ''),
        bytes: Number(r && r.bytes) || 0,
        b64: String((r && r.b64) || ''),
      })
    },

    'binding.list': async (payload, rpcId) => {
      const list = bridge('deviceList')
      if (!list) return wrap(rpcId, { items: [] })
      const raw = list() || []
      return wrap(rpcId, {
        items: (Array.isArray(raw) ? raw : []).map((d) => ({
          deviceId: String((d && d.deviceId) || ''),
          name: String((d && d.name) || ''),
          model: String((d && d.model) || ''),
          account: String((d && d.account) || ''),
          pairedAt: Number(d && d.pairedAt) || 0,
          lastSeen: Number(d && d.lastSeen) || 0,
        })),
      })
    },

    'gateway.status': async (payload, rpcId) => {
      const g = bridge('gatewayStatus')
      if (!g) {
        return wrap(rpcId, {
          hostName: '', lan: { on: false, port: 0, urls: [] },
          wan: { on: false, ready: false, kind: '', publicUrl: '', lastError: '' }, uptime: 0,
        })
      }
      return wrap(rpcId, g() || {})
    },

    'permission.catalog': async (payload, rpcId, env) => {
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const r = await runHost('permissionCatalog', sessionId ? { sessionId } : {}, !!(env && env.wan))
      return wrap(rpcId, r || { presets: [], current: '', defaultPreset: '' })
    },

    'permission.set': async (payload, rpcId, env) => {
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const permission = String(p.permission || '').trim()
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')
      if (permission === '') return wrapBadRequest(rpcId, '缺少 permission')
      const r = await runHost('permissionSet', { sessionId, permission }, !!(env && env.wan))
      return wrap(rpcId, { preset: permission, current: String((r && r.current) || permission) })
    },

    'webImport.probe': async (payload, rpcId) => {
      const url = String((payload || {}).url || '')
      const shareId = parseShareUrl(url)
      if (shareId === '') return wrapBadRequest(rpcId, '不是可识别的 DeepSeek 分享链接')
      return wrap(rpcId, { kind: 'share', sourceId: shareId, supported: true, channels: ['share', 'clipboard'] })
    },

    'webImport.pull': async (payload, rpcId) => {
      const p = payload || {}
      const shareId = parseShareUrl(p.url || p.sourceId || '')
      if (shareId === '') return wrapBadRequest(rpcId, '不是可识别的 DeepSeek 分享链接')
      const conv = await fetchShare(shareId, { fetch: bridge('webFetch') || undefined })
      return wrap(rpcId, conv)
    },

    // 侧写落盘 + 可选建会话；默认写 imports/<id>.md，重复导入直接返回已有会话
    'webImport.commit': async (payload, rpcId, env) => {
      const p = payload || {}
      const targetDir = absPathOrThrow(p.targetDir)

      let conv = null
      if (Array.isArray(p.messages) && p.messages.length > 0) {
        const source = String(p.source || 'clipboard') === 'deepseek-share' ? 'deepseek-share'
          : (String(p.source || '') === 'share' ? 'deepseek-share' : 'clipboard')
        const messages = p.messages
          .map((m) => {
            const role = String((m && m.role) || 'user') === 'assistant' ? 'assistant' : 'user'
            const text = String((m && m.text) || '').trim()
            const item = { role, text }
            if (m && m.reasoning) item.reasoning = String(m.reasoning)
            return item
          })
          .filter((m) => m.text !== '')
        if (messages.length === 0) return wrapBadRequest(rpcId, 'messages 里没有正文')
        const title = String(p.title || '').trim()
          || String(messages[0].text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0].slice(0, 80)
        conv = {
          source, sourceId: String(p.sourceId || ''), title,
          createdAt: Number(p.createdAt) || 0, messages, count: messages.length,
        }
      } else {
        const shareId = parseShareUrl(p.url || p.sourceId || '')
        if (shareId === '') return wrapBadRequest(rpcId, '缺少 messages，或 url 不是可识别的分享链接')
        conv = await fetchShare(shareId, { fetch: bridge('webFetch') || undefined })
      }

      const dir = join(targetDir, IMPORT_SUBDIR)
      const key = dedupeKey(conv)
      const stem = safeStem(conv.sourceId || key.split(':').pop() || 'import')
      const file = join(dir, stem + '.md')
      const idxFile = String((state && state.importsPath) || '') || importIndexPath()
      const idx = readIndex(idxFile)
      const hit = idx.items[key]
      if (hit && p.overwrite !== true) {
        return wrap(rpcId, {
          duplicate: true, sessionId: String(hit.sessionId || ''),
          path: String(hit.path || file), title: String(hit.title || conv.title), count: Number(hit.count) || 0,
        })
      }

      mkdirSync(dir, { recursive: true })
      if (p.writeFile !== false) writeFileSync(file, shareToMarkdown(conv), 'utf8')

      let sessionId = ''
      if (p.createSession !== false) {
        const r = await runHost('create', { cwd: targetDir }, !!(env && env.wan))
        sessionId = String((r && (r.sessionId || r.id)) || '')
      }
      idx.items[key] = {
        at: Date.now(), sessionId, path: file, title: conv.title, count: conv.messages.length,
      }
      writeIndex(idxFile, idx)
      return wrap(rpcId, {
        duplicate: false, source: conv.source, sourceId: String(conv.sourceId || ''),
        title: conv.title, count: conv.messages.length, path: file, sessionId,
      })
    },

    'host.listDirectory': async (payload, rpcId) => {
      const path = String((payload && payload.path) || '')
      if (path === '') return wrapBadRequest(rpcId, '缺少 path')
      const p = svc('host') || svc('fileSystem')
      if (p && typeof p.listDirectory === 'function') {
        return wrap(rpcId, await p.listDirectory({ path }, timeout(T_DEFAULT)))
      }

      return wrap(rpcId, { path, entries: [], unavailable: true })
    },

    'agentPreset.list': async (payload, rpcId) => {
      const p = svc('agentPresets') || svc('presets')
      if (p && typeof p.list === 'function') {
        return wrap(rpcId, { items: await p.list({}, timeout(T_DEFAULT)) })
      }
      if (can('resolveAgent')) {
        return wrap(rpcId, { items: [], unavailable: true })
      }
      return unsupported('agentPreset.list')
    },

    'session.list': (payload, rpcId) => listSessions(payload).then((v) => wrap(rpcId, v)),

    'session.create': async (payload, rpcId) => {
      if (!can('create')) return unsupported('session.create')
      const created = await ctl.create({
        ...(payload || {}),
        requestId: `mp-${rpcId || Date.now().toString(36)}`,
      }, timeout(T_DEFAULT))
      return wrap(rpcId, { ...(created || {}), view: viewSession(created) })
    },

    'session.history': async (payload, rpcId) => {
      if (!can('history')) return unsupported('session.history')
      const sessionId = String((payload && payload.sessionId) || '')
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')
      const max = Number((payload && payload.maxMessages) || 50)
      const before = Number(payload && payload.beforeSeq)
      const req = { sessionId, limit: max }
      if (Number.isFinite(before) && before >= 0) req.beforeSeq = before
      const h = await ctl.history(req, timeout(T_HISTORY))
      const events = extractEvents(h)
      return wrap(rpcId, {
        sessionId,
        events,
        hasMore: events.length >= max,
        ...(h && h.maxSeq !== undefined ? { maxSeq: h.maxSeq } : {}),
      })
    },

    'session.prompt': async (payload, rpcId) => {
      if (!can('prompt')) return unsupported('session.prompt')
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')

      const incoming = Array.isArray(p.content) ? p.content : null
      const content = []
      if (incoming) {
        for (const part of incoming) {
          if (!part || typeof part !== 'object') continue
          if (part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
            content.push({ type: 'text', text: part.text })
          } else if (part.type === 'image' && typeof part.data === 'string' && part.data !== '') {
            const image = { type: 'image', mediaType: String(part.mediaType || 'image/jpeg'), data: part.data }
            if (typeof part.name === 'string' && part.name !== '') image.name = part.name
            content.push(image)
          }
        }
      } else {

        const text = String(p.text || '')
        if (text !== '') content.push({ type: 'text', text })
        for (const a of (Array.isArray(p.attachments) ? p.attachments : [])) {
          const id = String((a && (a.attachmentId || a.id)) || a || '')
          if (id !== '') content.push({ type: 'attachment', attachmentId: id })
        }
      }

      if (content.length === 0) return wrapBadRequest(rpcId, '消息是空的')

      let tz = ''
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      } catch (_) {
        tz = ''
      }
      const request = {
        requestId: String(p.requestId || rpcId || `req-${Date.now().toString(36)}`),
        sessionId,
        // D3：保留插话，但默认仍是排队；只有显式 busyMode:'steer' 才插话
        mode: p.busyMode === 'steer' ? 'steer' : 'queue',
        content,
      }
      if (tz !== '') request.clientTimeZone = tz
      return wrap(rpcId, await ctl.prompt(request, timeout(T_PROMPT)) ?? { accepted: true })
    },

    'session.cancel': async (payload, rpcId) => {
      if (!can('cancel')) return unsupported('session.cancel')
      const sessionId = String((payload && payload.sessionId) || '')
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')
      return wrap(rpcId, await ctl.cancel({ sessionId }, timeout(T_DEFAULT)))
    },

    'session.attachment': async (payload, rpcId) => {
      if (!can('attachment')) return unsupported('session.attachment')
      return wrap(rpcId, await ctl.attachment(payload || {}, timeout(T_DEFAULT)))
    },

    'session.models': async (payload, rpcId) => {
      if (!can('modelCatalog')) return unsupported('session.models')
      const v = await ctl.modelCatalog({}, timeout(T_DEFAULT))
      return wrap(rpcId, v)
    },

    'session.selectModel': async (payload, rpcId) => {
      if (!can('selectModel')) return unsupported('session.selectModel')
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const model = String(p.model || '')
      if (sessionId === '' || model === '') return wrapBadRequest(rpcId, '缺少 sessionId 或 model')
      return wrap(rpcId, await ctl.selectModel({ sessionId, model }, timeout(T_DEFAULT)))
    },

    'skill.list': async (payload, rpcId) => {

      if (can('commands')) {
        const v = await ctl.commands({}, timeout(T_DEFAULT))
        return wrap(rpcId, { items: [], commands: v })
      }
      return unsupported('skill.list')
    },

    'command.list': async (payload, rpcId) => {
      if (!can('commands')) return unsupported('command.list')
      return wrap(rpcId, await ctl.commands({}, timeout(T_DEFAULT)))
    },

    'command.execute': async (payload, rpcId) => {
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const name = String(p.name || '')
      if (sessionId === '' || name === '') return wrapBadRequest(rpcId, '缺少 sessionId 或 name')
      if (!can('prompt')) return unsupported('command.execute')

      const text = `/${name}${p.args ? ' ' + String(p.args) : ''}`
      return wrap(rpcId, await ctl.prompt({
        requestId: `mp-${rpcId || Date.now().toString(36)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, timeout(T_PROMPT)))
    },

    'mobile.pending': async (payload, rpcId) => {
      if (!tracker) return wrap(rpcId, { approvals: [], questions: [] })
      return wrap(rpcId, tracker.snapshot())
    },

    'mobile.respond': async (payload, rpcId) => {
      if (!tracker) return wrapUnavailable(rpcId, '没有审批追踪器')
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      const type = String(p.type || '')

      if (sessionId === '' && (type === 'approval' || type === 'question')) {
        log('[mp] 回执没带 sessionId（宿主事件不带此字段），按 ' + type + ' 的 id 对账')
      }

      if (type === 'approval') {
        const body = approvalResponseBody(sessionId, p)
        if (body.approvalId === '') return wrapErr(rpcId, 'bad-request', '缺少 approvalId')
        return wrap(rpcId, tracker.resolveApproval(body))
      }
      if (type === 'question') {
        const body = questionResponseBody(sessionId, p)
        if (body.rpcId === '') return wrapErr(rpcId, 'bad-request', '缺少 rpcId')
        return wrap(rpcId, tracker.resolveQuestion(body))
      }
      return wrapErr(rpcId, 'bad-request', 'unknown respond type')
    },

    'quota.read': async (payload, rpcId) => {
      const q = svc('quota')
      if (q && typeof q.read === 'function') return wrap(rpcId, await q.read({}, timeout(T_DEFAULT)))
      return wrap(rpcId, { unavailable: true })
    },

    'host.restart': async (payload, rpcId) => {
      return wrapUnavailable(rpcId, 'dsh-hmconsole 不重启宿主（那会把自己也杀掉）')
    },

    'session.pins': async (payload, rpcId) => {
      return wrap(rpcId, { sessionIds: [...((state && state.pins) || [])] })
    },

    'session.pin': async (payload, rpcId) => {
      const p = payload || {}
      const sessionId = String(p.sessionId || '')
      if (sessionId === '') return wrapBadRequest(rpcId, '缺少 sessionId')
      if (state && state.pins) {
        if (p.pinned === true) state.pins.add(sessionId)
        else state.pins.delete(sessionId)
      }
      return wrap(rpcId, { sessionId, pinned: p.pinned === true })
    },

    'push.key': async (payload, rpcId) => {

      return wrap(rpcId, { key: '', unsupported: 'harmony-no-web-push' })
    },
    'push.subscribe': async (payload, rpcId) => wrap(rpcId, { ok: false, unsupported: true }),
    'push.unsubscribe': async (payload, rpcId) => wrap(rpcId, { ok: true }),
  }

  return async function dispatch(method, payload, rpcId, env) {
    const h = handlers[method]
    if (!h) {
      log('[mp] 方法不在白名单: ' + method)
      return wrapErr(rpcId, 'forbidden', `unknown method: ${method}`)
    }
    try {
      return await h(payload || {}, rpcId, env || {})
    } catch (e) {
      const { code, message } = errOf(e)
      log('[mp] ' + method + ' 失败: ' + code + ' ' + message)
      return wrapErr(rpcId, code, message)
    }
  }
}

export { ALLOW, MAX_UPLOAD_BYTES }
