/**
 * 配置。
 *
 * 导出的 `Config` 不只是给用户看文档的——DSH 的设置页就是照着它自动生成表单的，
 * 而且**没在 schema 里声明的键会被宿主直接剥掉**，所以想开放什么就必须在这里声明。
 */

import z from '@deepseek-ai/schemastery'

export const DEFAULTS = Object.freeze({
  enabled: true,
  injectMode: 'auto',
  dataDir: '',
  skipSubagents: true,
  profileBudget: 1400,
  handoffBudget: 320,
  recentCards: 6,
  recentBudget: 260,
  recallLimit: 5,
  dedupeThreshold: 0.82,
  maxCards: 400,
  redact: true,
})

export const INJECT_MODES = Object.freeze(['auto', 'system', 'message'])

export const Config = z.object({
  enabled: z.boolean()
    .default(true)
    .description('总开关。关掉后不注入、不注册工具，已有数据原样保留。'),

  injectMode: z.string()
    .default('auto')
    .description('注入方式。system = 写进系统提示，聊天记录里看不见；message = 作为一条消息插在提问前；auto = 能用 system 就用 system，否则退回 message。'),

  profileBudget: z.number().min(200).max(6000).step(50)
    .default(1400)
    .description('画像正文的字数预算。中文约 1.3 字/token。'),

  handoffBudget: z.number().min(60).max(1200).step(20)
    .default(320)
    .description('「上次会话接手」的字数预算。'),

  recentCards: z.number().min(0).max(20).step(1)
    .default(6)
    .description('「最近确认」最多列出几条卡片。设为 0 可关闭这一块。'),

  recentBudget: z.number().min(0).max(1200).step(20)
    .default(260)
    .description('「最近确认」的字数预算。'),

  recallLimit: z.number().min(1).max(20).step(1)
    .default(5)
    .description('soul_recall 单次默认返回条数。'),

  dedupeThreshold: z.number().min(0.5).max(0.99)
    .default(0.82)
    .description('写入时判定「这是同一件事」的相似度阈值。调高更容易产生重复卡片。'),

  maxCards: z.number().min(20).max(5000).step(10)
    .default(400)
    .description('卡片总量上限，超出后淘汰最久未被命中的。'),

  redact: z.boolean()
    .default(true)
    .description('写入前过滤疑似密钥、身份证、银行卡。'),

  skipSubagents: z.boolean()
    .default(true)
    .description('子会话不继承人格。'),

  dataDir: z.string()
    .default('')
    .description('数据目录。留空表示 ~/.dsh/storages/soul。'),
})

/**
 * 必须在根上标 volatile。
 *
 * dsh-settings 的 describe() 用 volatileForm() 过滤：只有 meta.volatile 的字段
 * （或它的祖先）才会被收进表单，其余全部丢弃。一个字段都不剩时，整个条目会被
 * 静默跳过——设置页看得见、却永远读不到值。
 */
Object.assign(Config.meta, { volatile: true })

export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...input }

  cfg.enabled = input.enabled !== false
  cfg.skipSubagents = input.skipSubagents !== false
  cfg.redact = input.redact !== false
  cfg.dataDir = typeof input.dataDir === 'string' ? input.dataDir.trim() : ''
  cfg.injectMode = INJECT_MODES.includes(input.injectMode) ? input.injectMode : 'auto'

  cfg.profileBudget = clampInt(cfg.profileBudget, 200, 6000, DEFAULTS.profileBudget)
  cfg.handoffBudget = clampInt(cfg.handoffBudget, 60, 1200, DEFAULTS.handoffBudget)
  cfg.recentCards = clampInt(cfg.recentCards, 0, 20, DEFAULTS.recentCards)
  cfg.recentBudget = clampInt(cfg.recentBudget, 0, 1200, DEFAULTS.recentBudget)
  cfg.recallLimit = clampInt(cfg.recallLimit, 1, 20, DEFAULTS.recallLimit)
  cfg.maxCards = clampInt(cfg.maxCards, 20, 5000, DEFAULTS.maxCards)

  const threshold = Number(cfg.dedupeThreshold)
  cfg.dedupeThreshold = Number.isFinite(threshold)
    ? Math.min(0.999, Math.max(0.5, threshold))
    : DEFAULTS.dedupeThreshold

  return cfg
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
