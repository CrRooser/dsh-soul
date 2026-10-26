import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildHistoryDigest } from '../lib/bootstrap.js'

function userEvent(text) {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
}

function fakeCorpus(sessions) {
  return {
    async listSessions() {
      return sessions.map((s) => ({ header: s.header, live: false, persisted: true }))
    },
    async readSession(id) {
      const found = sessions.find((s) => s.header.id === id)
      if (!found) throw new Error('missing')
      return { session: found.header, inheritedEventCount: 0, events: found.events }
    },
  }
}

function session(id, createdAt, texts, extra = {}) {
  return {
    header: { id, cwd: 'D:/work/proj', createdAt, ...extra },
    events: texts.map(userEvent),
  }
}

test('整理：只收真实用户发言，按时间倒序', async () => {
  const corpus = fakeCorpus([
    session('s1', 1000, ['先写存储层', '然后写注入']),
    session('s2', 2000, ['今天做设置页']),
  ])

  const { text, entries } = await buildHistoryDigest({ sessionQuery: corpus })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].id, 's2', '最新的排前面')
  assert.ok(text.indexOf('今天做设置页') < text.indexOf('然后写注入') || text.includes('今天做设置页'))
  assert.ok(text.includes('2 轮'))
})

test('整理：排除名单里的会话不读不记', async () => {
  const corpus = fakeCorpus([
    session('keep', 1000, ['可以记的']),
    session('secret', 2000, ['不该记的']),
  ])

  const { text, entries } = await buildHistoryDigest({ sessionQuery: corpus, exclude: ['secret'] })
  assert.deepEqual(entries.map((e) => e.id), ['keep'])
  assert.ok(!text.includes('不该记的'))
})

test('整理：子会话与无发言的会话被跳过', async () => {
  const corpus = fakeCorpus([
    session('root', 1000, ['正常会话']),
    session('sub', 2000, ['子代理的话'], { origin: 'subagent' }),
    session('empty', 3000, []),
  ])

  const { entries } = await buildHistoryDigest({ sessionQuery: corpus })
  assert.deepEqual(entries.map((e) => e.id), ['root'])
})

test('整理：读不出来的会话跳过，不中断整体', async () => {
  const corpus = fakeCorpus([session('ok', 1000, ['能读']), session('bad', 2000, ['读不到'])])
  const broken = {
    listSessions: corpus.listSessions,
    async readSession(id) {
      if (id === 'bad') throw new Error('boom')
      return corpus.readSession(id)
    },
  }

  const { entries } = await buildHistoryDigest({ sessionQuery: broken })
  assert.deepEqual(entries.map((e) => e.id), ['ok'])
})

test('整理：没有会话时返回空摘要', async () => {
  const { text, entries } = await buildHistoryDigest({ sessionQuery: fakeCorpus([]) })
  assert.equal(text, '')
  assert.deepEqual(entries, [])
})

test('整理：缺少 sessionQuery 时明确报错', async () => {
  await assert.rejects(() => buildHistoryDigest({ sessionQuery: undefined }), /sessionQuery/)
})
