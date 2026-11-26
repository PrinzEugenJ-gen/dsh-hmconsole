// DeepSeek 网页会话导入：适配器 + 纯解析 + 去重索引。
// 真实接口（2026-11 实测，公开无鉴权）：
//   GET https://chat.deepseek.com/api/v0/share/content?share_id=<id>
//   → { code:0, data:{ biz_code:0, biz_data:{ title, model_type, messages:[…] } } }
//   message: { message_id, parent_id, role:'USER'|'ASSISTANT', inserted_at, fragments:[{type:'REQUEST'|'THINK'|'RESPONSE', content}] }
// 注意：这是非官方接口，随时可能变；解析失败要如实报 parse-failed，不许假装成功。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const SHARE_API = 'https://chat.deepseek.com/api/v0/share/content?share_id='
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{6,80}$/
export const MAX_SHARE_BYTES = 4 * 1024 * 1024
export const MAX_MESSAGES = 400
export const MAX_TEXT = 200_000
export const IMPORT_SUBDIR = 'imports'
export const INDEX_VERSION = 1

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-hmconsole-import/1'

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

// 支持整条链接、带 query 的链接、以及裸 share id
export function parseShareUrl(input) {
  const raw = String(input == null ? '' : input).trim()
  if (raw === '') return ''
  if (SHARE_ID_RE.test(raw) && raw.indexOf('://') === -1 && raw.indexOf('?') === -1 && raw.indexOf('/') === -1) return raw
  let u = null
  try { u = new URL(raw) } catch (e) { return '' }
  const host = String(u.hostname || '').toLowerCase()
  if (!(host === 'chat.deepseek.com' || host.endsWith('.deepseek.com'))) return ''
  const q = String(u.searchParams.get('share_id') || '').trim()
  if (SHARE_ID_RE.test(q)) return q
  const m = /\/(?:a\/)?share\/([A-Za-z0-9_-]{6,80})/.exec(String(u.pathname || ''))
  return m ? m[1] : ''
}

function fragmentsText(frags, type) {
  return (Array.isArray(frags) ? frags : [])
    .filter((f) => f && String(f.type || '').toUpperCase() === type)
    .map((f) => String(f.content || ''))
    .join('\n')
    .trim()
}

function clip(s) {
  const t = String(s == null ? '' : s)
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t
}

// 分享页的 title 常常是 "Shared Conversation"，这时用首条用户消息首行兜底
export function deriveTitle(rawTitle, messages) {
  const t = String(rawTitle || '').trim()
  if (t !== '' && !/^shared conversation$/i.test(t)) return t.slice(0, 80)
  const first = (messages || []).find((m) => m && m.role === 'user' && String(m.text || '').trim() !== '')
  if (!first) return '来自 DeepSeek 网页端'
  const line = String(first.text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || ''
  return (line || '来自 DeepSeek 网页端').slice(0, 80)
}

export function parseSharePayload(json, meta) {
  const m0 = meta || {}
  // 业务码先判：code≠0 时 data 通常为空，先说清是"接口报错"而不是"结构变了"
  if (typeof (json && json.code) === 'number' && json.code !== 0) {
    throw fail('parse-failed', '接口返回 code=' + json.code + ' ' + String(json.msg || ''))
  }
  const root = json && json.data && json.data.biz_data
  if (!root || !Array.isArray(root.messages)) throw fail('parse-failed', '响应里没有 messages（接口可能变了）')

  const messages = []
  for (const m of root.messages) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant'
    const frags = m.fragments
    const text = role === 'user' ? fragmentsText(frags, 'REQUEST') : fragmentsText(frags, 'RESPONSE')
    const reasoning = role === 'assistant' ? fragmentsText(frags, 'THINK') : ''
    if (text === '' && reasoning === '') continue
    const item = { role, text: clip(text) }
    if (reasoning !== '') item.reasoning = clip(reasoning)
    const at = Number(m.inserted_at)
    if (Number.isFinite(at) && at > 0) item.at = Math.round(at * 1000)
    messages.push(item)
    if (messages.length >= MAX_MESSAGES) break
  }
  if (messages.length === 0) throw fail('parse-failed', '会话里没有可导入的正文')

  const times = messages.map((m) => m.at).filter((x) => Number.isFinite(x) && x > 0)
  return {
    source: 'deepseek-share',
    sourceId: String(m0.shareId || ''),
    title: deriveTitle(root.title, messages),
    model: String(root.model_type || ''),
    createdAt: times.length ? Math.min(...times) : 0,
    messages,
    count: messages.length,
  }
}

