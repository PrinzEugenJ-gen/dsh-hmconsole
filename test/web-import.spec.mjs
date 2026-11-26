import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  dedupeKey, deriveTitle, fetchShare, parseClipboard, parseSharePayload, parseShareUrl, safeStem, shareToMarkdown,
} from '../lib/web-import.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'deepseek-share.json'), 'utf8'))

let n = 0
const ok = (t) => { n++; console.log('  ok - ' + t) }
const section = (t) => console.log('\n' + t)

section('链接解析')

assert.equal(parseShareUrl('https://chat.deepseek.com/share/engtbxuvz0v6g8mldl'), 'engtbxuvz0v6g8mldl')
assert.equal(parseShareUrl('https://chat.deepseek.com/share/engtbxuvz0v6g8mldl?from=app'), 'engtbxuvz0v6g8mldl')
assert.equal(parseShareUrl('https://chat.deepseek.com/a/chat/share/engtbxuvz0v6g8mldl'), 'engtbxuvz0v6g8mldl')
assert.equal(parseShareUrl('https://chat.deepseek.com/x?share_id=engtbxuvz0v6g8mldl'), 'engtbxuvz0v6g8mldl')
assert.equal(parseShareUrl('engtbxuvz0v6g8mldl'), 'engtbxuvz0v6g8mldl')
assert.equal(parseShareUrl('https://evil.example.com/share/engtbxuvz0v6g8mldl'), '', '非 deepseek 域名必须拒绝')
assert.equal(parseShareUrl('https://chat.deepseek.com/chat'), '')
assert.equal(parseShareUrl(''), '')
ok('只认 deepseek 域名下的 share 链接/裸 id，别家链接一律拒绝')

section('分享响应解析（真实结构）')

{
  const conv = parseSharePayload(FIXTURE, { shareId: 'engtbxuvz0v6g8mldl' })
  assert.equal(conv.source, 'deepseek-share')
  assert.equal(conv.sourceId, 'engtbxuvz0v6g8mldl')
  assert.equal(conv.count, 2)
  assert.equal(conv.messages[0].role, 'user')
  assert.equal(conv.messages[0].text, '幺正变换')
  assert.equal(conv.messages[1].role, 'assistant')
  assert.ok(conv.messages[1].text.includes('幺正变换'))
  assert.ok(conv.messages[1].text.includes('U^\\dagger U'), 'LaTeX 反斜杠必须原样保留')
  assert.ok(conv.messages[1].reasoning.includes('内积空间'), 'THINK 片段进 reasoning，不混进正文')
  assert.equal(conv.model, 'default')
  assert.equal(conv.createdAt, 1795144996182, 'inserted_at(秒) 要换成毫秒且取最早')
  ok('REQUSET/RESPONSE/THINK 三类片段各归其位，公式与时间都保留')
}

{
  const conv = parseSharePayload(FIXTURE, { shareId: 'x' })
  assert.equal(conv.title, '幺正变换', '通用标题必须被首条用户消息替换')
  ok('title 是 "Shared Conversation" 时用首条用户消息兜底')
}

assert.throws(() => parseSharePayload({ code: 0, data: {} }, {}), /messages/)
assert.throws(() => parseSharePayload({ code: 401, msg: 'no' }, {}), /code=401/)
assert.throws(() => parseSharePayload({ data: { biz_data: { messages: [] } } }, {}), /没有可导入/)
ok('结构不符/业务码非 0/空会话都抛 parse-failed，不产生空会话')

section('剪贴板通道')

