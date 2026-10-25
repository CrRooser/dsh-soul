import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { approxTokens, redact, similarity, tokenize, truncate } from '../lib/text.js'
import { SoulStore, scopeOf } from '../lib/store.js'
import { renderMemoryBlock, renderProfile } from '../lib/render.js'

const dirs = []
async function tempStore(options) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-soul-'))
  dirs.push(dir)
  return new SoulStore(dir, options)
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

// -- text -------------------------------------------------------------------

test('分词：英文取词，中文取二元组', () => {
  const tokens = tokenize('部署 deploy.ps1 到服务器')
  assert.ok(tokens.has('deploy'))
  assert.ok(tokens.has('部署'))
  assert.ok(tokens.has('署到'))
  assert.ok(tokens.has('服务'))
  assert.ok(!tokens.has('部署服务'), '中文只取二元组，不取整词')
})

test('相似度：相同文本为 1，无关文本接近 0', () => {
  assert.equal(similarity('部署脚本放在 scripts 下', '部署脚本放在 scripts 下'), 1)
  assert.ok(similarity('部署脚本放在 scripts 下', '明天的天气怎么样') < 0.1)
})

test('token 估算对中文比对英文更贵', () => {
  const cjk = approxTokens('中文中文中文中文中文中文')
  const ascii = approxTokens('abcdefghijkl')
  assert.ok(cjk > ascii, `cjk=${cjk} ascii=${ascii}`)
})

test('脱敏：密钥与显式密码都要挡住', () => {
  const hit = redact('我的 key 是 sk-abcdefghijklmnopqrstuvwx 别外传')
  assert.equal(hit.hit, true)
  assert.ok(!hit.text.includes('sk-abcdefghijklmnopqrstuvwx'))

  const pwd = redact('密码：hunter2')
  assert.equal(pwd.hit, true)

  const clean = redact('今天风很大')
  assert.equal(clean.hit, false)
  assert.equal(clean.text, '今天风很大')
})

test('truncate 保留上限长度', () => {
  assert.equal(truncate('abcdef', 3).length, 3)
  assert.equal(truncate('abc', 10), 'abc')
})

// -- store ------------------------------------------------------------------

test('写入：同一件事写两遍会合并，而不是长出两张卡', async () => {
  const store = await tempStore()
  await store.load()

  const first = store.addCard({ text: '部署脚本放在 scripts/deploy.ps1', kind: 'fact' })
  const second = store.addCard({ text: '部署脚本放在 scripts/deploy.ps1', kind: 'fact' })

  assert.equal(first.merged, false)
  assert.equal(second.merged, true)
  assert.equal(second.card.id, first.card.id)
  assert.equal(store.activeCards().length, 1)
  assert.ok(second.card.weight > 1)
})

test('召回：关键词命中，并记录命中次数', async () => {
  const store = await tempStore()
  await store.load()

  store.addCard({ text: '插件数据存在 ~/.dsh/storages/soul 下', kind: 'fact' })
  store.addCard({ text: '他习惯用中文交流', kind: 'user' })

  const hits = store.recall('数据存在哪个目录', { limit: 3 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].hits, 1)
  assert.ok(hits[0].text.includes('storages/soul'))
})

test('召回：kind 过滤生效', async () => {
  const store = await tempStore()
  await store.load()

  store.addCard({ text: '偏好中文', kind: 'user' })
  store.addCard({ text: '偏好把结论写在前面', kind: 'rule' })

  const onlyUser = store.recall('偏好', { kind: 'user' })
  assert.equal(onlyUser.length, 1)
  assert.equal(onlyUser[0].kind, 'user')
})

test('作用域：别的项目的事实不该串进来', async () => {
  const store = await tempStore()
  await store.load()

  store.addCard({ text: '部署脚本在 scripts 下', kind: 'fact', scope: scopeOf('D:/proj-a') })

  const other = store.recall('部署脚本', { scope: scopeOf('D:/proj-b') })
  assert.equal(other.length, 0)

  const same = store.recall('部署脚本', { scope: scopeOf('D:/proj-a') })
  assert.equal(same.length, 1)
})

test('退役：forget 之后不再参与召回', async () => {
  const store = await tempStore()
  await store.load()

  const { card } = store.addCard({ text: '这条要被忘掉', kind: 'fact' })
  assert.equal(store.forget(card.id), true)
  assert.equal(store.recall('要被忘掉', {}).length, 0)
  assert.equal(store.forget('c_不存在'), false)
})

