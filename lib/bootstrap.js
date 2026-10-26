/**
 * 历史会话整理（bootstrap）。
 *
 * 安装后第一次跑一遍，把已有会话压成一份精简摘要，
 * 让「新会话第一句」之前就知道过去发生过什么——而不是从一片空白开始。
 *
 * 这里的取舍是**确定性优先**：不调用模型，只做结构化抽取。
 * 理由有两个：
 *   1. 安装是用户刚装好的那一刻，不该悄悄烧钱；
 *   2. 摘要只要「能认出这是哪件事」，细节随时可以用 session 检索查回来。
 * 需要更聪明的摘要时，把这段文本当输入交给模型重写即可。
 */

import { MEMORY_MARKER } from './render.js'

/** 摘要里最多出现多少个会话。 */
const MAX_SESSIONS = 60

/** 整份摘要的字数上限。 */
const MAX_CHARS = 3600

/** 单个会话里，首末两句话各截多长。 */
const SNIPPET = 64

/**
 * 从会话语料里抽取一份摘要。
 *
 * @param {object} options
 * @param {object} options.sessionQuery 宿主的 sessionQuery 服务
 * @param {string[]} options.exclude 不要记录的会话 id
 * @param {(level: string, msg: string) => void} [options.log]
 * @returns {Promise<{ text: string, entries: object[] }>}
 */
export async function buildHistoryDigest({ sessionQuery, exclude = [], log }) {
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') {
    throw new Error('宿主没有 sessionQuery 服务，无法整理历史会话')
  }

  const skip = new Set(exclude.filter((id) => typeof id === 'string' && id !== ''))
  const records = await sessionQuery.listSessions()

  const entries = []
  for (const record of records) {
    const header = record?.header
    const id = header?.id
    if (typeof id !== 'string' || id === '') continue
    if (skip.has(id)) continue
    if (header.origin === 'subagent') continue

    let snapshot
    try {
      snapshot = await sessionQuery.readSession(id)
    } catch (error) {
      log?.('debug', `读取会话 ${id} 失败，跳过：${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const users = []
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      if (event.data?.source?.kind !== 'user') continue
      const text = textOf(event.data).replace(/\s+/g, ' ').trim()
      if (text === '') continue
      // 插件自己注入的记忆块也显示成 user 消息，别把它的内容当成用户发言。
      if (text.includes(MEMORY_MARKER)) continue
      users.push(text)
    }
    if (users.length === 0) continue

    entries.push({
      id,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      createdAt: Number(header.createdAt) || 0,
      turns: users.length,
      first: users[0].slice(0, SNIPPET),
      last: users[users.length - 1].slice(0, SNIPPET),
    })
  }

  // 新的排前面：最近做的事更容易被接着做下去。
  entries.sort((a, b) => b.createdAt - a.createdAt)
  const picked = entries.slice(0, MAX_SESSIONS)

  const lines = []
  let used = 0
  for (const entry of picked) {
    const date = formatDate(entry.createdAt)
    const place = shortCwd(entry.cwd)
    const head = `- ${date}${place ? ` · ${place}` : ''} · ${entry.turns} 轮`
    const body = `  首:「${entry.first}」`
    const tail = entry.last !== entry.first ? `\n  末:「${entry.last}」` : ''
    const blockLen = head.length + body.length + tail.length + 2
    if (used + blockLen > MAX_CHARS) break
    lines.push(`${head}\n${body}${tail}`)
    used += blockLen
  }

  return {
    text: lines.join('\n'),
    entries: picked.map((entry) => ({ id: entry.id, cwd: entry.cwd, turns: entry.turns })),
  }
}

function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

function formatDate(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '未知日期'
  const date = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 只留最后一级目录名，够用来判断「这是哪个项目」。 */
function shortCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length === 0 ? '' : parts[parts.length - 1]
}
