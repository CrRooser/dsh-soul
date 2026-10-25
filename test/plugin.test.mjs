/**
 * 集成测试：不用真的 DSH，用一个假宿主把插件完整加载一遍。
 *
 * 这能抓到单元测试抓不到的东西——注册路径写错、钩子签名不对、
 * 注入的消息结构不对，都会在这里炸出来。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply, name } from '../lib/index.js'
import { SoulStore } from '../lib/store.js'

const dirs = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

/** 落盘有 1.5s 防抖，测试里等它跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1700))

/** 最小假宿主：只实现插件真正用到的那几个接口。 */
function fakeHost() {
  const handlers = new Map()
  const tools = new Map()

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
  }

  return {
    ctx,
    tools,
    async emit(event, ...args) {
      let result
      for (const handler of handlers.get(event) || []) result = await handler(...args)
      return result
    },
  }
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function sessionOf(id, cwd = 'D:/proj') {
  return { header: { id, cwd } }
}

const enter = (messages) => async () => ({ kind: 'enter', messages })

async function newDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-soul-boot-'))
  dirs.push(dir)
  return dir
}

async function booted(config = {}) {
  const dir = config.dataDir || (await newDir())
  const host = fakeHost()
  await apply(host.ctx, { dataDir: dir, ...config })
  return { host, dir }
}

test('插件导出 name 与 apply', () => {
  assert.equal(name, 'dsh-soul')
  assert.equal(typeof apply, 'function')
})

test('装载后五个工具都在', async () => {
  const { host } = await booted()
  assert.deepEqual([...host.tools.keys()].sort(), [
    'soul_diag',
    'soul_forget',
    'soul_profile',
    'soul_recall',
    'soul_remember',
    'soul_shape',
  ])
})

test('首轮注入记忆块，同一个会话只注入一次', async () => {
  const dir = await newDir()

  // 第一次装载：写入记忆与画像
  const writer = await booted({ dataDir: dir })
  const exec = { agent: { session: sessionOf('s1') } }
  await writer.host.tools.get('soul_remember').execute(
    { text: '部署脚本在 scripts 下', kind: 'fact' },
    exec,
  )
  await writer.host.tools.get('soul_shape').execute(
    { section: 'who', text: '他是 CrRooser，说中文。' },
    exec,
  )
  await writer.host.emit('agent/disposed', { agent: { session: sessionOf('s1') } })
  await settle()

  // 第二次装载：模拟新会话读到上次的数据
  const reader = await booted({ dataDir: dir })
  const payload = { agent: { session: sessionOf('s2') }, signal: { aborted: false } }

  const first = await reader.host.emit('agent/pre-step', payload, enter([userMessage('继续')]))
  assert.equal(first.messages.length, 2, '应该多出一条记忆消息')

  const injected = first.messages[0]
  assert.equal(injected.role, 'user')
  assert.ok(injected.content[0].text.includes('CrRooser'), '画像要进来')
  assert.ok(injected.content[0].text.includes('scripts'), '卡片要进来')
  assert.ok(Object.isFrozen(injected), '注入的消息必须冻结')

  const second = await reader.host.emit('agent/pre-step', payload, enter([userMessage('再问一句')]))
  assert.equal(second.messages.length, 1, '同一个会话只注入一次')
})

test('空记忆时不注入任何东西', async () => {
  const { host } = await booted()
  const decision = await host.emit(
    'agent/pre-step',
    { agent: { session: sessionOf('s3') }, signal: { aborted: false } },
    enter([userMessage('你好')]),
  )
  assert.equal(decision.messages.length, 1)
})

test('子会话不继承人格', async () => {
  const dir = await newDir()
  const writer = await booted({ dataDir: dir })
  await writer.host.tools
    .get('soul_shape')
    .execute({ section: 'who', text: '他是 CrRooser。' }, { agent: { session: sessionOf('s1') } })
  await writer.host.emit('agent/disposed', { agent: { session: sessionOf('s1') } })
  await settle()

  const reader = await booted({ dataDir: dir })
  const sub = { header: { id: 's4', cwd: 'D:/proj', origin: 'subagent' } }
  const decision = await reader.host.emit(
    'agent/pre-step',
    { agent: { session: sub }, signal: { aborted: false } },
    enter([userMessage('干活')]),
  )
  assert.equal(decision.messages.length, 1)
})

