window.__ModuleLoader__.load({
  id: 'dsh-soul',
  factory: (require) => {
    /**
     * dsh-soul 的客户端半侧：在「设置」里注册一页配置。
     *
     * 手写而非打包：这份文件本身就是构建产物该有的形态——
     * 只做一件事，把 factory 注册进模块加载器，模块体在首次 import 时才跑。
     *
     * 全部逻辑包在 try/catch 里：任何一步失败最多让「这一页不出现」，
     * 绝不允许把设置面板或者整个外壳拖垮。
     */
    const React = require('react')

    /** apply 时存下来的上下文，供设置组件读写配置。 */
    let activeCtx

    const SECTION_ID = 'soul'
    const NS_CANDIDATES = ['soul', 'include:soul', 'dsh-soul']

    /** 这一页暴露哪些字段。改这里等于改表单。 */
    const FIELDS = [
      {
        key: 'enabled',
        label: '总开关',
        hint: '关掉后不注入、不注册工具，已有数据原样保留。',
        type: 'boolean',
      },
      {
        key: 'injectMode',
        label: '注入方式',
        hint: 'system = 写进系统提示，聊天记录里看不见；message = 作为一条消息插在提问前；auto = 优先 system。',
        type: 'enum',
        options: ['auto', 'system', 'message'],
      },
      {
        key: 'profileBudget',
        label: '画像字数预算',
        hint: '四段画像合计的字数上限。中文约 1.3 字/token。',
        type: 'number',
        min: 200,
        max: 6000,
        step: 50,
      },
      {
        key: 'handoffBudget',
        label: '交接卡字数预算',
        hint: '「上次会话接手」那一段的字数上限。',
        type: 'number',
        min: 60,
        max: 1200,
        step: 20,
      },
      {
        key: 'recentCards',
        label: '最近确认条数',
        hint: '注入块里最多列几条最近动过的卡片。填 0 关闭这一块。',
        type: 'number',
        min: 0,
        max: 20,
        step: 1,
      },
      {
        key: 'recallLimit',
        label: 'soul_recall 默认条数',
        hint: '单次检索默认返回几条。',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
      },
      {
        key: 'redact',
        label: '写入前脱敏',
        hint: '过滤疑似密钥、身份证、银行卡。',
        type: 'boolean',
      },
      {
        key: 'skipSubagents',
        label: '子会话不继承人格',
        hint: '子代理跑任务时不该带着你的人格。',
        type: 'boolean',
      },
    ]

    // -- 与宿主通信 ------------------------------------------------------

    /**
     * 设置通道的服务名是 `remote.settings`（带点），不是 `remote`。
     * 这是 DSH 生成的命名空间服务，必须在 inject 里原样声明，否则拿不到。
     */
    function settingsRemote(ctx) {
      const candidates = ['remote.settings', 'remote']
      for (const name of candidates) {
        try {
          const value = typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
          const settings = name === 'remote' ? value && value.settings : value
          if (settings && typeof settings.describe === 'function') return settings
        } catch {
          /* 换下一个候选 */
        }
      }
      return undefined
    }

    async function readState(ctx) {
      const remote = settingsRemote(ctx)
      if (!remote) return { ok: false, reason: 'no-remote' }

      const described = await remote.describe()
      const view = described && described.ok === true ? described.value : described
      const rows = Array.isArray(view && view.namespaces) ? view.namespaces : []

      let row
      for (const candidate of NS_CANDIDATES) {
        row = rows.find((item) => item && item.ns === candidate)
        if (row) break
      }
      if (!row) {
        // 退一步：名字里带 soul 的都算（entry id 形态可能带前缀）
        row = rows.find((item) => typeof item?.ns === 'string' && item.ns.endsWith('soul'))
      }
      if (!row) return { ok: false, reason: 'no-entry', namespaces: rows.map((r) => r && r.ns) }

      return { ok: true, remote, ns: row.ns, revision: row.revision, value: row.value || {} }
    }

    async function writeState(ctx, state, patch) {
      const ops = Object.keys(patch).map((key) => ({ op: 'set', path: [key], value: patch[key] }))
      if (ops.length === 0) return
      await state.remote.mutate(state.ns, ops, state.revision)
    }

    // -- 界面 ------------------------------------------------------------

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px' },
      intro: { fontSize: '12px', lineHeight: '1.6', opacity: 0.72, margin: '0 0 4px' },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'rgba(127,127,127,0.07)',
      },
      label: { flex: '0 0 150px', fontSize: '13px', fontWeight: 500, paddingTop: '2px' },
      hint: { fontSize: '11px', lineHeight: '1.5', opacity: 0.6, marginTop: '3px' },
      control: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '4px' },
      input: {
        width: '100%',
        maxWidth: '260px',
        padding: '5px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '13px',
      },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' },
      button: {
        padding: '6px 16px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'rgba(127,127,127,0.12)',
        color: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
      status: { fontSize: '12px', opacity: 0.7 },
      error: { fontSize: '12px', color: '#d9534f', lineHeight: '1.6' },
    }

    function Field({ field, value, onChange }) {
      const control = (() => {
        if (field.type === 'boolean') {
          return React.createElement('input', {
            type: 'checkbox',
            checked: Boolean(value),
            onChange: (event) => onChange(event.target.checked),
          })
        }
        if (field.type === 'enum') {
          return React.createElement(
            'select',
            {
              style: S.input,
              value: String(value ?? field.options[0]),
              onChange: (event) => onChange(event.target.value),
            },
            ...field.options.map((option) => React.createElement('option', { key: option, value: option }, option)),
          )
        }
        return React.createElement('input', {
          type: 'number',
          style: S.input,
          value: value ?? '',
          min: field.min,
          max: field.max,
          step: field.step,
          onChange: (event) => {
            const raw = event.target.value
            onChange(raw === '' ? '' : Number(raw))
          },
        })
      })()

      return React.createElement(
        'div',
        { style: S.row },
        React.createElement(
          'div',
          { style: S.label },
          field.label,
          React.createElement('div', { style: S.hint }, field.hint),
        ),
        React.createElement('div', { style: S.control }, control),
      )
    }

    function SoulSettingsPage(props) {
      const ctx = activeCtx
      const [state, setState] = React.useState({ phase: 'loading' })
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState('')

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const next = await readState(ctx)
            if (!alive) return
            if (!next.ok) {
              setState({ phase: 'unavailable', reason: next.reason, namespaces: next.namespaces })
              return
            }
            setState({ phase: 'ready', info: next })
            setDraft(next.value || {})
          } catch (error) {
            if (!alive) return
            setState({ phase: 'unavailable', reason: 'read-failed', message: String(error && error.message) })
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      if (state.phase === 'loading') {
        return React.createElement('div', { style: S.page }, '正在读取配置…')
      }

      if (state.phase === 'unavailable') {
        const names = Array.isArray(state.namespaces) ? state.namespaces : []
        return React.createElement(
          'div',
          { style: S.page },
          React.createElement('div', { style: S.error }, '暂时读不到这个插件的配置（原因：' + state.reason + '）。'),
          names.length > 0
            ? React.createElement(
              'div',
              { style: S.hint },
              '当前可配置的命名空间共 ' + names.length + ' 个：',
              React.createElement(
                'div',
                { style: { ...S.hint, wordBreak: 'break-all', fontFamily: 'monospace', opacity: 0.8 } },
                names.join('、'),
              ),
            )
            : null,
          React.createElement(
            'div',
            { style: S.hint },
            '临时办法：直接改 profile 里的 cordis.patch.yml 的 ',
            React.createElement('code', null, '- id: soul / config: …'),
            '，或编辑 ~/.dsh/storages/soul/ 下的 JSON。',
          ),
        )
      }

      const save = async () => {
        try {
          setStatus('保存中…')
          const remote = settingsRemote(ctx)
          if (!remote) {
            setStatus('没有可用的设置通道')
            return
          }
          const described = await remote.describe()
          const view = described && described.ok === true ? described.value : described
          const rows = Array.isArray(view && view.namespaces) ? view.namespaces : []
          const row = rows.find((item) => item && item.ns === state.info.ns)
          await remote.mutate(state.info.ns, Object.keys(draft).map((key) => ({
            op: 'set',
            path: [key],
            value: draft[key],
          })), row ? row.revision : state.info.revision)
          setStatus('已保存')
        } catch (error) {
          setStatus('保存失败：' + String(error && error.message))
        }
      }

      return React.createElement(
        'div',
        { style: S.page },
        React.createElement(
          'p',
          { style: S.intro },
          '跨会话记忆、人格与关系分寸。改动会写进 profile 的配置层，下个会话生效。',
        ),
        ...FIELDS.map((field) =>
          React.createElement(Field, {
            key: field.key,
            field,
            value: draft[field.key],
            onChange: (next) => setDraft((current) => ({ ...current, [field.key]: next })),
          }),
        ),
        React.createElement(
          'div',
          { style: S.footer },
          React.createElement('button', { style: S.button, onClick: save }, '保存'),
          React.createElement('span', { style: S.status }, status),
        ),
      )
    }

    // -- 注册 ------------------------------------------------------------

    /**
     * 硬依赖。
     *
     * slots —— 注册设置页要用。上一版用 ctx.get('slots') 软取，apply 跑的时候
     *          服务还没就绪，拿到 undefined 就静默 return，页面永远不出现。
     * remote.settings —— 读写配置的服务，名字带点，照 DSH 的命名空间原样写。
     */
    const inject = ['slots', 'remote.settings']

    function apply(ctx) {
      try {
        activeCtx = ctx
        const slots = ctx.slots
        if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return

        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 34,
          label: () => '灵魂记忆',
          inject: () => ({}),
        }, SoulSettingsPage))
      } catch (error) {
        // 不吞：让它在「设置 → 插件 → 插件列表」里显形，而不是无声消失。
        console.error('[dsh-soul] 设置页注册失败', error)
        throw error
      }
    }

    return { name: 'dsh-soul', apply, inject }
  },
})
