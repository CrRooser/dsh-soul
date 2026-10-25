/**
 * 存储层：三个 JSON 文件，原子写入，串行化。
 *
 * 为什么是 JSON 而不是 SQLite：
 *   1. 记忆必须是**可读可改**的。你能用记事本打开、改一行、下个会话就生效。
 *   2. 零依赖、零迁移、零锁。卡片在几百张量级，全量加载进内存没有任何压力。
 *   3. 数据丢了能用 git 恢复，数据库文件丢了一般就没了。
 *
 * 写入一律「临时文件 + rename」，断电也不会留下半个 JSON。
 */

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { scoreCard, similarity, tokenize } from './text.js'

const CARDS_VERSION = 1
const PROFILE_VERSION = 1
const STATE_VERSION = 1

/** 只保留最近这么多个会话的交接信息。 */
const MAX_SESSIONS = 12

export const CARD_KINDS = Object.freeze(['fact', 'user', 'trait', 'rule'])
export const SECTION_NAMES = Object.freeze(['who', 'context', 'conduct', 'rapport'])

export function defaultDataDir() {
  return join(homedir(), '.dsh', 'storages', 'soul')
}

/** 把工作目录归一成作用域名：Windows 路径大小写不敏感，分隔符统一。 */
export function scopeOf(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return 'global'
  return `project:${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
}

function emptySections() {
  const sections = {}
  for (const name of SECTION_NAMES) sections[name] = ''
  return sections
}

function emptyCards() {
  return { version: CARDS_VERSION, cards: [] }
}

function emptyProfile() {
  return { version: PROFILE_VERSION, updatedAt: 0, sections: emptySections() }
}

function emptyState() {
  return { version: STATE_VERSION, sessions: {} }
}

export class SoulStore {
  constructor(dir, options = {}) {
    this.dir = dir && String(dir).trim() !== '' ? String(dir) : defaultDataDir()
    this.maxCards = options.maxCards ?? 400
    this.dedupeThreshold = options.dedupeThreshold ?? 0.82

    this.cards = []
    this.profile = emptyProfile()
    this.state = emptyState()

    this.loaded = false
    this.dirty = false
    this._timer = null
    this._queue = Promise.resolve()
  }

  // -- 文件路径 ------------------------------------------------------------

  get cardsFile() {
    return join(this.dir, 'cards.json')
  }

  get profileFile() {
    return join(this.dir, 'profile.json')
  }

  get stateFile() {
    return join(this.dir, 'state.json')
  }

  // -- 载入 ----------------------------------------------------------------

  async load() {
    if (this.loaded) return this
    this.loaded = true
    await mkdir(this.dir, { recursive: true })

    const cards = await this._read('cards.json')
    if (Array.isArray(cards?.cards)) {
      this.cards = cards.cards.filter(isUsableCard)
    }

    const profile = await this._read('profile.json')
    if (profile && typeof profile === 'object' && profile.sections && typeof profile.sections === 'object') {
      const sections = emptySections()
      for (const name of SECTION_NAMES) {
        const value = profile.sections[name]
        sections[name] = typeof value === 'string' ? value : ''
      }
      this.profile = {
        version: PROFILE_VERSION,
        updatedAt: Number(profile.updatedAt) || 0,
        sections,
      }
    }

    const state = await this._read('state.json')
    if (state && typeof state === 'object' && state.sessions && typeof state.sessions === 'object') {
      this.state = { version: STATE_VERSION, sessions: { ...state.sessions } }
    }

    return this
  }

  async _read(name) {
    const file = join(this.dir, name)
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      // 坏文件不阻塞启动：备份一份，然后当作空的重来。
      try {
        await copyFile(file, `${file}.corrupt-${Date.now()}`)
      } catch {
        /* 备份失败也不能让宿主崩掉 */
      }
      return undefined
    }
  }

  // -- 写入原语 ------------------------------------------------------------

  _enqueue(task) {
    const run = () => task().then(
      () => undefined,
      () => undefined, // 存储失败永远不往上抛：记忆坏了也不该毁掉这次对话
    )
    this._queue = this._queue.then(run, run)
    return this._queue
  }

  async _write(file, value) {
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  async flush() {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    const snapshot = {
      cards: { version: CARDS_VERSION, cards: this.cards },
      profile: this.profile,
      state: this.state,
    }
    await this._enqueue(async () => {
      await mkdir(this.dir, { recursive: true })
      await this._write(this.cardsFile, snapshot.cards)
      await this._write(this.profileFile, snapshot.profile)
      await this._write(this.stateFile, snapshot.state)
    })
  }

  /**
   * 标脏 + 自动排一次落盘。
   *
   * 落盘是存储层自己的责任，不是调用方的。v0.1 把这件事丢给调用方，
   * 结果 soul_remember / soul_shape 写完只在内存里——进程被杀就全丢。
   * 现在任何一次写都会自己排上。
   */
  markDirty(delay = 1200) {
    this.dirty = true
    if (this._timer !== null) return
    this._timer = setTimeout(() => {
      this._timer = null
      void this.flush()
    }, delay)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  /** 卸载钩子：把没落盘的一次性写下去。 */
  async dispose() {
    await this.flush()
  }

  // -- 卡片 ----------------------------------------------------------------

  activeCards(now = Date.now()) {
    return this.cards.filter((card) => isActive(card, now))
  }

  /**
   * 写入一张卡。相似度超过阈值就合并到已有的那张——
   * 同一件事被说三遍，应该是权重涨三倍，而不是多出三张卡。
   */
  addCard(input) {
    const text = String(input.text ?? '').trim()
    if (text === '') throw new Error('记忆内容为空')

    const kind = CARD_KINDS.includes(input.kind) ? input.kind : 'fact'
    const now = Date.now()
    const tags = normalizeTags(input.tags)

    let best = null
    let bestScore = 0
    for (const card of this.cards) {
      if (card.status !== 'active') continue
      const score = similarity(card.text, text)
      if (score > bestScore) {
        bestScore = score
        best = card
      }
    }

    if (best && bestScore >= this.dedupeThreshold) {
      best.weight = Math.min(10, (Number(best.weight) || 1) + 0.4)
      best.confidence = Math.max(Number(best.confidence) || 0, clamp01(input.confidence, 0.7))
      best.updatedAt = now
      if (best.text.length < text.length && bestScore >= 0.92) best.text = text
      if (tags.length > 0) best.tags = [...new Set([...(best.tags || []), ...tags])].slice(0, 12)
      this._noteEvidence(best, input.source)
      this.markDirty()
      return { card: best, merged: true }
    }

    const card = {
      id: `c_${randomUUID().slice(0, 8)}`,
      kind,
      text,
      tags,
      scope: typeof input.scope === 'string' && input.scope !== '' ? input.scope : 'global',
      confidence: clamp01(input.confidence, 0.7),
      weight: 1,
      hits: 0,
      createdAt: now,
      updatedAt: now,
      lastHitAt: 0,
      evidence: [],
      supersededBy: null,
      status: 'active',
    }
    this._noteEvidence(card, input.source)
    this.cards.push(card)
    this._trim()
    this.markDirty()
    return { card, merged: false }
  }

  _noteEvidence(card, source) {
    if (!source || typeof source.sessionId !== 'string') return
    const exists = (card.evidence || []).some((item) => item.sessionId === source.sessionId)
    if (exists) return
    card.evidence = [...(card.evidence || []), {
      sessionId: source.sessionId,
      at: Date.now(),
      ...(Number.isFinite(source.seq) ? { seq: source.seq } : {}),
    }].slice(-8)
  }

  recall(query, options = {}) {
    const limit = Math.max(1, Math.min(20, Math.floor(Number(options.limit) || 5)))
    const scope = typeof options.scope === 'string' ? options.scope : undefined
    const kind = CARD_KINDS.includes(options.kind) ? options.kind : undefined
    const now = Date.now()
    const queryTokens = tokenize(query)

    const hits = []
    for (const card of this.cards) {
      if (!isActive(card, now)) continue
      if (kind && card.kind !== kind) continue
      if (scope && card.scope !== 'global' && card.scope !== scope) continue
      const score = queryTokens.size > 0 ? scoreCard(queryTokens, card, now) : 0
      if (queryTokens.size > 0 && score <= 0) continue
      hits.push({ card, score })
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (Number(b.card.weight) || 1) - (Number(a.card.weight) || 1)
    })

    const picked = hits.slice(0, limit)
    for (const { card } of picked) {
      card.hits = (Number(card.hits) || 0) + 1
      card.lastHitAt = now
    }
    if (picked.length > 0) this.markDirty()

    return picked.map(({ card, score }) => ({ ...card, score: Number(score.toFixed(4)) }))
  }

  forget(id) {
    const card = this.cards.find((item) => item.id === id)
    if (!card) return false
    card.status = 'retired'
    card.retiredAt = Date.now()
    this.markDirty()
    return true
  }

  /**
   * 最近确认过的卡片。
   *
   * 存在的理由：画像要靠凝结才更新得了，而凝结是 P1 的事。在那之前，
   * 一条刚写进去的事实如果既进不了画像、也进不了上下文，那「记住」就是假的。
   * 所以留一条有界的短带子——只放最近几张，条数和字数都封死，
   * 不会随会话变长而膨胀。
   */
  recentCards(limit = 6) {
    const now = Date.now()
    return this.cards
      .filter((card) => isActive(card, now))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      .slice(0, Math.max(0, Math.floor(limit)))
  }

  _trim() {
    if (this.cards.length <= this.maxCards) return
    const retired = this.cards.filter((card) => card.status !== 'active')
    if (retired.length > 0) {
      retired.sort((a, b) => (a.retiredAt || 0) - (b.retiredAt || 0))
      const drop = new Set(retired.slice(0, this.cards.length - this.maxCards).map((card) => card.id))
      this.cards = this.cards.filter((card) => !drop.has(card.id))
      return
    }
    this.cards.sort((a, b) => (Number(b.weight) || 1) - (Number(a.weight) || 1))
    this.cards = this.cards.slice(0, this.maxCards)
  }

  // -- 画像 ----------------------------------------------------------------

  setSection(name, text) {
    if (!SECTION_NAMES.includes(name)) throw new Error(`未知的画像段落：${name}`)
    this.profile.sections[name] = String(text ?? '').trim()
    this.profile.updatedAt = Date.now()
    this.markDirty()
  }

  getSection(name) {
    return SECTION_NAMES.includes(name) ? this.profile.sections[name] || '' : ''
  }

  hasProfile() {
    return SECTION_NAMES.some((name) => (this.profile.sections[name] || '').trim() !== '')
  }

  // -- 会话交接 ------------------------------------------------------------

  /**
   * 只记「最近说了什么」，不记全量对话——全量对话已经在会话日志里了，
   * 用 sessionQuery 随时能查回来。这里存的是**下次开口前需要的那一口气**。
   */
  noteSession({ sessionId, cwd, userText }) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const entry = this.state.sessions[sessionId] || { cwd: null, lastUser: [], turns: 0, updatedAt: 0 }
    entry.cwd = typeof cwd === 'string' ? cwd : entry.cwd
    entry.updatedAt = Date.now()
    entry.turns = (Number(entry.turns) || 0) + 1

    const text = String(userText ?? '').replace(/\s+/g, ' ').trim()
    if (text !== '') {
      entry.lastUser = [...(entry.lastUser || []), text.slice(0, 200)].slice(-4)
    }

    this.state.sessions[sessionId] = entry
    this._trimSessions()
    this.markDirty()
  }

  _trimSessions() {
    const ids = Object.keys(this.state.sessions)
    if (ids.length <= MAX_SESSIONS) return
    ids.sort((a, b) => (this.state.sessions[a].updatedAt || 0) - (this.state.sessions[b].updatedAt || 0))
    for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete this.state.sessions[id]
  }

  /** 最近一次**别的**会话。当前会话的痕迹不该拿来交接给自己。 */
  latestHandoff(excludeSessionId) {
    let best = null
    for (const [sessionId, entry] of Object.entries(this.state.sessions)) {
      if (sessionId === excludeSessionId) continue
      if (!entry || !Array.isArray(entry.lastUser) || entry.lastUser.length === 0) continue
      if (!best || (entry.updatedAt || 0) > (best.entry.updatedAt || 0)) {
        best = { sessionId, entry }
      }
    }
    return best
  }

  stats() {
    const active = this.cards.filter((card) => card.status === 'active')
    const byKind = {}
    for (const card of active) byKind[card.kind] = (byKind[card.kind] || 0) + 1
    return {
      cards: active.length,
      retired: this.cards.length - active.length,
      byKind,
      sessions: Object.keys(this.state.sessions).length,
      profileUpdatedAt: this.profile.updatedAt,
    }
  }
}

function isUsableCard(card) {
  return card !== null && typeof card === 'object' && typeof card.id === 'string' && typeof card.text === 'string'
}

function isActive(card, now) {
  if (card.status !== 'active') return false
  if (card.supersededBy) return false
  // 90 天没被用过的卡不是错，只是过期了；留在盘上，但不参与召回。
  const last = Number(card.lastHitAt) || Number(card.createdAt) || now
  return now - last < 90 * 86400000
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== ''))].slice(0, 12)
}

function clamp01(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}
