/**
 * 文本工具：分词、相似度、token 估算、脱敏。
 *
 * 刻意不引入向量：卡片总量在几百张量级，关键词 + 权重打分就够用，
 * 而且这样插件零依赖、零索引维护、零额外调用。等真的不够用了再谈别的。
 */

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/

/** 中文约 1.5 字/token，其余约 4 字符/token。粗略但足够做预算控制。 */
export function approxTokens(text) {
  let cjk = 0
  let other = 0
  for (const ch of String(text ?? '')) {
    if (CJK_CHAR_RE.test(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

/**
 * 分词：ASCII 词（≥2 字符）+ 中文二元组。
 * 中文没有空格，双字滑窗是最省的召回手段，对短查询尤其有效。
 */
export function tokenize(text) {
  const source = String(text ?? '').toLowerCase()
  const tokens = new Set()

  for (const match of source.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(match[0])

  const chars = []
  for (const ch of source) if (CJK_CHAR_RE.test(ch)) chars.push(ch)
  for (let i = 0; i + 1 < chars.length; i += 1) tokens.add(chars[i] + chars[i + 1])

  return tokens
}

/** 余弦式归一化：完全相同的文本得 1，长度不同也不会被系统性压低。 */
export function similarity(a, b) {
  const left = tokenize(a)
  const right = tokenize(b)
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.sqrt(left.size * right.size)
}

/**
 * 给一张卡片打分。三个因子相乘：
 *   命中率  —— 查询覆盖得怎么样
 *   权重    —— 这张卡被确认过几次
 *   衰减    —— 越久没被用到越轻，但不会归零
 */
export function scoreCard(queryTokens, card, now = Date.now()) {
  if (!queryTokens || queryTokens.size === 0) return 0

  const cardTokens = tokenize(`${card.text} ${(card.tags || []).join(' ')}`)
  if (cardTokens.size === 0) return 0

  let shared = 0
  for (const token of queryTokens) if (cardTokens.has(token)) shared += 1
  if (shared === 0) return 0

  const overlap = shared / Math.sqrt(queryTokens.size * cardTokens.size)
  const weight = Math.max(0.1, Number(card.weight) || 1)
  const confidence = Math.max(0.1, Math.min(1, Number(card.confidence) || 0.6))
  const ageDays = Math.max(0, (now - (Number(card.lastHitAt) || Number(card.createdAt) || now)) / 86400000)
  const decay = 1 / (1 + ageDays / 45)

  return overlap * weight * confidence * decay
}

export function truncate(text, maxChars) {
  const value = String(text ?? '')
  const limit = Math.max(0, Math.floor(maxChars))
  if (value.length <= limit) return value
  if (limit <= 1) return value.slice(0, limit)
  return `${value.slice(0, limit - 1)}…`
}

export function relativeTime(ts, now = Date.now()) {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) return '未知'
  const diff = now - value
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(value).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// 脱敏：写卡之前先过一遍。宁可漏记，不可漏密。
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // 各类 API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\b\d{17}[\dXx]\b/g, // 身份证
  /\b\d{16,19}\b/g, // 银行卡
  // 不能用 \b：中文关键字两侧都不是 ASCII 词字符，边界断言会直接失效。
  /(?:password|passwd|pwd|密码|口令)\s*[:=：]\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export function redact(text) {
  let value = String(text ?? '')
  let hit = false
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, () => {
      hit = true
      return '［已隐去］'
    })
  }
  return { text: value, hit }
}
