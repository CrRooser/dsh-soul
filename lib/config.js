/**
 * 配置解析。
 *
 * 这一版**故意不导出 Schemastery 的 Config**：零外部依赖意味着插件在任何
 * DSH 版本里都不会因为解析不到 schema 包而整个加载失败。代价是暂时没有
 * 设置页表单，配置走 cordis.patch.yml 的 `config:` 字段，照样生效。
 */

export const DEFAULTS = Object.freeze({
  /** 总开关。false 时插件完全不注册任何东西。 */
  enabled: true,
  /** 数据目录。空字符串 = ~/.dsh/storages/soul */
  dataDir: '',
  /** 是否在新会话首轮注入记忆块。 */
  inject: true,
  /** 是否跳过子会话（子代理不该继承人格）。 */
  skipSubagents: true,
  /** 画像正文的字符预算（中文约 1.3 字/token）。 */
  profileBudget: 1400,
  /** 交接卡的字符预算。 */
  handoffBudget: 320,
  /** 单次 soul_recall 默认返回条数。 */
  recallLimit: 5,
  /** 写入时判定「同一件事」的相似度阈值。 */
  dedupeThreshold: 0.82,
  /** 卡片总量上限，超出后淘汰最久未被命中的。 */
  maxCards: 400,
  /** 写入前过滤疑似密钥。 */
  redact: true,
})

export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...input }

  cfg.enabled = input.enabled !== false
  cfg.inject = input.inject !== false
  cfg.skipSubagents = input.skipSubagents !== false
  cfg.redact = input.redact !== false
  cfg.dataDir = typeof input.dataDir === 'string' ? input.dataDir.trim() : ''

  cfg.profileBudget = clampInt(cfg.profileBudget, 200, 6000, DEFAULTS.profileBudget)
  cfg.handoffBudget = clampInt(cfg.handoffBudget, 60, 1200, DEFAULTS.handoffBudget)
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