{
  const md = '## 用户\n什么是幺正变换？\n\n## 助手\n它是保持内积不变的线性变换。'
  const conv = parseClipboard(md)
  assert.equal(conv.count, 2)
  assert.equal(conv.messages[0].role, 'user')
  assert.equal(conv.messages[1].role, 'assistant')
  assert.equal(conv.heuristic, true)
  ok('Markdown 小标题格式能识别')

  const cn = '我：解释一下傅里叶变换\n助手：它把信号拆成不同频率。'
  const c2 = parseClipboard(cn)
  assert.equal(c2.count, 2)
  assert.equal(c2.messages[0].text, '解释一下傅里叶变换')
  ok('「我：/助手：」行内格式能识别')

  const plain = '一段没有任何标记的对话内容。'
  const c3 = parseClipboard(plain)
  assert.equal(c3.count, 1)
  assert.equal(c3.messages[0].role, 'user')
  assert.equal(c3.heuristic, false)
  ok('没有标记时整体当一条用户消息，永不失败')

  assert.throws(() => parseClipboard('   '), /内容为空/)
}

section('Markdown 渲染与去重')

{
  const conv = parseSharePayload(FIXTURE, { shareId: 'engtbxuvz0v6g8mldl' })
  const md = shareToMarkdown(conv)
  assert.ok(md.startsWith('# 幺正变换'))
  assert.ok(md.includes('share_id=engtbxuvz0v6g8mldl'))
  assert.ok(md.includes('## 用户'))
  assert.ok(md.includes('## 助手'))
  assert.ok(md.includes('<details><summary>思考过程</summary>'), '思考过程要可折叠')
  ok('Markdown 带来源、角色分段、思考折叠')

  const k1 = dedupeKey(conv)
  const k2 = dedupeKey(parseSharePayload(FIXTURE, { shareId: 'engtbxuvz0v6g8mldl' }))
  assert.equal(k1, k2)
  assert.equal(k1, 'deepseek-share:engtbxuvz0v6g8mldl')

  const clip = parseClipboard('用户：a\n助手：b')
  const ck1 = dedupeKey(clip)
  const ck2 = dedupeKey(parseClipboard('用户：a\n助手：b'))
  assert.equal(ck1, ck2)
  assert.ok(ck1.startsWith('clipboard:sha256:'), '剪贴板没有 sourceId，用内容指纹去重')
  ok('分享用 sourceId 去重，剪贴板用 sha256 内容指纹去重')
}

section('fetch 的错误分级')

{
  const fake = (status, body) => async () => ({
    status,
    ok: status >= 200 && status < 300,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
  })

  const good = await fetchShare('engtbxuvz0v6g8mldl', { fetch: fake(200, FIXTURE) })
  assert.equal(good.count, 2)
  ok('正常响应能直接解析')

  await assert.rejects(() => fetchShare('engtbxuvz0v6g8mldl', { fetch: fake(404, '') }), (e) => e.code === 'expired')
  await assert.rejects(() => fetchShare('engtbxuvz0v6g8mldl', { fetch: fake(500, '') }), (e) => e.code === 'no-network')
  await assert.rejects(() => fetchShare('engtbxuvz0v6g8mldl', { fetch: fake(200, '<html>') }), (e) => e.code === 'parse-failed')
  await assert.rejects(() => fetchShare('engtbxuvz0v6g8mldl', { fetch: async () => { throw new Error('offline') } }), (e) => e.code === 'no-network')
  await assert.rejects(() => fetchShare('bad id!', { fetch: fake(200, FIXTURE) }), (e) => e.code === 'bad-request')
  ok('404=expired / 5xx=no-network / 非 JSON=parse-failed / 抛错=no-network / 坏 id=bad-request')

  assert.equal(safeStem('engtbxuvz0v6g8mldl'), 'engtbxuvz0v6g8mldl')
  assert.equal(safeStem('../a b/../c'), 'a-b-c')
  ok('文件名清洗挡住路径穿越')
}

section('标题派生')

assert.equal(deriveTitle('自定义标题', []), '自定义标题')
assert.equal(deriveTitle('Shared Conversation', [{ role: 'user', text: '第一行\n第二行' }]), '第一行')
assert.equal(deriveTitle('', []), '来自 DeepSeek 网页端')
ok('标题派生：真标题优先，通用标题回退到首行，再回退到默认名')

console.log(`\n${n} 项网页导入断言通过`)
