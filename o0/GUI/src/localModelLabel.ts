/// <summary> AI Cursor — local Ollama display names (keep in sync with server models-catalog). </summary>

const KNOWN: { ollamaId: string; label: string }[] = [
  { ollamaId: 'qwen3.8:27b', label: '千问3.8 · 27B · Q4' },
  { ollamaId: 'qwen3.8:27b-q8_0', label: '千问3.8 · 27B · Q8' },
  { ollamaId: 'qwen3.8:27b-mxfp8', label: '千问3.8 · 27B · FP8' },
  { ollamaId: 'qwen3.8:27b-bf16', label: '千问3.8 · 27B · BF16' },
]

/// <summary> AI Cursor </summary>
export function localQuantTag(ollamaId: string): string {
  const id = String(ollamaId || '').toLowerCase()
  if (!id) return ''
  if (id.includes('bf16')) return 'BF16'
  if (id.includes('mxfp8') || id.includes('fp8')) return 'FP8'
  if (id.includes('q8')) return 'Q8'
  if (id.includes('q6')) return 'Q6'
  if (id.includes('q5')) return 'Q5'
  if (id.includes('q4') || /^qwen3\.8:27b$/.test(id)) return 'Q4'
  if (id.includes('q3')) return 'Q3'
  if (id.includes('q2')) return 'Q2'
  return ''
}

/// <summary> AI Cursor </summary>
export function localModelLabel(ollamaId: string | undefined | null): string {
  const id = String(ollamaId || '').trim()
  if (!id) return '未选模型'
  const known = KNOWN.find(d => d.ollamaId === id)
  if (known) return known.label
  const quant = localQuantTag(id)
  if (/^qwen3\.8:27b/i.test(id))
    return `千问3.8 · 27B · ${quant || '本地'}`
  return quant ? `${id} · ${quant}` : id
}

/// <summary> AI Cursor </summary>
export function localDisplayLabel(
  ollamaId: string | undefined | null,
  think?: boolean | null,
): string {
  const base = localModelLabel(ollamaId)
  return `${base} · ${think ? 'Think开' : 'Think关'}`
}