test('用户发言落盘后，下个会话能拿到交接卡', async () => {
  const dir = await newDir()

  const writer = await booted({ dataDir: dir })
  await writer.host.emit('session/event', sessionOf('s5'), {
    type: 'user/message',
    data: userMessage('把插件写出来'),
  })
  await settle()

  const onDisk = new SoulStore(dir)
  await onDisk.load()
  assert.deepEqual(onDisk.state.sessions.s5.lastUser, ['把插件写出来'])

  const reader = await booted({ dataDir: dir })
  const decision = await reader.host.emit(
    'agent/pre-step',
    { agent: { session: sessionOf('s6') }, signal: { aborted: false } },
    enter([userMessage('接着干')]),
  )
  assert.equal(decision.messages.length, 2)
  assert.ok(decision.messages[0].content[0].text.includes('上次会话接手'))
  assert.ok(decision.messages[0].content[0].text.includes('把插件写出来'))
})

test('压缩结束后会重新注入', async () => {
  const dir = await newDir()
  const writer = await booted({ dataDir: dir })
  await writer.host.tools
    .get('soul_shape')
    .execute({ section: 'who', text: '他是 CrRooser。' }, { agent: { session: sessionOf('s1') } })
  await writer.host.emit('agent/disposed', { agent: { session: sessionOf('s1') } })
  await settle()

  const reader = await booted({ dataDir: dir })
  const payload = { agent: { session: sessionOf('s9') }, signal: { aborted: false } }

  const first = await reader.host.emit('agent/pre-step', payload, enter([userMessage('一')]))
  assert.equal(first.messages.length, 2)

  await reader.host.emit('session/event', sessionOf('s9'), { type: 'compaction/end', data: {} })

  const again = await reader.host.emit('agent/pre-step', payload, enter([userMessage('二')]))
  assert.equal(again.messages.length, 2, '压缩把记忆挤掉了，应该重新注入')
})

test('soul_forget 之后召回不到', async () => {
  const { host } = await booted()
  const exec = { agent: { session: sessionOf('s7') } }

  const saved = await host.tools.get('soul_remember').execute({ text: '关于天气的笔记', kind: 'fact' }, exec)
  assert.equal((await host.tools.get('soul_recall').execute({ query: '天气' }, exec)).count, 1)

  await host.tools.get('soul_forget').execute({ id: saved.id }, exec)
  assert.equal((await host.tools.get('soul_recall').execute({ query: '天气' }, exec)).count, 0)
})

test('soul_remember 挡住疑似密钥', async () => {
  const { host } = await booted()
  const exec = { agent: { session: sessionOf('s8') } }

  const result = await host.tools.get('soul_remember').execute(
    { text: '他的 token 是 sk-abcdefghijklmnopqrstuvwx' },
    exec,
  )
  assert.equal(result.redacted, true)

  const recalled = await host.tools.get('soul_recall').execute({ query: 'token' }, exec)
  assert.ok(!JSON.stringify(recalled).includes('sk-abcdefghijklmnopqrstuvwx'))
})

test('enabled=false 时插件什么都不注册', async () => {
  const host = fakeHost()
  await apply(host.ctx, { dataDir: await newDir(), enabled: false })
  assert.equal(host.tools.size, 0, '关闭后不该注册任何工具')
})

// -- 系统提示注入（主路径）---------------------------------------------------

