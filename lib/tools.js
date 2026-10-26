/**
 * 对外工具。
 *
 * 设计上只有五个，而且都用 soul_ 前缀：模型看到前缀就知道「这是记忆」，
 * 不需要在系统提示里额外解释一遍——工具描述本身就是文档。
 */

import { CARD_KINDS, SECTION_NAMES, scopeOf } from './store.js'
import { redact } from './text.js'
import { SECTION_TITLES, renderProfile } from './render.js'

const KIND_HINT = 'fact=关于项目或世界的事实；user=关于用户本人的信息；trait=我自己的倾向；rule=我给自己定的做法'

function sessionOf(exec) {
  return exec?.agent?.session
}

function sessionIdOf(exec) {
  return sessionOf(exec)?.header?.id
}

function cwdOf(exec) {
  return sessionOf(exec)?.header?.cwd
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

export function registerTools(ctx, store, cfg, deps = {}) {
  const disposers = []

  const add = (definition) => {
    const dispose = ctx.tools.register(definition)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  // -- soul_remember -------------------------------------------------------

  add({
    name: 'soul_remember',
    description: `把一条值得跨会话记住的事写进长期记忆。${KIND_HINT}。`
      + '同一件事重复写会被自动合并、权重上调，所以不必担心写重。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '一句话，必须是可判真假的陈述。不要写感受式的空话。' },
        kind: { type: 'string', enum: [...CARD_KINDS], default: 'fact', description: KIND_HINT },
        tags: { type: 'array', items: { type: 'string' }, description: '便于以后召回的短标签，可选。' },
        confidence: { type: 'number', description: '0–1。用户明说的给 0.9，我推断的给 0.6。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'kind', 'merged', 'cards', 'redacted'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          kind: { type: 'string' },
          merged: { type: 'boolean' },
          cards: { type: 'integer' },
          redacted: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const action = value.merged ? '合并到已有记忆' : '已写入'
        const note = value.redacted ? '（含疑似密钥，已隐去）' : ''
        return textBlocks(`✅ ${action}${note}，id=${String(value.id).slice(0, 10)}，当前共 ${value.cards} 条。`)
      },
    },
    execute(args, exec) {
      const scope = scopeOf(cwdOf(exec))
      const sessionId = sessionIdOf(exec)
      let text = String(args?.text ?? '').trim()
      if (text === '') throw new Error('soul_remember: text 不能为空')

      let redacted = false
      if (cfg.redact) {
        const result = redact(text)
        text = result.text
        redacted = result.hit
      }

      const { card, merged } = store.addCard({
        text,
        kind: args?.kind,
        tags: args?.tags,
        confidence: args?.confidence,
        scope,
        source: { sessionId },
      })

      return {
        ok: true,
        id: card.id,
        kind: card.kind,
        merged,
        cards: store.activeCards().length,
        redacted,
      }
    },
  })

  // -- soul_recall ---------------------------------------------------------

  add({
    name: 'soul_recall',
    description: '按关键词检索长期记忆里的卡片。涉及过往细节而当前上下文没有时，先查再答，不要猜。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '要查的内容，直接用自然语言即可。' },
        kind: { type: 'string', enum: [...CARD_KINDS], description: '只看某一类，可选。' },
        limit: { type: 'integer', default: 5, description: '返回条数，默认 5。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'count', 'items'],
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'text', 'weight', 'hits'],
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                text: { type: 'string' },
                weight: { type: 'number' },
                hits: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return textBlocks('记忆里没有匹配的条目。')
        const lines = value.items.map((item) => `- [${item.kind}] ${item.text}  \`${item.id}\``)
        return textBlocks(`找到 ${value.count} 条：\n${lines.join('\n')}`)
      },
    },
    execute(args, exec) {
      const items = store.recall(String(args?.query ?? ''), {
        limit: args?.limit ?? cfg.recallLimit,
        kind: args?.kind,
        scope: scopeOf(cwdOf(exec)),
      })
      return {
        ok: true,
        count: items.length,
        items: items.map((card) => ({
          id: card.id,
          kind: card.kind,
          text: card.text,
          weight: Number((Number(card.weight) || 1).toFixed(2)),
          hits: Number(card.hits) || 0,
        })),
      }
    },
  })

  // -- soul_profile --------------------------------------------------------

  add({
    name: 'soul_profile',
    description: '查看当前的长期画像（这是每次新会话真正被注入的那份文本）以及记忆统计。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'text', 'cards', 'retired', 'sessions'],
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          cards: { type: 'integer' },
          retired: { type: 'integer' },
          sessions: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const body = value.text === '' ? '（画像还是空的）' : value.text
        return textBlocks(
          `${body}\n\n— 卡片 ${value.cards} 条（已退役 ${value.retired}），会话 ${value.sessions} 个`,
        )
      },
    },
    execute() {
      const stats = store.stats()
      return {
        ok: true,
        text: renderProfile(store.profile, cfg.profileBudget),
        cards: stats.cards,
        retired: stats.retired,
        sessions: stats.sessions,
      }
    },
  })

  // -- soul_shape ----------------------------------------------------------

  add({
    name: 'soul_shape',
    description: '改写画像的某一段。画像才是每轮真正注入的东西，'
      + '所以只在有充分证据时改它，而且改完这段总长度不该变长。段名：'
      + SECTION_NAMES.map((name) => `${name}=${SECTION_TITLES[name]}`).join('；'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['section', 'text'],
      properties: {
        section: { type: 'string', enum: [...SECTION_NAMES] },
        text: { type: 'string', description: '这一段的完整新内容（覆盖，不是追加）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'section', 'chars', 'total'],
        properties: {
          ok: { type: 'boolean' },
          section: { type: 'string' },
          chars: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      render: (_args, value) => textBlocks(
        `✍️ 画像「${SECTION_TITLES[value.section] || value.section}」已更新（${value.chars} 字，画像共 ${value.total} 字）。下个会话生效。`,
      ),
    },
    execute(args) {
      const section = String(args?.section ?? '')
      const text = String(args?.text ?? '').trim()
      store.setSection(section, text)
      return {
        ok: true,
        section,
        chars: text.length,
        total: renderProfile(store.profile, cfg.profileBudget).length,
      }
    },
  })

  // -- soul_forget ---------------------------------------------------------

  add({
    name: 'soul_forget',
    description: '把一条记忆退役。不是物理删除——立刻停止参与召回，但记录留着，避免我下次又把它推断回来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: '卡片 id，从 soul_recall 或 soul_profile 得到。' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'existed'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          existed: { type: 'boolean' },
        },
      },
      render: (_args, value) => textBlocks(value.existed ? `🗑️ 已退役 ${value.id}。` : `没有找到 ${value.id}。`),
    },
    execute(args) {
      const id = String(args?.id ?? '').trim()
      const existed = id === '' ? false : store.forget(id)
      return { ok: true, id, existed }
    },
  })

  // -- soul_persona --------------------------------------------------------

  add({
    name: 'soul_persona',
    description: '读或写「人设」——你希望我成为什么样的助手。'
      + '不传 text 就是读；传了就是整段替换（传空字符串等于清空）。'
      + '人设会作为记忆块的第一段，每个会话开头注入。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '新的完整人设；省略则只读取当前人设。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'text', 'changed'],
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          changed: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const body = value.text === '' ? '（人设还是空的）' : value.text
        const head = value.changed ? '✍️ 人设已更新，下个会话生效。\n\n' : ''
        return textBlocks(`${head}${body}`)
      },
    },
    async execute(args) {
      if (args && typeof args.text === 'string') {
        if (typeof deps.setPersona !== 'function') throw new Error('soul_persona: 宿主未提供写入能力')
        await deps.setPersona(args.text)
        return { ok: true, text: args.text, changed: true }
      }
      return { ok: true, text: cfg.persona || '', changed: false }
    },
  })

  // -- soul_bootstrap ------------------------------------------------------

  add({
    name: 'soul_bootstrap',
    description: '重新整理已有会话，生成一份精简摘要，写进「历史会话摘要」。'
      + '安装后会自动跑一次；之后想刷新（比如攒了很多新会话）再用这个。'
      + '被 excludeSessions 排除的会话不会被读。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => textBlocks(value.summary),
    },
    async execute() {
      if (typeof deps.runBootstrap !== 'function') throw new Error('soul_bootstrap: 宿主未提供整理能力')
      const result = await deps.runBootstrap()
      if (!result.ok) return { ok: false, summary: '没有可整理的历史会话（可能都被排除了，或者都是子会话）。' }
      return {
        ok: true,
        summary: `📚 已整理 ${result.entries.length} 个会话，摘要 ${result.text.length} 字，已写入配置。\n`
          + '下次开新会话生效；也可以直接去设置页看或改。',
      }
    },
  })

  // -- soul_diag -----------------------------------------------------------

  add({
    name: 'soul_diag',
    description: '诊断用：查看客户端模块图里有没有本插件的客户端半边、有没有加载失败。'
      + '设置页不出现时先跑这个，而不是猜。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'text'],
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => textBlocks(value.text),
    },
    execute() {
      const parts = []

      try {
        const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
        if (settings && typeof settings.describe === 'function') {
          const rows = settings.describe() || []
          const names = rows.map((row) => row?.ns)
          const soulRow = rows.find((row) => String(row?.ns ?? '').toLowerCase().includes('soul'))
          const meowRow = rows.find((row) => row?.ns === 'meow-memory')

          const describeOne = (row) => (row
            ? {
              ns: row.ns,
              autoGenerate: row.autoGenerate,
              hasSchema: row.schema !== undefined && row.schema !== null,
              schemaKeys: row.schema && typeof row.schema === 'object' ? Object.keys(row.schema) : null,
              valueKeys: row.value && typeof row.value === 'object' ? Object.keys(row.value) : null,
              hasBase: row.base !== undefined,
              hasUser: row.user !== undefined,
              revision: row.revision,
            }
            : null)

          const shape = {
            total: rows.length,
            soul: describeOne(soulRow),
            meow: describeOne(meowRow),
          }
          parts.push(`【宿主 settings.describe()】\n\`\`\`json\n${JSON.stringify(shape, null, 2).slice(0, 2000)}\n\`\`\``)
        } else {
          parts.push('【宿主 settings.describe()】宿主没有暴露该服务。')
        }
      } catch (error) {
        parts.push(`【宿主 settings.describe()】读取失败：${error instanceof Error ? error.message : String(error)}`)
      }

      try {
        const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
        if (!clientModules || typeof clientModules.graph !== 'function') {
          parts.push('【客户端模块图】宿主没有暴露 clientModules 服务。')
          return { ok: false, text: parts.join('\n\n') }
        }

        const graph = clientModules.graph()
        const list = Array.isArray(graph?.rows)
          ? graph.rows
          : Array.isArray(graph?.entries)
            ? graph.entries
            : []

        const mine = list.filter((row) => JSON.stringify(row).toLowerCase().includes('soul'))
        const summary = {
          totalRows: list.length,
          release: graph?.release ?? null,
          mine,
        }
        parts.push(`【客户端模块图】共 ${list.length} 条，命中 soul 的 ${mine.length} 条：\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 2000)}\n\`\`\``)
        return { ok: true, text: parts.join('\n\n') }
      } catch (error) {
        parts.push(`【客户端模块图】读取失败：${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, text: parts.join('\n\n') }
      }
    },
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 卸载期的清理失败不值得让宿主报错 */
      }
    }
  }
}
