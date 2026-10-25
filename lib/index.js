/**
 * dsh-soul —— 跨会话记忆、人格养成与关系分寸。
 *
 * 两条核心取舍：
 *
 * 1. **一次读全，之后静默。** 记忆在会话开始时注入一次，之后不再逐轮追加。
 *    逐轮注入会随会话变长而线性膨胀，并且每轮都在变动处打断前缀缓存。
 *
 * 2. **注入进系统提示，不进聊天记录。** 会话层没有「自定义消息类型」的扩展点，
 *    往消息列表里塞一条记忆，就会在聊天里显示成一个巨大的用户气泡。
 *    改为注册一条 per-agent 的系统提示段：用户看不见，模型看得见，
 *    而且它天然是前缀的一部分，缓存友好。
 */

import { randomUUID } from 'node:crypto'

import { Config, resolveConfig } from './config.js'
import { renderMemoryBlock } from './render.js'
import { SoulStore, scopeOf } from './store.js'
import { registerTools } from './tools.js'

export { Config }

export const name = 'dsh-soul'

/**
 * Cordis 要求把用到的服务显式声明出来，否则访问 ctx.tools 会被直接拦下。
 */
export const inject = ['tools']

/** 系统提示里的段名与排序。130 落在工具约定之后、运行时上下文之前。 */
const SECTION_NAME = 'soul:memory'
const SECTION_ORDER = 130

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

  // 让宿主为这个插件生成自动配置页（Config schema → 设置表单）。
  // 没有 settings 服务的宿主（比如纯 headless）就跳过，不影响其余功能。
  try {
    const settings = ctx.get?.('settings')
    if (settings && typeof settings.configure === 'function') {
      ctx.effect(() => settings.configure({ auto: true }))
    }
  } catch (error) {
    log('warn', `设置页注册失败：${errorText(error)}`)
  }

  // 落盘由 store 自己排程：任何一次写都会 markDirty，这里只负责卸载时兜底。
  ctx.effect(() => () => void store.dispose())

  /** 已经以「消息」形式注入过记忆的会话（仅 fallback 路径使用）。 */
  const injectedMessages = new Set()
  /** 已经注册了系统提示段的会话 → 段的 disposer。 */
  const sections = new Map()

  // -- 主路径：per-agent 系统提示段 -----------------------------------------

  ctx.on('agent/created', function onAgentCreated(payload) {
    if (cfg.injectMode === 'message') return

    try {
      const agent = payload?.agent
      const header = agent?.session?.header
      if (!header || typeof header.id !== 'string') return
      if (cfg.skipSubagents && header.origin === 'subagent') return
      if (sections.has(header.id)) return

      // `this` 是本事件的 Scoped<Agent>，它的 ctx 就是该 agent 的作用域。
      const agentCtx = this?.ctx ?? agent?.ctx
      const prompt = agentCtx?.systemPrompt
      if (!prompt || typeof prompt.section !== 'function') return

      // 在会话开始时算一次就冻结——画像中途变脸既伤缓存，也不像话。
      const block = buildBlock(store, cfg, header.id)
      if (block === '') return

      const dispose = prompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => block,
      })

      sections.set(header.id, { dispose, block })
      log('info', `会话 ${header.id} 的系统提示已注入记忆（${block.length} 字）`)
    } catch (error) {
      log('warn', `系统提示注入失败，将退回消息注入：${errorText(error)}`)
    }
  })

  // -- 退路：作为一条消息插在提问前（旧行为） -------------------------------

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (cfg.injectMode === 'system') return decision

    try {
      const sessionId = payload?.agent?.session?.header?.id
      // 系统提示段已经生效的会话不再插入消息，否则同一份记忆会出现两遍。
      if (typeof sessionId === 'string' && sections.has(sessionId)) return decision
      return injectAsMessage({ store, cfg, injectedMessages, payload, decision })
    } catch (error) {
      // 记忆坏了绝不能挡住对话：安全放行。
      log('warn', `注入失败，已放行：${errorText(error)}`)
      return decision
    }
  })

  // -- 观察：记下「最近说了什么」，供下次会话交接 ---------------------------

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.header?.id
      if (typeof sessionId !== 'string' || !event) return

      if (event.type === 'compaction/end') {
        // 压缩会重建上下文，解除标记以便重新注入。
        injectedMessages.delete(sessionId)
        return
      }

      if (event.type !== 'user/message') return
      if (event.data?.source?.kind !== 'user') return

      const text = messageText(event.data)
      if (text === '') return

      store.noteSession({ sessionId, cwd: session.header?.cwd, userText: text })
    } catch {
      /* 观察失败静默 */
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.header?.id
    if (typeof sessionId !== 'string') return
    injectedMessages.delete(sessionId)

    const entry = sections.get(sessionId)
    sections.delete(sessionId)
    if (entry) {
      try {
        entry.dispose()
      } catch {
        /* 卸载期的清理失败不值得让宿主报错 */
      }
    }
  })
}

// ---------------------------------------------------------------------------

function buildBlock(store, cfg, sessionId) {
  return renderMemoryBlock({
    profile: store.profile,
    handoff: store.latestHandoff(sessionId),
    recent: store.recentCards(cfg.recentCards),
    profileBudget: cfg.profileBudget,
    handoffBudget: cfg.handoffBudget,
    recentBudget: cfg.recentBudget,
  })
}

function injectAsMessage({ store, cfg, injectedMessages, payload, decision }) {
  if (!decision || (decision.kind !== undefined && decision.kind !== 'enter')) return decision

  const messages = decision.messages
  if (!Array.isArray(messages) || messages.length === 0) return decision

  const header = payload?.agent?.session?.header
  if (!header || typeof header.id !== 'string') return decision
  if (cfg.skipSubagents && header.origin === 'subagent') return decision
  if (injectedMessages.has(header.id)) return decision

  let index = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      index = i
      break
    }
  }
  if (index < 0) return decision

  const block = buildBlock(store, cfg, header.id)
  if (block === '') return decision

  const rewritten = [...messages]
  rewritten.splice(index, 0, soulMessage(block))
  injectedMessages.add(header.id)

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

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export { scopeOf }