test('持久化：写盘后重新加载，卡片与画像都在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-soul-'))
  dirs.push(dir)

  const store = new SoulStore(dir)
  await store.load()
  store.addCard({ text: '持久化测试条目', kind: 'fact', tags: ['测试'] })
  store.setSection('who', '他是 CrRooser。')
  await store.flush()

  const reloaded = new SoulStore(dir)
  await reloaded.load()

  assert.equal(reloaded.activeCards().length, 1)
  assert.equal(reloaded.getSection('who'), '他是 CrRooser。')
  assert.equal(reloaded.cards[0].tags[0], '测试')
})

test('写入后不需要显式 flush：存储层自己会落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-soul-'))
  dirs.push(dir)

  const store = new SoulStore(dir)
  await store.load()
  store.addCard({ text: '自动落盘测试条目', kind: 'fact' })
  store.setSection('who', '自动落盘')

  // 故意不调用 flush()，等 markDirty 的防抖窗口过去
  await new Promise((resolve) => setTimeout(resolve, 1400))

  const reloaded = new SoulStore(dir)
  await reloaded.load()
  assert.equal(reloaded.activeCards().length, 1, '卡片应该自己落盘')
  assert.equal(reloaded.getSection('who'), '自动落盘', '画像应该自己落盘')
})

test('损坏的文件不会让加载失败，而是被备份后重来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-soul-'))
  dirs.push(dir)
  await writeFile(join(dir, 'cards.json'), '{ 这不是 JSON', 'utf8')

  const store = new SoulStore(dir)
  await store.load()
  assert.equal(store.cards.length, 0)
})

test('交接：取最近一次别的会话，不取自己', async () => {
  const store = await tempStore()
  await store.load()

  store.noteSession({ sessionId: 's1', cwd: 'D:/a', userText: '先写存储层' })
  const earlier = store.state.sessions.s1.updatedAt
  store.state.sessions.s1.updatedAt = earlier - 1000

  store.noteSession({ sessionId: 's2', cwd: 'D:/a', userText: '然后是注入层' })

  const handoff = store.latestHandoff('s2')
  assert.equal(handoff.sessionId, 's1')
  assert.deepEqual(store.latestHandoff('s1').sessionId, 's2')
})

test('容量：超过上限会淘汰，不会无限增长', async () => {
  const store = await tempStore({ maxCards: 5 })
  await store.load()

  for (let i = 0; i < 12; i += 1) {
    store.addCard({ text: `note-${randomUUID()}`, kind: 'fact' })
  }
  assert.equal(store.cards.length, 5)
})

// -- render -----------------------------------------------------------------

test('渲染：同一份画像两次输出逐字节相同（缓存友好）', async () => {
  const store = await tempStore()
  await store.load()
  store.setSection('who', '他是 CrRooser，说中文。')
  store.setSection('conduct', '先给结论，再给理由。')

  const first = renderProfile(store.profile, 1400)
  const second = renderProfile(store.profile, 1400)
  assert.equal(first, second)
  assert.ok(first.includes('关于他'))
})

test('渲染：单段超预算会被截断到上限', async () => {
  const store = await tempStore()
  await store.load()
  store.setSection('context', '长'.repeat(5000))

  const text = renderProfile(store.profile, 1400)
  assert.ok(text.length < 1600, `实际长度 ${text.length}`)
})

test('渲染：空记忆不产生注入块', () => {
  const block = renderMemoryBlock({
    profile: { sections: { who: '', context: '', conduct: '', rapport: '' } },
    handoff: null,
    profileBudget: 1400,
    handoffBudget: 320,
  })
  assert.equal(block, '')
})

test('渲染：有画像也有交接时，两块都在', async () => {
  const store = await tempStore()
  await store.load()
  store.setSection('who', '他是 CrRooser。')
  store.noteSession({ sessionId: 's1', cwd: 'D:/a', userText: '把插件写出来' })

  const block = renderMemoryBlock({
    profile: store.profile,
    handoff: store.latestHandoff('s2'),
    profileBudget: 1400,
    handoffBudget: 320,
  })

  assert.ok(block.includes('关于他'))
  assert.ok(block.includes('上次会话接手'))
  assert.ok(block.includes('把插件写出来'))
  assert.ok(approxTokens(block) < 900, `实际约 ${approxTokens(block)} token`)
})
