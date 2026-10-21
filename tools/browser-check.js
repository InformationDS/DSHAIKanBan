/**
 * AIKanBan 页面内自检（可直接粘贴到浏览器 DevTools Console 的脚本）
 *
 * ## 用法
 *
 * 1. 打开正在运行的 DSH GUI 页面（真实 profile，不是隔离探针）；
 * 2. 按 F12（或 Ctrl+Shift+I）打开 DevTools，切到 **Console**；
 * 3. 把本文件**整段**复制、粘贴到 Console，回车；
 * 4. 把从 `AIKanBan 页面内自检` 首行到末行 `BROWSER-CHECK RESULT: ...` 的输出整段复制走；
 *    末行是**不带工具前缀**的 `BROWSER-CHECK RESULT: PASS|FAIL`，便于机器判读。
 * 5. 页面刷新或重装插件后重跑；脚本每次都会重新读取项目清单与看板。
 *
 * 本文件同时被版本管理（`tools/browser-check.js`），粘贴的是同一份文本；
 * 它**不需要构建、不依赖任何 npm 包**，只使用页面的 `window` / `document` / `fetch`。
 *
 * ## 它证明了什么
 *
 * - 当前真实 GUI 页面里，由页面 `fetch` 发出的 `POST /aikanban/<endpoint>`（与浏览器半
 *   完全相同的 URL 与信封）带着页面自身的登录 cookie，得到 **HTTP 200**；
 * - 响应是合法的 `{type:'server-response', rpcId, result}` 信封，`rpcId` 回显，`result.ok === true`；
 * - `project/list` 的候选集、`board/read` 的看板快照**逐字段**满足
 *   `packages/plugin-client/src/wire.ts` 的 `parseProjectListValue` / `parseBoardSnapshotValue`
 *   （字段级校验，不重建值）；另有一条**端点级附加断言**：`board/read` 的
 *   `project.projectId` 必须等于请求里的 `projectId`——这不是 wire 解析器的要求，
 *   而是端点语义（与 `tools/verify-rpc-roundtrip.mjs` 的 POS-6 一致）；
 * - 页面 DOM 里看板面板是否已渲染；未渲染时明确报「面板未渲染」，**不**记为失败。
 *
 * ## 它不证明什么（不得据此扩大结论）
 *
 * - **不**证明打包后的浏览器半代码（`channel-source.ts` 里的 `ctx.connection.rpc.call` 适配器）
 *   真的执行了：本脚本直接调用页面全局 `fetch`，只保证「同一页面会话 + 同一 wire」的请求/响应；
 * - **不**证明真实 profile 的装载链（bundle 层解析、`dsh.client` 装配、slot 注册）：只证明当前
 *   页面发布了该插件的 `window.__DSH_BOOT__` 行；
 * - **不**证明三个写端点（`task/status.set`、`task/reorder`、`task/status.undo`）；
 * - **不**证明看板交互语义（拖拽、撤销、成对确认），也**不**构成任何 AT 的验收证据
 *   （`acceptance.csv` 全部仍为「待执行」）。
 *
 * ## 信封来源（照抄，不发明第二套）
 *
 * - 请求信封 `{type:'client-request', rpcId, method, payload}`、端点等于 URL 末段、
 *   `POST` + `content-type: application/json`：DSH `@deepseek-ai/dsh-client-connection` 的
 *   Connection RPC 契约（见 ADR-005；真实往返见 `tools/verify-rpc-roundtrip.mjs`）；
 * - payload：`project/list` = `{}`、`board/read` = `{projectId}`，对应 `wire.ts` 的
 *   `parseProjectListPayload` / `parseReadBoardPayload`；
 * - 响应 value：下面的 `validateProjectListValue` / `validateBoardSnapshotValue` 与
 *   `wire.ts` 的 `parseProjectListValue` / `parseBoardSnapshotValue`（含 `parseBoardTask`、
 *   `parseColumn`、`parseCapabilities`、`parseUndoTarget`、`ver1:<n>` 语法）逐条一致。
 *
 * ## 安全
 *
 * - 不读取、不打印 cookie 与 token（输出前统一把 `token=…` 脱敏）；
 * - 请求沿用页面自身的登录状态（页面 `fetch` 自动带 cookie），不新建会话、不读 storage；
 * - 只输出插件 boot 行、`projectId`、任务数、列状态、`boardToken` 前缀这类定位信息，
 *   不输出项目标题/本地路径等其余内容。
 */
