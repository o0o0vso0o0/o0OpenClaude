/**
 * AI Cursor — estimate context composition from OpenClaude session jsonl,
 * and package billed usage into a UI-friendly breakdown.
 */
import fs from 'fs'

const CATEGORY_ORDER = [
  'user_text',
  'user_image',
  'assistant_text',
  'assistant_thinking',
  'tool_call',
  'tool_result',
  'system_meta',
  'other',
]

const CATEGORY_LABELS = {
  user_text: '用户文字',
  user_image: '用户图片',
  assistant_text: '助手文字',
  assistant_thinking: '助手思考',
  tool_call: '工具调用',
  tool_result: '工具结果',
  system_meta: '系统/元数据',
  other: '其他',
}

/// <summary> AI Cursor </summary>
function roughTextTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  // Mixed CJK / ASCII heuristic (~ OpenClaude roughTokenCountEstimation spirit).
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f)
    )
      cjk++
    else other++
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4))
}

/// <summary> AI Cursor </summary>
function roughImageTokens(mediaType, data) {
  const raw = String(data || '').replace(/^data:[^;]+;base64,/, '')
  if (!raw) return 0
  const bytes = Math.floor((raw.length * 3) / 4)
  // Vision models bill images in tile-ish chunks; keep a conservative floor.
  return Math.max(85, Math.round(bytes / 750))
}

/// <summary> AI Cursor </summary>
function add(bucket, key, tokens, count = 1) {
  if (!tokens || tokens <= 0) return
  if (!bucket[key]) bucket[key] = { tokens: 0, count: 0 }
  bucket[key].tokens += tokens
  bucket[key].count += count
}

/// <summary> AI Cursor </summary>
function scoreContentBlocks(content, role, bucket) {
  if (typeof content === 'string') {
    if (role === 'user') add(bucket, 'user_text', roughTextTokens(content))
    else if (role === 'assistant')
      add(bucket, 'assistant_text', roughTextTokens(content))
    else add(bucket, 'other', roughTextTokens(content))
    return
  }
  if (!Array.isArray(content)) {
    if (content != null)
      add(bucket, 'other', roughTextTokens(JSON.stringify(content)))
    return
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (role === 'user') add(bucket, 'user_text', roughTextTokens(block.text))
        else if (role === 'assistant')
          add(bucket, 'assistant_text', roughTextTokens(block.text))
        else add(bucket, 'system_meta', roughTextTokens(block.text))
        break
      case 'thinking':
        add(bucket, 'assistant_thinking', roughTextTokens(block.thinking || block.data))
        break
      case 'image': {
        const src = block.source || {}
        add(
          bucket,
          'user_image',
          roughImageTokens(src.media_type || src.mediaType, src.data),
        )
        break
      }
      case 'tool_use':
        add(
          bucket,
          'tool_call',
          roughTextTokens(
            `${block.name || ''}\n${JSON.stringify(block.input ?? {})}`,
          ),
        )
        break
      case 'tool_result': {
        const c = block.content
        const text =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c
                  .map(b =>
                    typeof b === 'string'
                      ? b
                      : b?.type === 'text'
                        ? b.text || ''
                        : b?.type === 'image'
                          ? '[image]'
                          : JSON.stringify(b ?? ''),
                  )
                  .join('\n')
              : JSON.stringify(c ?? '')
        add(bucket, 'tool_result', roughTextTokens(text))
        break
      }
      case 'image_url':
        add(bucket, 'user_image', roughImageTokens('', block.image_url?.url || ''))
        break
      default:
        add(bucket, 'other', roughTextTokens(JSON.stringify(block)))
    }
  }
}

/// <summary> AI Cursor </summary>
export function analyzeSessionJsonl(jsonlPath) {
  const bucket = {}
  let lines = 0
  let messages = 0
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    return {
      ok: false,
      estimatedTotal: 0,
      categories: [],
      lines: 0,
      messages: 0,
    }
  }

  let raw = ''
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8')
  } catch {
    return {
      ok: false,
      estimatedTotal: 0,
      categories: [],
      lines: 0,
      messages: 0,
    }
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    lines++
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const type = row?.type
    if (type !== 'user' && type !== 'assistant') continue
    messages++
    const role = row?.message?.role || (type === 'user' ? 'user' : 'assistant')
    scoreContentBlocks(row?.message?.content, role, bucket)
  }

  const estimatedTotal = Object.values(bucket).reduce(
    (s, v) => s + (v.tokens || 0),
    0,
  )
  const categories = CATEGORY_ORDER.filter(id => bucket[id]?.tokens > 0).map(
    id => {
      const tokens = bucket[id].tokens
      return {
        id,
        label: CATEGORY_LABELS[id] || id,
        tokens,
        count: bucket[id].count,
        share:
          estimatedTotal > 0
            ? Math.round((tokens / estimatedTotal) * 1000) / 10
            : 0,
      }
    },
  )

  return {
    ok: true,
    estimatedTotal,
    categories,
    lines,
    messages,
  }
}

