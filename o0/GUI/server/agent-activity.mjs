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