;(function aikanbanBrowserCheck() {
  'use strict'

  /* ------------------------------------------------------------------ *
   * 常量（与 packages/plugin-client/src/wire.ts 及 DSH 连接契约一致）
   * ------------------------------------------------------------------ */

  const PLUGIN_ID = '@aikanban/dsh-aikanban'
  const CHANNEL = '/aikanban'
  const ENDPOINT_PROJECT_LIST = 'project/list'
  const ENDPOINT_BOARD_READ = 'board/read'

  /** `wire.ts` 的 status version 语法。 */
  const STATUS_VERSION_PREFIX = 'ver1:'
  const STATUS_VERSION_PATTERN = /^ver1:(0|[1-9]\d*)$/

  /** `wire.ts` 列出的 8 个失败码；只用于把 `result.ok=false` 读得更清楚，不改变判定。 */
  const KNOWN_FAILURE_CODES = [
    'invalid-reason', 'not-found', 'save-failed', 'stale-baseline',
    'unknown-result', 'read-failed', 'unknown-project', 'unavailable',
  ]

  /** 看板面板/座位的 DOM 标记（来自 packages/plugin-client/src/*.tsx）。 */
  const PANEL_SELECTOR = '[data-aikanban-panel="aikanban"]'
  const SELECTION_SELECTOR = '[data-aikanban-selection-required="true"]'
  const PROJECT_LIST_SELECTOR = '[data-aikanban-project-list="true"]'
  const COLUMN_SELECTOR = '[data-aikanban-column]'
  const PALETTE_SELECTOR = '[data-aikanban-palette="aikanban"]'

  /** 面板文本线索（选择态标题 + core 的五列标签 + 读取态）。 */
  const PANEL_TEXT_HINTS = ['请选择项目', '未开始', '进行中', '已阻塞', '已完成', '已取消', '正在读取看板']

  /**
   * 只有这些短语足以在**整页文本**里单独证明「看板面板在页面上」；
   * 看板列标签在对话正文里也会出现，不能单独当证据。
   */
  const PANEL_STATE_HINTS = ['请选择项目', '正在读取看板']

  /**
   * 延迟就绪（服务晚绑定）时 `project/list` 可能先返回 `unavailable`；
   * 与 `tools/verify-rpc-roundtrip.mjs` 的做法一致，做有限次轮询后如实报告尝试次数。
   */
  const LIST_ATTEMPTS = 10
  const LIST_RETRY_MS = 500

  /* ------------------------------------------------------------------ *
   * 输出与记录
   * ------------------------------------------------------------------ */

  const root = typeof window !== 'undefined' ? window : globalThis
  const doc = typeof document !== 'undefined' ? document : null
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  /** @type {{ id: string, status: string, name: string, expected: string, actual: string }[]} */
  const checks = []

  const log = (line = '') => { console.log(`[browser-check] ${line}`) }
  const messageOf = (error) => (error instanceof Error ? error.message : String(error))

  /**
   * 输出前脱敏：任何 `token=…` 都替换掉；请求本身不带 token（只有 cookie，脚本从不读取）。
   *
   * @param {unknown} value - 任意待输出值。
   * @returns {string} 脱敏后的文本。
   */
  function redact(value) {
    // 只命中查询串里的鉴权 token（`?token=` / `&token=`），不要误伤 `boardToken=` 这类字段。
    return String(value).replace(/(^|[?&\s])token=[^&\s]+/gi, '$1token=<redacted>')
  }

  /**
   * 截断长文本。
   *
   * @param {unknown} value - 待截断的值。
   * @param {number} max - 最大字符数。
   * @returns {string} 截断后的字符串。
   */
  function clip(value, max) {
    const text = String(value)
    return text.length <= max ? text : `${text.slice(0, max)}…`
  }

  /**
   * 记录并打印一条检查项。
   *
   * @param {object} entry - 检查项。
   * @param {string} entry.id - 稳定 id（B1—B4）。
   * @param {string} entry.name - 人类可读的检查名。
   * @param {string} entry.expected - 期望。
   * @param {string} entry.actual - 实际观察。
   * @param {'PASS'|'FAIL'|'NOT-RUN'|'NOT-MOUNTED'} entry.status - 结论。
   */
  function report({ id, name, expected, actual, status }) {
    checks.push({ id, status, name, expected, actual })
    log('')
    log(`[${id}] ${status}  ${name}`)
    log(`  expected: ${redact(expected)}`)
    log(`  actual:   ${redact(actual)}`)
  }

  /* ------------------------------------------------------------------ *
   * wire.ts 的字段级校验器（判定条件逐条照抄；不重建值，只回答“是否合法”）
   * ------------------------------------------------------------------ */

  const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  const isString = (value) => typeof value === 'string'
  const isOptionalString = (value) => value === undefined || typeof value === 'string'
  const isStatusId = (value) => typeof value === 'string' && value.length > 0
  const isOptionalBoolean = (value) => value === undefined || typeof value === 'boolean'
  const isOptionalFiniteNumber = (value) => value === undefined || (typeof value === 'number' && Number.isFinite(value))

  /**
   * `wire.ts` 的 `parseStatusVersion`：只接受 `ver1:0` 或 `ver1:<非零开头十进制>`。
   *
   * @param {unknown} value - 待检查值。
   * @returns {number|null} 版本号或 null。
   */
  function parseStatusVersion(value) {
    if (typeof value !== 'string' || !STATUS_VERSION_PATTERN.test(value)) return null
    return Number(value.slice(STATUS_VERSION_PREFIX.length))
  }

  /**
   * `wire.ts` 的 `parseUndoTarget`：必填、可为 null；非 null 时两个字段都要合法。
   *
   * @param {unknown} value - 待检查值。
   * @returns {boolean} 是否合法。
   */
  function isValidUndoTarget(value) {
    if (value === undefined) return false
    if (value === null) return true
    if (!isRecord(value)) return false
    if (!isString(value['statusVersion']) || !isString(value['appliedUpdateId'])) return false
    if (parseStatusVersion(value['statusVersion']) === null) return false
    return value['appliedUpdateId'].length > 0
  }

  /**
   * `wire.ts` 的 `parseSummaryProgress`：undefined 合法；null 合法；对象必须三字段字符串。
   *
   * @param {unknown} value - 待检查值。
   * @returns {boolean} 是否合法。
   */
  function isValidSummaryProgress(value) {
    if (value === undefined) return true
    if (value === null) return true
    if (!isRecord(value)) return false
    return isString(value['line']) && isString(value['versionId']) && isString(value['confirmedAt'])
  }

  /**
   * `wire.ts` 的 `parseHints`：undefined 合法；数组时每项 `{kind:'attention'|'info', text:string}`。
   *
   * @param {unknown} value - 待检查值。
   * @returns {boolean} 是否合法。
   */
  function isValidHints(value) {
    if (value === undefined) return true
    if (!Array.isArray(value)) return false
    return value.every((entry) => isRecord(entry)
      && (entry['kind'] === 'attention' || entry['kind'] === 'info')
      && isString(entry['text']))
  }

  /**
   * `wire.ts` 的 `parseRecheckCodes`：undefined 合法；数组时每项字符串。
   *
   * @param {unknown} value - 待检查值。
   * @returns {boolean} 是否合法。
   */
  function isValidRecheckCodes(value) {
    if (value === undefined) return true
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  }

  /**
   * `wire.ts` 的 `parseBoardTask`：必填 `statusRevision`/`undoTarget`，其余按可选字段收紧。
   *
   * @param {unknown} value - 待检查值。
   * @returns {boolean} 是否合法。
   */
  function isValidBoardTask(value) {
    if (!isRecord(value)) return false
    const { taskId, projectId, title, goal, status, order } = value
    if (!isString(taskId) || !isString(projectId) || !isString(title) || !isString(goal)) return false
    if (!isStatusId(status)) return false
    if (typeof order !== 'number' || !Number.isFinite(order)) return false
    if (!isOptionalString(value['statusLabel'])) return false
    if (!isOptionalString(value['blockedReason'])) return false
    if (!isOptionalBoolean(value['archived'])) return false
    if (!isOptionalFiniteNumber(value['fieldsRevision'])) return false
    const statusRevision = value['statusRevision']
    if (typeof statusRevision !== 'number' || !Number.isInteger(statusRevision) || statusRevision < 0) return false
    if (!isValidUndoTarget(value['undoTarget'])) return false
    if (!isOptionalBoolean(value['hasSummary'])) return false
    if (!isOptionalBoolean(value['hasRecord'])) return false
    if (!isOptionalBoolean(value['needsRecheck'])) return false
    if (!isValidSummaryProgress(value['summaryProgress'])) return false
    if (!isValidHints(value['hints'])) return false
    return isValidRecheckCodes(value['recheckCodes'])
  }

  /**
   * `wire.ts` 的 `parseCapabilities`：三个字段都必须是布尔。
   *
   * @param {unknown} value - 待检查值。
   * @returns {boolean} 是否合法。
   */
  function isValidCapabilities(value) {
    if (!isRecord(value)) return false
    return typeof value['statusChange'] === 'boolean'
      && typeof value['reorder'] === 'boolean'
      && typeof value['undo'] === 'boolean'
  }

  /**
   * `wire.ts` 的 `parseColumn`：status 必填；label/collapsedByDefault/tasks 可选但类型必须对。
   *
   * @param {unknown} value - 待检查值。
   * @returns {boolean} 是否合法。
   */
  function isValidColumn(value) {
    if (!isRecord(value)) return false
    if (!isStatusId(value['status'])) return false
    if (!isOptionalString(value['label'])) return false
    if (!isOptionalBoolean(value['collapsedByDefault'])) return false
    if (value['tasks'] === undefined) return true
    if (!Array.isArray(value['tasks'])) return false
    return value['tasks'].every((task) => isValidBoardTask(task))
  }

  /**
   * `wire.ts` 的 `parseBoardSnapshotValue` 的判定条件。
   *
   * @param {unknown} value - 生成的信封里的 `result.value`。
   * @returns {{ ok: boolean, issue: string|null }} 判定结果与首个不满足的字段。
   */
  function validateBoardSnapshotValue(value) {
    if (!isRecord(value)) return { ok: false, issue: 'value 不是对象' }
    const project = value['project']
    if (!isRecord(project)) return { ok: false, issue: 'project 不是对象' }
    if (!isString(project['projectId']) || !isString(project['title'])) return { ok: false, issue: 'project.projectId/title 不是字符串' }
    const availability = project['workScopeAvailability']
    if (availability !== 'ok' && availability !== 'missing-dir' && availability !== 'unknown') {
      return { ok: false, issue: `project.workScopeAvailability=${JSON.stringify(availability)} 不在 ok/missing-dir/unknown 内` }
    }
    if (typeof project['workScopeAllowed'] !== 'boolean') return { ok: false, issue: 'project.workScopeAllowed 不是布尔' }
    if (!isOptionalString(project['path'])) return { ok: false, issue: 'project.path 不是字符串' }
    if (!isOptionalString(project['workScopeReason'])) return { ok: false, issue: 'project.workScopeReason 不是字符串' }

    if (!Array.isArray(value['tasks'])) return { ok: false, issue: 'tasks 不是数组' }
    for (let index = 0; index < value['tasks'].length; index += 1) {
      if (!isValidBoardTask(value['tasks'][index])) return { ok: false, issue: `tasks[${String(index)}] 不满足 parseBoardTask` }
    }

    if (!isString(value['boardToken'])) return { ok: false, issue: 'boardToken 不是字符串' }
    if (!isValidCapabilities(value['capabilities'])) return { ok: false, issue: 'capabilities 不是 {statusChange,reorder,undo:boolean}' }

    if (!Array.isArray(value['columns'])) return { ok: false, issue: 'columns 不是数组' }
    for (let index = 0; index < value['columns'].length; index += 1) {
      if (!isValidColumn(value['columns'][index])) return { ok: false, issue: `columns[${String(index)}] 不满足 parseColumn` }
    }
    return { ok: true, issue: null }
  }

  /**
   * `wire.ts` 的 `parseProjectListValue` 的判定条件。
   *
   * @param {unknown} value - 信封里的 `result.value`。
   * @returns {{ ok: boolean, issue: string|null }} 判定结果与首个不满足的字段。
   */
  function validateProjectListValue(value) {
    if (!isRecord(value)) return { ok: false, issue: 'value 不是对象' }
    if (!Array.isArray(value['projects'])) return { ok: false, issue: 'value.projects 不是数组' }
    for (let index = 0; index < value['projects'].length; index += 1) {
      const entry = value['projects'][index]
      if (!isRecord(entry)) return { ok: false, issue: `projects[${String(index)}] 不是对象` }
      if (!isString(entry['projectId']) || entry['projectId'].length === 0) return { ok: false, issue: `projects[${String(index)}].projectId 不是非空字符串` }
      if (!isString(entry['title'])) return { ok: false, issue: `projects[${String(index)}].title 不是字符串` }
      if (!isString(entry['path'])) return { ok: false, issue: `projects[${String(index)}].path 不是字符串` }
    }
    return { ok: true, issue: null }
  }

  /* ------------------------------------------------------------------ *
   * HTTP（页面内 fetch：自动带 cookie、自动带同源 Origin）
   * ------------------------------------------------------------------ */

  /**
   * 发一个真实的 Connection RPC 请求。
   *
   * @param {string} endpoint - 端点名，如 `project/list`。
   * @param {unknown} payload - 端点 payload。
   * @returns {Promise<{ rpcId: string, status: number|null, contentType: string, text: string, error: string|null }>} 原始响应。
   */
  async function callRpc(endpoint, payload) {
    const rpcId = `browser-check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
    let response
    try {
      response = await fetch(`${CHANNEL}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'same-origin',
      })
    } catch (error) {
      return { rpcId, status: null, contentType: '', text: '', error: messageOf(error) }
    }
    let text = ''
    try {
      text = await response.text()
    } catch (error) {
      return { rpcId, status: response.status, contentType: response.headers.get('content-type') ?? '', text: '', error: `读取响应体失败：${messageOf(error)}` }
    }
    return {
      rpcId,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text,
      error: null,
    }
  }

  /**
   * 校验信封：`{type:'server-response', rpcId, result}`、`rpcId` 回显、`result` 形状。
   * 判定与 `tools/verify-rpc-roundtrip.mjs` 的 `parseEnvelope` 一致。
   *
   * @param {{ rpcId: string, status: number|null, text: string, error: string|null }} call - 一次调用。
   * @returns {{ parsed: Record<string, unknown>|null, result: Record<string, unknown>|null, issues: string[] }} 校验结果。
   */
  function evaluateEnvelope(call) {
    const issues = []
    if (call.error !== null) {
      issues.push(`请求未完成：${clip(call.error, 120)}`)
      return { parsed: null, result: null, issues }
    }
    if (call.status !== 200) issues.push(`HTTP ${String(call.status)}`)
    let parsed = null
    try {
      parsed = JSON.parse(call.text)
    } catch {
      issues.push(`响应体不是 JSON（${String(call.text.length)} 字节）`)
      return { parsed: null, result: null, issues }
    }
    if (!isRecord(parsed)) {
      issues.push('响应体不是 JSON 对象')
      return { parsed: null, result: null, issues }
    }
    if (parsed['type'] !== 'server-response') issues.push(`type=${JSON.stringify(parsed['type'])}（期望 'server-response'）`)
    if (!isString(parsed['rpcId'])) issues.push('rpcId 不是字符串')
    else if (parsed['rpcId'] !== call.rpcId) issues.push('rpcId 未回显请求值')
    const result = parsed['result']
    if (!isRecord(result)) {
      issues.push('result 不是对象')
      return { parsed, result: null, issues }
    }
    if (result['ok'] === true) {
      if (!Object.prototype.hasOwnProperty.call(result, 'value')) issues.push('result.ok=true 但未携带 value')
    } else if (result['ok'] === false) {
      const error = result['error']
      if (!isRecord(error)) {
        issues.push('result.ok=false 但 result.error 不是对象')
      } else {
        if (!isString(error['code'])) issues.push('result.error.code 不是字符串')
        if (!isString(error['message'])) issues.push('result.error.message 不是字符串')
        if (!isRecord(error['details'])) issues.push('result.error.details 不是对象')
        const code = isString(error['code']) ? error['code'] : '（无 code）'
        const known = KNOWN_FAILURE_CODES.includes(code) ? '' : '（不在 8 码内）'
        const message = isString(error['message']) ? `，message=${clip(error['message'], 80)}` : ''
        issues.push(`result.ok=false：code=${code}${known}${message}`)
      }
    } else {
      issues.push('result.ok 不是布尔值')
    }
    return { parsed, result, issues }
  }

  /* ------------------------------------------------------------------ *
   * 检查 1：window.__DSH_BOOT__ 里的插件行
   * ------------------------------------------------------------------ */

  /**
   * 断言 `window.__DSH_BOOT__.entries` 中存在本插件的行，并读出 entry/rev。
   * 只打印 `id`/`url`/`rev`，不解引用其余字段（不打印任何 payload/token）。
   */
  function checkBootRow() {
    const id = 'B1'
    const name = 'window.__DSH_BOOT__ 含 @aikanban/dsh-aikanban 行'
    const expected = 'entries[] 中存在 id=\'@aikanban/dsh-aikanban\' 的行；打印该行 entry/rev'
    const boot = root.__DSH_BOOT__
    if (!isRecord(boot)) {
      report({ id, name, expected, actual: 'window.__DSH_BOOT__ 不存在（当前页面不是 DSH 应用壳，或脚本粘到了错误的 frame）', status: 'FAIL' })
      return
    }
    const entries = boot['entries']
    if (!Array.isArray(entries)) {
      report({ id, name, expected, actual: `window.__DSH_BOOT__.entries 不是数组（typeof=${typeof entries}）`, status: 'FAIL' })
      return
    }
    const row = entries.find((entry) => isRecord(entry) && entry['id'] === PLUGIN_ID)
    const graphRev = isString(boot['rev']) ? boot['rev'] : String(boot['rev'])
    if (row === undefined) {
      report({ id, name, expected, actual: `entries=${String(entries.length)}，未找到 id=${PLUGIN_ID}（插件未安装或未成为 profile bundle 层）`, status: 'FAIL' })
      return
    }
    const entryUrl = isString(row['url']) ? redact(row['url']) : '（entry.url 缺失）'
    // boot 行的权威 rev 是 row.rev（dsh-client-modules 的 boot 行契约）；URL 查询串只作兜底。
    const urlRev = /[?&]rev=([^&]+)/.exec(entryUrl)
    const entryRev = isString(row['rev']) ? row['rev'] : (urlRev === null ? null : urlRev[1])
    report({
      id,
      name,
      expected,
      actual: `graph.rev=${graphRev}，entries=${String(entries.length)}，entry.id=${PLUGIN_ID}，entry.url=${clip(entryUrl, 160)}${entryRev === null ? '' : `，entry.rev=${entryRev}`}`,
      status: 'PASS',
    })
  }

  /* ------------------------------------------------------------------ *
   * 检查 2：project/list（页面内真实 HTTP）
   * ------------------------------------------------------------------ */

  /**
   * 发 `project/list`，断言 200 + 合法信封 + `result.ok===true` + 候选集字段合法。
   * 对 `unavailable`（服务晚绑定）做有限次轮询，并如实报告尝试次数。
   *
   * @returns {Promise<{ ok: boolean, projects: { projectId: string }[]|null }>} 供 board/read 使用的结果。
   */
  async function checkProjectList() {
    const id = 'B2'
    const name = '页面内 POST /aikanban/project/list → 200 + 合法信封 + result.ok=true'
    const expected = "HTTP 200；{type:'server-response', rpcId:<回显>, result:{ok:true, value:{projects:[{projectId, title, path}]}}}"
    let call = null
    let envelope = null
    let attempts = 0
    for (let index = 0; index < LIST_ATTEMPTS; index += 1) {
      attempts += 1
      call = await callRpc(ENDPOINT_PROJECT_LIST, {})
      envelope = evaluateEnvelope(call)
      const failedCode = envelope.result !== null && envelope.result['ok'] === false && isRecord(envelope.result['error'])
        ? envelope.result['error']['code']
        : null
      if (failedCode !== 'unavailable') break
      if (index < LIST_ATTEMPTS - 1) await sleep(LIST_RETRY_MS)
    }
    const issues = envelope === null ? ['未发起请求'] : envelope.issues.slice()
    let projects = null
    if (envelope !== null && envelope.result !== null && envelope.result['ok'] === true) {
      const validation = validateProjectListValue(envelope.result['value'])
      if (!validation.ok) issues.push(`value 不满足 wire.ts parseProjectListValue：${validation.issue}`)
      else projects = envelope.result['value']['projects']
    }
    if (issues.length > 0) {
      report({
        id,
        name,
        expected,
        actual: `HTTP ${String(call === null ? '—' : call.status)}，尝试 ${String(attempts)} 次；${issues.join('；')}`,
        status: 'FAIL',
      })
      return { ok: false, projects: null }
    }
    const firstProjectId = projects !== null && projects.length > 0 ? projects[0]['projectId'] : null
    report({
      id,
      name,
      expected,
      actual: `HTTP 200，尝试 ${String(attempts)} 次，rpcId 回显=true，result.ok=true，projects=${String(projects === null ? 0 : projects.length)}，首个 projectId=${firstProjectId === null ? '（空集，合法）' : firstProjectId}`,
      status: 'PASS',
    })
    return { ok: true, projects }
  }

  /* ------------------------------------------------------------------ *
   * 检查 3：board/read（用 B2 的 projectId，页面内真实 HTTP）
   * ------------------------------------------------------------------ */

  /**
   * 用显式选择的 projectId 发 `board/read`，断言 200 + 信封 + 快照字段。
   *
   * @param {{ projectId: string }|null} selectedProject - B2 的首个项目，空集时为 null。
   * @returns {Promise<void>}
   */
  async function checkBoardRead(selectedProject) {
    const id = 'B3'
    const name = '页面内 POST /aikanban/board/read（显式 projectId）→ 200 + 快照'
    const expected = 'HTTP 200；信封合法（rpcId 回显、result.ok=true）；value 满足 wire.ts parseBoardSnapshotValue'
    if (selectedProject === null) {
      report({ id, name, expected, actual: '未执行：project/list 未通过，或候选集为空（合法空集），没有可显式选择的项目', status: 'NOT-RUN' })
      return
    }
    const projectId = selectedProject.projectId
    const call = await callRpc(ENDPOINT_BOARD_READ, { projectId })
    const envelope = evaluateEnvelope(call)
    const issues = envelope.issues.slice()
    let summary = ''
    if (envelope.result !== null && envelope.result['ok'] === true) {
      const value = envelope.result['value']
      const validation = validateBoardSnapshotValue(value)
      if (!validation.ok) issues.push(`value 不满足 wire.ts parseBoardSnapshotValue：${validation.issue}`)
      else {
        const project = value['project']
        // 端点位附加断言（不属于 wire.ts 解析器）：响应必须对应请求的 projectId。
        if (project['projectId'] !== projectId) issues.push(`project.projectId 与请求的 projectId 不一致（请求=${projectId}）`)
        const tasks = value['tasks']
        const columns = value['columns']
        const columnText = columns.map((column) => `${String(column['status'])}:${String(column['label'] ?? '')}`).join(', ')
        const capabilities = value['capabilities']
        summary = `project=${String(project['projectId'])}，tasks=${String(tasks.length)}，columns=[${columnText}]，boardToken=${clip(String(value['boardToken']), 12)}…，capabilities=${JSON.stringify(capabilities)}`
      }
    }
    if (issues.length > 0) {
      report({ id, name, expected, actual: `HTTP ${String(call.status)}；${issues.join('；')}`, status: 'FAIL' })
      return
    }
    report({ id, name, expected, actual: `HTTP 200，rpcId 回显=true，result.ok=true，${summary}`, status: 'PASS' })
    return
  }

  /* ------------------------------------------------------------------ *
   * 检查 4：DOM 面板自检
   * ------------------------------------------------------------------ */

  /**
   * 读取元素的可见文本（优先 innerText，回退 textContent），压缩空白。
   *
   * @param {Element|null} element - 目标元素。
   * @returns {string} 归一化后的文本。
   */
  function elementText(element) {
    if (element === null || element === undefined) return ''
    const text = typeof element.innerText === 'string' ? element.innerText : element.textContent
    return String(text ?? '').replace(/\s+/g, ' ').trim()
  }

  /**
   * 在文本里找第一个看板面板线索。
   *
   * @param {string} text - 待搜索文本。
   * @returns {string|null} 命中的线索。
   */
  function firstPanelHint(text) {
    const hit = PANEL_TEXT_HINTS.find((hint) => text.includes(hint))
    return hit === undefined ? null : hit
  }

  /**
   * 断言页面里存在看板面板；未渲染时明确报「面板未渲染」而不是失败。
   * 记录选择器与命中文本（只记录固定的标签/线索，不倾倒面板内容）。
   */
  function checkDomPanel() {
    const id = 'B4'
    const name = '页面 DOM 中存在看板面板（或明确报「面板未渲染」）'
    const expected = `命中 ${PANEL_SELECTOR}、看板列/选择态标记或「请选择项目」等面板文本；未渲染不算失败`
    if (doc === null || typeof doc.querySelector !== 'function') {
      report({ id, name, expected, actual: '面板未渲染：当前环境没有 document（不在页面里运行）', status: 'NOT-MOUNTED' })
      return
    }
    const selectorCandidates = [
      { selector: PANEL_SELECTOR, label: '看板面板根节点 data-aikanban-panel' },
      { selector: SELECTION_SELECTOR, label: '「请选择项目」选择态 data-aikanban-selection-required' },
      { selector: PROJECT_LIST_SELECTOR, label: '项目清单 data-aikanban-project-list' },
      { selector: COLUMN_SELECTOR, label: '看板列 data-aikanban-column' },
    ]
    for (const candidate of selectorCandidates) {
      const element = doc.querySelector(candidate.selector)
      if (element === null) continue
      const text = elementText(element)
      const hint = firstPanelHint(text)
      const matched = hint === null ? `无固定线索文本，元素文本前 60 字：${clip(text, 60)}` : `命中文本「${hint}」`
      report({
        id,
        name,
        expected,
        actual: `面板已渲染：selector=${candidate.selector}（${candidate.label}），${matched}`,
        status: 'PASS',
      })
      return
    }
    // 没有可靠的 aikanban 选择器时，只接受「面板专属状态文本」作为兜底证据。
    // 看板列标签（未开始/进行中/…）在对话正文里也会出现，单独出现不判为已渲染。
    const bodyText = doc.body === null || doc.body === undefined ? '' : elementText(doc.body)
    const bodyStateHint = PANEL_STATE_HINTS.find((hint) => bodyText.includes(hint)) ?? null
    if (bodyStateHint !== null) {
      report({
        id,
        name,
        expected,
        actual: `面板已渲染：selector=document.body（文本兜底命中面板状态文本「${bodyStateHint}」）`,
        status: 'PASS',
      })
      return
    }
    const bodyLabelHint = firstPanelHint(bodyText)
    const palette = typeof doc.querySelector === 'function' ? doc.querySelector(PALETTE_SELECTOR) : null
    if (palette !== null) {
      report({
        id,
        name,
        expected,
        actual: `面板未渲染：插件已挂载（命中侧栏图标 ${PALETTE_SELECTOR}），但看板面板未打开/未渲染；这不是失败`,
        status: 'NOT-MOUNTED',
      })
      return
    }
    report({
      id,
      name,
      expected,
      actual: bodyLabelHint === null
        ? '面板未渲染：未命中任何 aikanban DOM 标记或面板状态文本（插件可能未安装/未装配，或面板未打开，或当前不是 GUI 主页面）；这不是失败'
        : `面板未渲染：页面正文出现「${bodyLabelHint}」字样但没有 aikanban 面板标记（可能来自对话内容，不判为已渲染）；这不是失败`,
      status: 'NOT-MOUNTED',
    })
  }

  /* ------------------------------------------------------------------ *
   * 汇总
   * ------------------------------------------------------------------ */

  function summarize() {
    const passed = checks.filter((check) => check.status === 'PASS').length
    const failed = checks.filter((check) => check.status === 'FAIL')
    const notRun = checks.filter((check) => check.status === 'NOT-RUN' || check.status === 'NOT-MOUNTED')
    log('')
    log('[5/5] 汇总')
    log(`  总检查项: ${String(checks.length)}`)
    log(`  PASS ${String(passed)}/${String(checks.length)}`)
    if (failed.length > 0) log(`  FAIL 项: ${failed.map((check) => check.id).join(', ')}`)
    if (notRun.length > 0) log(`  未执行/未渲染（不计失败）: ${notRun.map((check) => `${check.id}=${check.status}`).join(', ')}`)
    log('')
    // 最后一行恰为结果行（不带工具前缀），便于复制与机器判读；NOT-RUN / NOT-MOUNTED 不计失败。
    console.log(`BROWSER-CHECK RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  }

  /* ------------------------------------------------------------------ *
   * Main
   * ------------------------------------------------------------------ */

  async function main() {
    log('AIKanBan 页面内自检 (tools/browser-check.js)')
    log(`  channel:     ${CHANNEL}`)
    log(`  plugin:      ${PLUGIN_ID}`)
    log(`  page origin: ${typeof root.location === 'object' && root.location !== null ? String(root.location.origin) : '（未知）'}`)
    log('  说明: 请求走页面自身 fetch（自动带 cookie、同源 Origin）；不读取/不打印 cookie 与 token')
    log('')

    log('[1/5] 读取 window.__DSH_BOOT__，查找插件行')
    checkBootRow()

    log('')
    log('[2/5] 页面内真实 HTTP：project/list')
    const list = await checkProjectList()

    log('')
    log('[3/5] 页面内真实 HTTP：board/read')
    const selected = list.ok && list.projects !== null && list.projects.length > 0 ? list.projects[0] : null
    await checkBoardRead(selected)

    log('')
    log('[4/5] DOM：看板面板是否已渲染')
    checkDomPanel()

    summarize()
  }

  main().catch((error) => {
    log('')
    log(`  未预期错误：${clip(messageOf(error), 200)}`)
    log('')
    console.log('BROWSER-CHECK RESULT: FAIL')
  })
})()