/// <summary> AI Cursor </summary>
function normalizeContextUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const skip = new Set([
    'Free space',
    'Autocompact buffer',
    'Compact buffer',
    'Messages',
  ])
  const categories = Array.isArray(raw.categories)
    ? raw.categories
        .filter(c => c && !skip.has(c.name) && !c.isDeferred && Number(c.tokens) > 0)
        .map(c => ({
          id: String(c.name || 'other'),
          label: String(c.name || 'other'),
          tokens: Number(c.tokens) || 0,
        }))
    : []
  const systemPromptSections = Array.isArray(raw.systemPromptSections)
    ? raw.systemPromptSections
        .filter(s => s && Number(s.tokens) > 0)
        .map(s => ({
          id: `sys:${s.name}`,
          label: String(s.name || 'section'),
          tokens: Number(s.tokens) || 0,
        }))
        .sort((a, b) => b.tokens - a.tokens)
    : []
  const systemTools = Array.isArray(raw.systemTools)
    ? raw.systemTools
        .filter(t => t && Number(t.tokens) > 0)
        .map(t => ({
          id: `tool:${t.name}`,
          label: String(t.name || 'tool'),
          tokens: Number(t.tokens) || 0,
        }))
        .sort((a, b) => b.tokens - a.tokens)
    : []
  const memoryFiles = Array.isArray(raw.memoryFiles)
    ? raw.memoryFiles
        .filter(f => f && Number(f.tokens) > 0)
        .map(f => ({
          id: `mem:${f.path}`,
          label: String(f.path || f.type || 'memory'),
          tokens: Number(f.tokens) || 0,
        }))
        .sort((a, b) => b.tokens - a.tokens)
    : []
  const mcpTools = Array.isArray(raw.mcpTools)
    ? raw.mcpTools
        .filter(t => t && Number(t.tokens) > 0)
        .map(t => ({
          id: `mcp:${t.serverName}/${t.name}`,
          label: `${t.serverName}/${t.name}`,
          tokens: Number(t.tokens) || 0,
        }))
        .sort((a, b) => b.tokens - a.tokens)
    : []

  const total = categories.reduce((s, c) => s + c.tokens, 0)
  return {
    totalTokens: Number(raw.totalTokens) || total,
    categories: categories.map(c => ({
      ...c,
      share: total > 0 ? Math.round((c.tokens / total) * 1000) / 10 : 0,
    })),
    systemPromptSections,
    systemTools: systemTools.slice(0, 40),
    memoryFiles: memoryFiles.slice(0, 30),
    mcpTools: mcpTools.slice(0, 40),
  }
}

/// <summary> AI Cursor </summary>
function expandResidualChildren(residualMappedTokens, context) {
  if (!context?.categories?.length || residualMappedTokens <= 0) return []
  const total = context.categories.reduce((s, c) => s + c.tokens, 0) || 1
  const children = context.categories.map(c => {
    const mappedTokens = Math.round((c.tokens / total) * residualMappedTokens)
    const share =
      residualMappedTokens > 0
        ? Math.round((mappedTokens / residualMappedTokens) * 1000) / 10
        : 0
    const row = {
      id: c.id,
      label: c.label,
      tokens: c.tokens,
      mappedTokens,
      share,
      count: 0,
    }
    if (c.label === 'System prompt' && context.systemPromptSections?.length) {
      const subTotal =
        context.systemPromptSections.reduce((s, x) => s + x.tokens, 0) || 1
      row.children = context.systemPromptSections.map(s => ({
        id: s.id,
        label: s.label,
        tokens: s.tokens,
        mappedTokens: Math.round((s.tokens / subTotal) * mappedTokens),
        share: Math.round((s.tokens / subTotal) * 1000) / 10,
        count: 0,
      }))
    } else if (
      (c.label === 'System tools' ||
        c.label === '[internal] System tools') &&
      context.systemTools?.length
    ) {
      const subTotal =
        context.systemTools.reduce((s, x) => s + x.tokens, 0) || 1
      row.children = context.systemTools.slice(0, 25).map(s => ({
        id: s.id,
        label: s.label,
        tokens: s.tokens,
        mappedTokens: Math.round((s.tokens / subTotal) * mappedTokens),
        share: Math.round((s.tokens / subTotal) * 1000) / 10,
        count: 0,
      }))
    } else if (c.label === 'Memory files' && context.memoryFiles?.length) {
      const subTotal =
        context.memoryFiles.reduce((s, x) => s + x.tokens, 0) || 1
      row.children = context.memoryFiles.map(s => ({
        id: s.id,
        label: s.label,
        tokens: s.tokens,
        mappedTokens: Math.round((s.tokens / subTotal) * mappedTokens),
        share: Math.round((s.tokens / subTotal) * 1000) / 10,
        count: 0,
      }))
    } else if (c.label === 'MCP tools' && context.mcpTools?.length) {
      const subTotal = context.mcpTools.reduce((s, x) => s + x.tokens, 0) || 1
      row.children = context.mcpTools.slice(0, 25).map(s => ({
        id: s.id,
        label: s.label,
        tokens: s.tokens,
        mappedTokens: Math.round((s.tokens / subTotal) * mappedTokens),
        share: Math.round((s.tokens / subTotal) * 1000) / 10,
        count: 0,
      }))
    }
    return row
  })
  return children
}