export function shareToMarkdown(conv) {
  const c = conv || {}
  const lines = []
  lines.push('# ' + String(c.title || '来自 DeepSeek 网页端'))
  lines.push('')
  lines.push('> 来源：DeepSeek 网页端分享 · share_id=' + String(c.sourceId || '') + (c.model ? ' · model=' + c.model : ''))
  lines.push('> 导入时间：' + new Date().toISOString())
  lines.push('')
  for (const m of c.messages || []) {
    lines.push(m.role === 'user' ? '## 用户' : '## 助手')
    lines.push('')
    if (m.reasoning) {
      lines.push('<details><summary>思考过程</summary>')
      lines.push('')
      lines.push(String(m.reasoning))
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
    lines.push(String(m.text || ''))
    lines.push('')
  }
  return lines.join('\n')
}

// 剪贴板通道：永远可用的兜底。识别几种常见分隔，都不匹配就整体当一条用户消息。
const ROLE_LINE_RE = /^\s*(?:#{1,6}\s*)?(用户|我|提问|you|user|助手|回答|assistant|ai|deepseek)\s*[:：]?\s*$/i
const INLINE_RE = /^\s*(用户|我|you|user|助手|assistant|ai)\s*[:：]\s*(.+)$/i

function roleOf(label) {
  const s = String(label || '').toLowerCase()
  if (/用户|我|you|user|提问/.test(s)) return 'user'
  return 'assistant'
}

export function parseClipboard(text) {
  const raw = String(text == null ? '' : text)
  if (raw.trim() === '') throw fail('bad-request', '内容为空')
  const lines = raw.split(/\r?\n/)
  const blocks = []
  let cur = null
  let matched = false

  for (const line of lines) {
    const sep = ROLE_LINE_RE.exec(line)
    if (sep) {
      matched = true
      if (cur && cur.text.trim() !== '') blocks.push(cur)
      cur = { role: roleOf(sep[1]), text: '' }
      continue
    }
    const inline = INLINE_RE.exec(line)
    if (inline) {
      matched = true
      if (cur && cur.text.trim() !== '') blocks.push(cur)
      cur = { role: roleOf(inline[1]), text: inline[2] + '\n' }
      continue
    }
    if (!cur) cur = { role: 'user', text: '' }
    cur.text += line + '\n'
  }
  if (cur && cur.text.trim() !== '') blocks.push(cur)

  const messages = blocks
    .map((b) => ({ role: b.role, text: clip(b.text.trim()) }))
    .filter((b) => b.text !== '')
  if (messages.length === 0) throw fail('parse-failed', '没解析出任何内容')
  return {
    source: 'clipboard',
    sourceId: '',
    title: deriveTitle('', messages),
    createdAt: 0,
    messages,
    count: messages.length,
    heuristic: matched,
  }
}

export async function fetchShare(shareId, opts) {
  const o = opts || {}
  const id = String(shareId || '')
  if (!SHARE_ID_RE.test(id)) throw fail('bad-request', 'share_id 不合法')
  const doFetch = typeof o.fetch === 'function' ? o.fetch : globalThis.fetch
  if (typeof doFetch !== 'function') throw fail('unavailable', '宿主没有 fetch')
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 15_000

  let res = null
  try {
    res = await doFetch(SHARE_API + encodeURIComponent(id), {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
  } catch (e) {
    throw fail('no-network', '取分享页失败：' + ((e && e.message) || e))
  }
  if (res.status === 404 || res.status === 410) throw fail('expired', '分享已失效或未公开')
  if (!res.ok) throw fail('no-network', '分享接口返回 ' + res.status)

  const text = await res.text()
  if (text.length > MAX_SHARE_BYTES) throw fail('too-large', '分享内容超过 ' + Math.round(MAX_SHARE_BYTES / 1048576) + 'MB')
  let json = null
  try { json = JSON.parse(text) } catch (e) { throw fail('parse-failed', '返回的不是 JSON（可能需要登录或被风控）') }
  return parseSharePayload(json, { shareId: id })
}

// ---- 去重索引（默认 ~/.dsh/dsh-hmconsole-imports.json） ----
export function importIndexPath(deps) {
  const d = deps || {}
  const explicit = String(d.importsPath || '').trim()
  if (explicit !== '') return explicit
  return path.join(os.homedir(), '.dsh', 'dsh-hmconsole-imports.json')
}

export function readIndex(file) {
  try {
    const j = JSON.parse(fs.readFileSync(String(file), 'utf8'))
    if (j && typeof j === 'object' && j.items && typeof j.items === 'object') return { version: INDEX_VERSION, items: j.items }
  } catch (e) { }
  return { version: INDEX_VERSION, items: {} }
}

export function writeIndex(file, data) {
  try {
    fs.mkdirSync(path.dirname(String(file)), { recursive: true })
    const tmp = String(file) + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, String(file))
    return true
  } catch (e) {
    return false
  }
}

export function dedupeKey(conv) {
  const c = conv || {}
  if (String(c.sourceId || '') !== '') return c.source + ':' + c.sourceId
  const body = (c.messages || []).map((m) => m.role + ':' + m.text).join('\n')
  const h = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)
  return c.source + ':sha256:' + h
}

export function safeStem(text) {
  const s = String(text == null ? '' : text).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (s || 'import').slice(0, 80)
}
