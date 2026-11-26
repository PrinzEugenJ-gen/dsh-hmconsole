import test from 'node:test'
import assert from 'node:assert/strict'

const T0 = 1792445116400

function mockCtx(ctl, sessions) {
  const routes = {}
  const conn = { fetch: { register: (route) => { routes[route.path] = route; return () => {} } } }
  const ctx = {
    get: (n) => (n === 'connection' ? conn : n === 'sessionController' ? ctl : n === 'sessions' ? sessions : null),
    on: () => () => {},
    effect: () => () => {}
  }
  return { ctx, routes }
}

async function detail(pageEvents, logEvents) {
  const ctl = {
    projections: async () => ({ asOfSeq: 99, values: { title: 't', turnOutline: [] } }),
    page: async () => ({ records: pageEvents.map((e) => ({ type: 'event', event: e })) }),
    list: async () => ({ items: [] })
  }
  const sessions = { get: (sid) => (sid === 's-imp' ? { log: logEvents } : null) }
  const { ctx, routes } = mockCtx(ctl, sessions)
  const { apply } = await import('../index.js?t=' + Math.random())
  apply(ctx, { port: 0 })
  const r = await routes['/api/dsh-hmconsole/cmd'].fetch(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ op: 'detail', payload: { sessionId: 's-imp' } })
  }))
  return (await r.json()).result
}

function importedLog(userText, opts = {}) {
  return [
    { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: T0, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 3, time: T0, data: { turn: 1, step: 1,
      message: { role: 'system', content: [], source: { kind: 'system-prompt' } } } },
    { type: 'user/message', seq: 4, time: T0, data: { turn: 1, step: 1,
      content: [{ type: 'text', text: userText }],
      source: opts.userSource || { kind: 'user' } } },
    { type: 'assistant/message', seq: 5, time: T0 + 1000, data: { turn: 1, step: 1, stream: [],
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '用 fs 读。' }],
        source: opts.assistantSource || { kind: 'model', provider: 'deepseek-chat-export', model: 'deepseek-chat-export' } } } },
    { type: 'step/end', seq: 6, time: T0 + 1100, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: T0 + 1200, data: { turn: 1, reason: { kind: 'completed' } } }
  ]
}

test('① 导入会话的提问要能进 turns（手机端才画得出用户气泡）', async () => {
  const d = await detail(importedLog('请问鸿蒙怎么读文件'), importedLog('请问鸿蒙怎么读文件'))
  assert.equal(d.turns.length, 1)
  assert.equal(d.turns[0].prompt, '请问鸿蒙怎么读文件', '导入会话的提问原文要下发')
  assert.deepEqual(d.turns[0].prompts, ['请问鸿蒙怎么读文件'], 'prompts[] 也要有，App 优先用它')
  assert.equal(d.turns[0].response, '用 fs 读。', '回复照旧')
})

test('② 导入会话被用户接着用：新轮里的注入仍要挡掉', async () => {
  const injected = importedLog('导入时的提问')
  injected.push(
    { type: 'turn/start', seq: 8, time: T0 + 2000, data: { turn: 2 } },
    { type: 'user/message', seq: 9, time: T0 + 2001, data: { turn: 2, step: 1,
      content: [{ type: 'text', text: 'Plan mode on. Use /plan off to leave.' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 10, time: T0 + 2002, data: { turn: 2, step: 1,
      content: [{ type: 'text', text: '接着问一句' }], source: { kind: 'user', rpcId: 'r-2' } } },
    { type: 'assistant/message', seq: 11, time: T0 + 3000, data: { turn: 2, step: 1, stream: [],
      message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '好。' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } } } },
    { type: 'turn/end', seq: 12, time: T0 + 3100, data: { turn: 2, reason: { kind: 'completed' } } }
  )
  const d = await detail(injected, injected)
  const t2 = d.turns.find((t) => t.turn === 2)
  assert.ok(t2, '第 2 轮要在')
  assert.deepEqual(t2.prompts, ['接着问一句'], '真提问保留、注入丢弃')
})

test('③ 不是导入的会话：无 rpcId 的 user 仍按注入处理（不回归）', async () => {
  const plain = importedLog('子智能体派活那类', {
    userSource: { kind: 'user' },
    assistantSource: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }
  })
  const d = await detail(plain, plain)
  assert.equal(d.turns.length, 1)
  assert.equal(d.turns[0].prompt, '', '普通会话里无 rpcId 的 user 依旧不当作真人提问')
  assert.equal(d.turns[0].response, '用 fs 读。')
})

test('④ 导入会话里带 rpcId 的真人提问照旧显示（两条口径不打架）', async () => {
  const log = importedLog('接着问一句', { userSource: { kind: 'user', rpcId: 'r-1' } })
  const d = await detail(log, log)
  assert.equal(d.turns[0].prompt, '接着问一句')
})

test('⑤ 导入会话的提问也要出现在 trace（轨迹栏）里', async () => {
  process.env.DSH_HMCONSOLE_DETAIL_TRACE = '1'
  const log = importedLog('导入的提问')
  const d = await detail(log, log)
  const users = (d.trace || []).filter((e) => e.kind === 'user')
  assert.equal(users.length, 1, 'trace 里要有一条 user')
  assert.equal(users[0].text, '导入的提问')
  delete process.env.DSH_HMCONSOLE_DETAIL_TRACE
})
