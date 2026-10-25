/**
 * dsh-soul —— 跨会话记忆、人格养成与关系分寸。
 *
 * 核心取舍写在 README 里，这里只重复一句坐标：
 * **一次读全，之后静默。** 记忆在新会话的第一轮注入一次，之后不再逐轮追加。
 * 逐轮注入看起来更聪明，实际上会随着会话变长而线性膨胀，并且每轮都在
 * 变动处打断前缀缓存——那是这个领域最贵的错误。
 */

import { randomUUID } from 'node:crypto'

import { resolveConfig } from './config.js'
import { renderMemoryBlock } from './render.js'
import { SoulStore, scopeOf } from './store.js'
import { registerTools } from './tools.js'

export const name = 'dsh-soul'

export async function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  const store = new SoulStore(cfg.dataDir, {
    maxCards: cfg.maxCards,
    dedupeThreshold: cfg.dedupeThreshold,
  })
  await store.load()

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`dsh-soul: ${message}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  log('info', `已加载，数据目录 ${store.dir}，卡片 ${store.activeCards().length} 条`)

  const disposeTools = registerTools(ctx, store, cfg)
  ctx.effect(() => disposeTools)

  /** 已经注入过记忆的会话。压缩后会被清掉，以便重新注入。 */
  const injected = new Set()

  let flushTimer = null
  const scheduleFlush = () => {
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void store.flush()
    }, 1500)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  ctx.effect(() => () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    void store.flush()
  })

  // -- 注入：每个会话只在第一轮做一次 ---------------------------------------

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!cfg.inject) return decision
    try {
      return injectMemory({ store, cfg, injected, payload, decision })
    } catch (error) {
      // 记忆坏了绝不能挡住对话：安全放行。
      log('warn', `注入失败，已放行：${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  // -- 观察：记下「最近说了什么」，供下次会话交接 ---------------------------

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.header?.id
      if (typeof sessionId !== 'string' || !event) return

      if (event.type === 'compaction/end') {
        // 压缩会把注入块挤出上下文，解除标记以便下一轮重新注入。
        injected.delete(sessionId)
        return
      }

      if (event.type !== 'user/message') return
      if (event.data?.source?.kind !== 'user') return

      const text = messageText(event.data)
      if (text === '') return

      store.noteSession({ sessionId, cwd: session.header?.cwd, userText: text })
      scheduleFlush()
    } catch {
      /* 观察失败静默 */
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.header?.id
    if (typeof sessionId === 'string') injected.delete(sessionId)
    scheduleFlush()
  })
}

// ---------------------------------------------------------------------------

function injectMemory({ store, cfg, injected, payload, decision }) {
  if (!decision || (decision.kind !== undefined && decision.kind !== 'enter')) return decision

  const messages = decision.messages
  if (!Array.isArray(messages) || messages.length === 0) return decision

  const header = payload?.agent?.session?.header
  if (!header || typeof header.id !== 'string') return decision
  if (cfg.skipSubagents && header.origin === 'subagent') return decision
  if (injected.has(header.id)) return decision

  let index = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      index = i
      break
    }
  }
  if (index < 0) return decision

  const block = renderMemoryBlock({
    profile: store.profile,
    handoff: store.latestHandoff(header.id),
    profileBudget: cfg.profileBudget,
    handoffBudget: cfg.handoffBudget,
  })
  if (block === '') return decision

  const rewritten = [...messages]
  rewritten.splice(index, 0, soulMessage(block))
  injected.add(header.id)

  return { ...decision, messages: rewritten }
}

function soulMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', plugin: 'dsh-soul' },
  })
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export { scopeOf }
