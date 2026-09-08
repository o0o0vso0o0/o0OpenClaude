/**
 * AI Cursor — mirror OpenClaude TUI activity summaries for the GUI.
 * Categories align with streamlinedTransform / collapseReadSearch.
 */

/// <summary> AI Cursor </summary>
export function categorizeToolName(toolName) {
  const n = String(toolName || '')
  if (
    /^(Grep|Glob|WebSearch|LSP|Agent)\b/i.test(n) ||
    n.includes('Grep') ||
    n.includes('Glob') ||
    n.includes('WebSearch')
  )
    return 'searches'
  if (/^(Read|ListMcpResources)\b/i.test(n) || n === 'Read') return 'reads'
  if (
    /^(Write|Edit|NotebookEdit)\b/i.test(n) ||
    n === 'Write' ||
    n === 'Edit' ||
    n === 'NotebookEdit'
  )
    return 'writes'
  if (/^(Bash|PowerShell|Shell|Tmux|TaskStop)\b/i.test(n) || n === 'Bash')
    return 'commands'
  return 'other'
}

/// <summary> AI Cursor </summary>
export function emptyToolCounts() {
  return { searches: 0, reads: 0, writes: 0, commands: 0, other: 0 }
}

/// <summary> AI Cursor </summary>
export function formatExploredSummary(counts, { active = false } = {}) {
  const parts = []
  if (counts.searches > 0) {
    const verb = active ? 'Searching for' : 'Searched for'
    parts.push(
      `${verb} ${counts.searches} ${counts.searches === 1 ? 'pattern' : 'patterns'}`,
    )
  }
  if (counts.reads > 0) {
    const first = parts.length === 0
    const verb = active
      ? first
        ? 'Reading'
        : 'reading'
      : first
        ? 'Read'
        : 'read'
    parts.push(
      `${verb} ${counts.reads} ${counts.reads === 1 ? 'file' : 'files'}`,
    )
  }
  return parts.join(', ')
}

/// <summary> AI Cursor </summary>
export function formatEditedSummary(counts, { active = false } = {}) {
  if (counts.writes <= 0) return ''
  const v = active ? 'Writing' : 'Wrote'
  return `${v} ${counts.writes} ${counts.writes === 1 ? 'file' : 'files'}`
}

/// <summary> AI Cursor </summary>
export function formatCommandsSummary(counts, { active = false } = {}) {
  if (counts.commands <= 0) return ''
  const v = active ? 'Running' : 'Ran'
  return `${v} ${counts.commands} ${counts.commands === 1 ? 'command' : 'commands'}`
}

