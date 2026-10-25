/**
 * 渲染层：把结构化记忆变成一段**稳定、可缓存**的文本。
 *
 * 两条硬约束：
 *   1. 同一个会话内，这段文本必须逐字节稳定——否则前缀缓存全废。
 *      所以这里绝不出现时间戳、计数器、随机数。
 *   2. 总量恒定。每段有硬上限，超了按优先级截断，而不是「这次先多写点」。
 */

import { relativeTime, truncate } from './text.js'

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
 * 组装首轮注入块。没有内容就返回空串——空串意味着「什么都不加」，
 * 而不是加一个「暂无记忆」的占位符（那纯属浪费 token）。
 */
export function renderMemoryBlock({ profile, handoff, profileBudget, handoffBudget }) {
  const profileText = renderProfile(profile, profileBudget)
  const handoffText = renderHandoff(handoff, handoffBudget)

  if (profileText === '' && handoffText === '') return ''

  const parts = ['【长期记忆 · dsh-soul】']
  if (profileText !== '') parts.push(profileText)
  if (handoffText !== '') parts.push(`## 上次会话接手\n${handoffText}`)

  parts.push(
    '（以上是跨会话记忆。这里没有的过往细节用 soul_recall 查，不要凭空补；'
    + '确认了值得长期记住的事用 soul_remember 存；'
    + '画像需要修订时用 soul_shape。）',
  )

  return parts.join('\n\n')
}