/// <summary> AI Cursor </summary>
export function buildUsageDetail({
  usage,
  numTurns = null,
  modelUsage = null,
  composition = null,
  contextUsage = null,
  model = null,
}) {
  const inputTokens = Number(usage?.input_tokens ?? usage?.promptTokens) || 0
  const outputTokens =
    Number(usage?.output_tokens ?? usage?.completionTokens) || 0
  const cacheRead = Number(usage?.cache_read_input_tokens) || 0
  const cacheCreate = Number(usage?.cache_creation_input_tokens) || 0
  const turns = Number(numTurns) || 0
  const context = normalizeContextUsage(contextUsage)

  const billed = {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
    numTurns: turns || null,
    avgInputPerTurn: turns > 0 ? Math.round(inputTokens / turns) : null,
  }

  const models = []
  if (modelUsage && typeof modelUsage === 'object') {
    for (const [name, u] of Object.entries(modelUsage)) {
      models.push({
        model: name,
        inputTokens: Number(u.inputTokens ?? u.input_tokens) || 0,
        outputTokens: Number(u.outputTokens ?? u.output_tokens) || 0,
        cacheReadInputTokens:
          Number(u.cacheReadInputTokens ?? u.cache_read_input_tokens) || 0,
        cacheCreationInputTokens:
          Number(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens) ||
          0,
        costUSD: typeof u.costUSD === 'number' ? u.costUSD : null,
      })
    }
  }

  // Scale composition shares against billed input for a "mapped" view.
  let mapped = null
  if (composition?.categories?.length && inputTokens > 0) {
    const est = composition.estimatedTotal || 0
    const basis =
      turns > 0 && billed.avgInputPerTurn != null
        ? billed.avgInputPerTurn
        : inputTokens
    const residual = Math.max(0, basis - est)
    const denom = est + residual
    mapped = composition.categories.map(c => {
      const share =
        denom > 0 ? Math.round((c.tokens / denom) * 1000) / 10 : c.share
      const mappedTokens =
        denom > 0 ? Math.round((c.tokens / denom) * inputTokens) : 0
      return {
        ...c,
        share,
        mappedTokens,
        note:
          turns > 1
            ? '按「单轮平均入」构成映射到账单「入」合计'
            : '按构成映射到账单「入」',
      }
    })
    if (residual > 0 && denom > 0) {
      const residualMapped = Math.round((residual / denom) * inputTokens)
      mapped.push({
        id: 'not_in_transcript',
        label: '系统/工具定义等（未进 transcript）',
        tokens: residual,
        count: 0,
        share: Math.round((residual / denom) * 1000) / 10,
        mappedTokens: residualMapped,
        note: context
          ? '已用 OpenClaude /context 拆分下方明细'
          : '用「平均每轮入 − 会话消息估算」的差额近似',
        children: expandResidualChildren(residualMapped, context),
      })
    }
  }

  return {
    model: model || null,
    billed,
    models,
    composition: composition
      ? {
          ok: Boolean(composition.ok),
          estimatedTotal: composition.estimatedTotal || 0,
          categories: composition.categories || [],
          messages: composition.messages || 0,
        }
      : null,
    contextBreakdown: context,
    mappedToBilledInput: mapped,
    notes: [
      '「入 / 出」来自本轮 Agent 全部 API 调用的累计账单 token。',
      turns > 1
        ? `本轮约 ${turns} 次模型请求；每次都会再带上（增长中的）上下文，因此「入」通常大于某一时刻的上下文估算。`
        : null,
      context
        ? '「系统/工具定义等」已展开为 System prompt / 工具 schema / Memory 等（来自 get_context_usage）。'
        : '「会话构成」按 transcript 粗估。若未取到上下文分析，系统提示与工具 schema 会合并在差额桶里。',
      cacheRead || cacheCreate
        ? '若中转/模型返回了 cache 字段，会单独列出（部分线路可能始终为 0）。'
        : null,
    ].filter(Boolean),
  }
}