/** 假的 per-agent systemPrompt 服务，只记下注册的段。 */
function promptRecorder() {
  const sections = []
  return {
    sections,
    section(definition) {
      sections.push(definition)
      return () => {
        const index = sections.indexOf(definition)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  }
}

test('记忆进系统提示，不进聊天记录', async () => {
  const dir = await newDir()

  const writer = await booted({ dataDir: dir })
  await writer.host.tools
    .get('soul_shape')
    .execute({ section: 'who', text: '他是 CrRooser，说中文。' }, { agent: { session: sessionOf('s1') } })
  await settle()

  const reader = await booted({ dataDir: dir })
  const prompt = promptRecorder()
  const agent = { session: sessionOf('s12'), ctx: { systemPrompt: prompt } }

  await reader.host.emit('agent/created', { agent })

  assert.equal(prompt.sections.length, 1, '应该注册一条系统提示段')
  const section = prompt.sections[0]
  assert.equal(section.name, 'soul:memory')
  assert.equal(typeof section.text, 'function')
  assert.ok(section.text().includes('CrRooser'), '段内容要带上画像')

  // 同一份记忆不能既进系统提示、又作为消息插进聊天
  const decision = await reader.host.emit(
    'agent/pre-step',
    { agent, signal: { aborted: false } },
    enter([userMessage('继续')]),
  )
  assert.equal(decision.messages.length, 1, '聊天记录里不该出现记忆气泡')
})

test('段内容在会话内是冻结的', async () => {
  const dir = await newDir()

  const writer = await booted({ dataDir: dir })
  const exec = { agent: { session: sessionOf('s1') } }
  await writer.host.tools.get('soul_shape').execute({ section: 'who', text: '第一版画像' }, exec)
  await settle()

  const reader = await booted({ dataDir: dir })
  const prompt = promptRecorder()
  const agent = { session: sessionOf('s13'), ctx: { systemPrompt: prompt } }
  await reader.host.emit('agent/created', { agent })

  const before = prompt.sections[0].text()

  // 会话中途改画像：本会话的系统提示不该跟着变，否则前缀缓存全废
  await reader.host.tools.get('soul_shape').execute({ section: 'who', text: '第二版画像' }, exec)

  assert.equal(prompt.sections[0].text(), before)
  assert.ok(before.includes('第一版画像'))
})

test('会话销毁时摘掉系统提示段', async () => {
  const dir = await newDir()

  const writer = await booted({ dataDir: dir })
  await writer.host.tools
    .get('soul_shape')
    .execute({ section: 'who', text: '他是 CrRooser。' }, { agent: { session: sessionOf('s1') } })
  await settle()

  const reader = await booted({ dataDir: dir })
  const prompt = promptRecorder()
  const agent = { session: sessionOf('s14'), ctx: { systemPrompt: prompt } }
  await reader.host.emit('agent/created', { agent })
  assert.equal(prompt.sections.length, 1)

  await reader.host.emit('agent/disposed', { agent })
  assert.equal(prompt.sections.length, 0, '段应该随会话卸载而摘掉')
})

test('injectMode=message 时走消息注入', async () => {
  const dir = await newDir()

  const writer = await booted({ dataDir: dir })
  await writer.host.tools
    .get('soul_shape')
    .execute({ section: 'who', text: '他是 CrRooser。' }, { agent: { session: sessionOf('s1') } })
  await settle()

  const reader = await booted({ dataDir: dir, injectMode: 'message' })
  const prompt = promptRecorder()
  const agent = { session: sessionOf('s15'), ctx: { systemPrompt: prompt } }

  await reader.host.emit('agent/created', { agent })
  assert.equal(prompt.sections.length, 0, 'message 模式不该注册系统提示段')

  const decision = await reader.host.emit(
    'agent/pre-step',
    { agent, signal: { aborted: false } },
    enter([userMessage('你好')]),
  )
  assert.equal(decision.messages.length, 2, '应该退回消息注入')
})

test('历史里已有记忆块的会话不再注入（宿主重启后不重复）', async () => {
  const dir = await newDir()

  const writer = await booted({ dataDir: dir })
  await writer.host.tools
    .get('soul_shape')
    .execute({ section: 'who', text: '他是 CrRooser。' }, { agent: { session: sessionOf('s1') } })
  await settle()

  const reader = await booted({ dataDir: dir })
  const prompt = promptRecorder()

  // 模拟重启后恢复的老会话：日志里已经躺着上一轮注入的那块
  const agent = {
    ctx: { systemPrompt: prompt },
    session: {
      header: { id: 's16', cwd: 'D:/proj' },
      ownEvents: () => ([{
        type: 'user/message',
        data: userMessage('【长期记忆 · dsh-soul】\n## 关于他\n旧内容'),
      }]),
    },
  }

  await reader.host.emit('agent/created', { agent })
  assert.equal(prompt.sections.length, 0, '历史里已有那块，不该再注册系统提示段')

  const decision = await reader.host.emit(
    'agent/pre-step',
    { agent, signal: { aborted: false } },
    enter([userMessage('继续')]),
  )
  assert.equal(decision.messages.length, 1, '聊天记录里不该再冒出第二块')
})

test('没有标记的老会话照常注入', async () => {
  const dir = await newDir()

  const writer = await booted({ dataDir: dir })
  await writer.host.tools
    .get('soul_shape')
    .execute({ section: 'who', text: '他是 CrRooser。' }, { agent: { session: sessionOf('s1') } })
  await settle()

  const reader = await booted({ dataDir: dir })
  const agent = {
    session: {
      header: { id: 's17', cwd: 'D:/proj' },
      ownEvents: () => ([{ type: 'user/message', data: userMessage('普通的一句话') }]),
    },
  }

  const decision = await reader.host.emit(
    'agent/pre-step',
    { agent, signal: { aborted: false } },
    enter([userMessage('继续')]),
  )
  assert.equal(decision.messages.length, 2)
})