/// <summary> AI Cursor </summary>
export function formatWorkedFor(ms) {
  const sec = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (sec < 60) return `Worked for ${Math.max(1, Math.round(sec))}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return s > 0 ? `Worked for ${m}m ${s}s` : `Worked for ${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `Worked for ${h}h ${rm}m` : `Worked for ${h}h`
}

/// <summary> AI Cursor </summary>
export function formatThoughtFor(ms) {
  const sec = Math.max(0, (Number(ms) || 0) / 1000)
  if (sec < 1) return 'Thought for <1s'
  if (sec < 60) return `Thought for ${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s > 0 ? `Thought for ${m}m ${s}s` : `Thought for ${m}m`
}

/// <summary> AI Cursor </summary>
export function formatThoughtForZh(ms) {
  const sec = Math.max(0, (Number(ms) || 0) / 1000)
  if (sec < 1) return '思考了不到1秒'
  if (sec < 60) return `思考了 ${Math.max(1, Math.round(sec))}秒`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s > 0 ? `思考了 ${m}分${s}秒` : `思考了 ${m}分钟`
}

/// <summary> AI Cursor </summary>
export function countPatchLines(structuredPatch) {
  let added = 0
  let removed = 0
  if (!Array.isArray(structuredPatch)) return { added, removed }
  for (const hunk of structuredPatch) {
    const lines = hunk?.lines || []
    for (const line of lines) {
      const s = String(line || '')
      if (s.startsWith('+') && !s.startsWith('+++')) added++
      else if (s.startsWith('-') && !s.startsWith('---')) removed++
    }
  }
  return { added, removed }
}

/// <summary> AI Cursor </summary>
export function extractFileChangeFromToolResult(payload) {
  if (!payload || typeof payload !== 'object') return null
  const filePath = String(payload.filePath || payload.file_path || '').trim()
  if (!filePath) return null
  let added = 0
  let removed = 0
  if (Array.isArray(payload.structuredPatch) && payload.structuredPatch.length) {
    const c = countPatchLines(payload.structuredPatch)
    added = c.added
    removed = c.removed
  } else if (payload.type === 'create' && typeof payload.content === 'string') {
    added = Math.max(1, String(payload.content).split(/\r?\n/).length)
  } else {
    return { filePath, added: 0, removed: 0, unknown: true }
  }
  return { filePath, added, removed }
}

/// <summary> AI Cursor </summary>
export function toolInputFilePath(input) {
  if (!input || typeof input !== 'object') return ''
  return String(
    input.file_path || input.filePath || input.path || input.notebook_path || '',
  ).trim()
}

/// <summary> AI Cursor </summary>
export function inputLooksReady(input) {
  if (!input || typeof input !== 'object') return false
  return Object.keys(input).length > 0
}

/// <summary> AI Cursor </summary>
export function formatToolPreview(input) {
  if (!input || typeof input !== 'object') return String(input ?? '')
  if (input.command) return String(input.command)
  if (input.file_path || input.path || input.filePath)
    return String(input.file_path || input.path || input.filePath)
  if (input.query) return String(input.query)
  if (input.url) return String(input.url)
  if (input.pattern) return String(input.pattern)
  if (input.prompt) {
    const p = String(input.prompt)
    return p.length > 120 ? `${p.slice(0, 120)}…` : p
  }
  try {
    const s = JSON.stringify(input)
    if (s === '{}') return ''
    return s.length > 160 ? `${s.slice(0, 160)}…` : s
  } catch {
    return String(input)
  }
}

/// <summary> AI Cursor </summary>
export function extractWebPages(payload, toolName = '', input = null) {
  /** @type {{ title: string, url: string, source?: string }[]} */
  const pages = []
  const push = (title, url, source) => {
    const u = String(url || '').trim()
    if (!u || !/^https?:\/\//i.test(u)) return
    if (pages.some(p => p.url === u)) return
    pages.push({
      title: String(title || u).trim() || u,
      url: u,
      ...(source ? { source: String(source) } : {}),
    })
  }

  const name = String(toolName || '')
  if (input && typeof input === 'object' && input.url)
    push(input.url, input.url, name || 'WebFetch')

  if (!payload || typeof payload !== 'object')
    return pages.length ? pages : null

  const query = String(payload.query || '').trim()
  if (Array.isArray(payload.hits)) {
    for (const h of payload.hits)
      if (h && typeof h === 'object') push(h.title, h.url, 'WebSearch')
  }
  if (Array.isArray(payload.results)) {
    for (const r of payload.results) {
      if (!r) continue
      if (typeof r === 'string') {
        const re = /\*\*([^*]+)\*\*[^(]*\((https?:\/\/[^)\s]+)\)/g
        let m
        while ((m = re.exec(r))) push(m[1], m[2], 'WebSearch')
        const urlOnly = r.match(/https?:\/\/[^\s)\]"']+/g)
        if (urlOnly) for (const u of urlOnly) push(u, u, 'WebSearch')
        continue
      }
      if (typeof r !== 'object') continue
      if (Array.isArray(r.content)) {
        for (const h of r.content)
          if (h && typeof h === 'object') push(h.title, h.url, 'WebSearch')
      }
      if (r.url) push(r.title, r.url, 'WebSearch')
    }
  }
  if (Array.isArray(payload.content)) {
    for (const h of payload.content)
      if (h && typeof h === 'object') push(h.title, h.url, name || 'WebSearch')
  }
  if (payload.url) push(payload.title || payload.url, payload.url, name || 'WebFetch')
  if (payload.finalUrl) push(payload.finalUrl, payload.finalUrl, name || 'WebFetch')

  if (!pages.length && !query) return null
  return pages.length ? pages : null
}

/// <summary> AI Cursor </summary>
export function buildPromptRecord({
  userPrompt = '',
  tools = [],
  webPages = [],
  filesChanged = [],
  filesRead = [],
}) {
  const lines = []
  lines.push('=== 本轮用户消息 ===')
  lines.push(String(userPrompt || '(空)').trim() || '(空)')
  lines.push('')
  lines.push('=== 工具调用 ===')
  if (!tools.length) lines.push('(无)')
  else {
    tools.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name || 'Tool'}`)
      try {
        lines.push(JSON.stringify(t.input ?? {}, null, 2))
      } catch {
        lines.push(String(t.preview || ''))
      }
      lines.push('')
    })
  }
  lines.push('=== 网页（搜索/抓取） ===')
  if (!webPages.length) lines.push('(无)')
  else
    for (const p of webPages)
      lines.push(`- ${p.title}\n  ${p.url}${p.source ? `  [${p.source}]` : ''}`)
  lines.push('')
  lines.push('=== 文件 ===')
  const reads = filesRead || []
  const writes = filesChanged || []
  if (!reads.length && !writes.length) lines.push('(无)')
  else {
    for (const f of reads) lines.push(`- 读 ${f}`)
    for (const f of writes)
      lines.push(
        `- 写 ${f.filePath || f} (+${f.added || 0}/-${f.removed || 0})`,
      )
  }
  return lines.join('\n').trim() + '\n'
}
