/**
 * 渲染层：把结构化记忆变成一段**稳定、可缓存**的文本。
 *
 * 两条硬约束：
 *   1. 同一个会话内，这段文本必须逐字节稳定——否则前缀缓存全废。
 *      所以这里绝不出现时间戳、计数器、随机数。
 *   2. 总量恒定。每段有硬上限，超了按优先级截断，而不是「这次先多写点」。
 */

import { relativeTime, truncate } from './text.js'

/**
 * 记忆块的固定开头。
 *
 * 它同时是一个**幂等标记**：注入前先在会话历史里找这一行，找到就不再注入。
 * 没有它，宿主重启后老会话会被再注入一遍，聊天记录里就会堆出第二块。
 */
export const MEMORY_MARKER = '【长期记忆 · dsh-soul】'

export const SECTION_TITLES = Object.freeze({
  who: '关于他',
  context: '我们共同的上下文',
  conduct: '我的做事准则',
  rapport: '关系与分寸',
})

/** 各段字符上限。顺序即重要度，预算不够时从后往前让。 */
const SECTION_CAPS = Object.freeze({
  who: 420,
  context: 520,
  conduct: 360,
  rapport: 300,
})

const SECTION_ORDER = Object.freeze(['who', 'context', 'conduct', 'rapport'])

export function renderProfile(profile, budget = 1400) {
  const sections = profile?.sections || {}
  const parts = []

  let remaining = Math.max(80, Number(budget) || 1400)
  for (const name of SECTION_ORDER) {
    const raw = String(sections[name] || '').trim()
    if (raw === '') continue
    const cap = Math.min(SECTION_CAPS[name], Math.max(0, remaining))
    if (cap < 40) break
    const text = truncate(raw, cap)
    parts.push(`## ${SECTION_TITLES[name]}\n${text}`)
    remaining -= text.length
    if (remaining < 40) break
  }

  return parts.join('\n\n')
}

export function renderHandoff(handoff, budget = 320) {
  if (!handoff || !handoff.entry) return ''
  const { entry } = handoff
  const lines = (entry.lastUser || [])
    .slice(-3)
    .map((text) => `- ${truncate(text, 90)}`)

  if (lines.length === 0) return ''

  const header = `（${relativeTime(entry.updatedAt)}）`
  const body = lines.join('\n')
  return truncate(`${header}\n${body}`, Math.max(80, Number(budget) || 320))
}

/**
 * 最近确认过的卡片，压成一条有界的短带。
 * 条数和总字数都封死——它是「短期工作记忆」，不是第二个画像。
 */
export function renderRecent(cards, budget = 260) {
  if (!Array.isArray(cards) || cards.length === 0) return ''
  const cap = Math.max(60, Number(budget) || 260)
  const lines = []
  let used = 0

  for (const card of cards) {
    const line = `- ${truncate(String(card.text || '').replace(/\s+/g, ' ').trim(), 64)}`
    if (line.length <= 3) continue
    if (used + line.length + 1 > cap) break
    lines.push(line)
    used += line.length + 1
  }

  return lines.join('\n')
}

/**
 * 组装首轮注入块。没有内容就返回空串——空串意味着「什么都不加」，
 * 而不是加一个「暂无记忆」的占位符（那纯属浪费 token）。
 */
export function renderMemoryBlock({
  profile,
  handoff,
  recent,
  persona,
  history,
  profileBudget,
  handoffBudget,
  recentBudget = 260,
  personaBudget = 500,
  historyBudget = 700,
}) {
  const profileText = renderProfile(profile, profileBudget)
  const recentText = renderRecent(recent, recentBudget)
  const handoffText = renderHandoff(handoff, handoffBudget)
  const personaText = truncate(String(persona || '').trim(), Math.max(0, personaBudget))
  const historyText = truncate(String(history || '').trim(), Math.max(0, historyBudget))

  if (profileText === '' && recentText === '' && handoffText === ''
    && personaText === '' && historyText === '') return ''

  const parts = [MEMORY_MARKER]
  // 人设放最前：它是「我该怎么说话」的总纲，其余都是事实。
  if (personaText !== '') parts.push(`## 人设（他希望的我是这样）\n${personaText}`)
  if (profileText !== '') parts.push(profileText)
  if (recentText !== '') parts.push(`## 最近确认\n${recentText}`)
  if (historyText !== '') parts.push(`## 更早的会话（摘要）\n${historyText}`)
  if (handoffText !== '') parts.push(`## 上次会话接手\n${handoffText}`)

  parts.push(
    '（以上是跨会话记忆。这里没有的过往细节用 soul_recall 查，不要凭空补；'
    + '确认了值得长期记住的事用 soul_remember 存；'
    + '画像需要修订时用 soul_shape。）',
  )

  return parts.join('\n\n')
}
