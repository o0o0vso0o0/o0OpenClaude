/** AI Cursor — phase-aware ETA for live stream progress */

export type StreamPhase =
  | 'sending'
  | 'boot'
  | 'wait_first'
  | 'thinking'
  | 'generating'
  | 'tool'
  | 'unknown'

type PhaseBaselines = Record<StreamPhase, number>

type ModelEtaHistory = {
  /** EMA of time-to-first-token (or first meaningful progress), seconds */
  ttftSec: number
  /** EMA of full turn duration, seconds */
  turnSec: number
  samples: number
  updatedAt: number
}

const STORAGE_KEY = 'o0-gui-stream-eta-v1'

const LOCAL_BASE: PhaseBaselines = {
  sending: 1,
  boot: 4,
  wait_first: 28,
  thinking: 22,
  generating: 18,
  tool: 8,
  unknown: 20,
}

const CLOUD_BASE: PhaseBaselines = {
  sending: 1,
  boot: 2,
  wait_first: 6,
  thinking: 10,
  generating: 10,
  tool: 4,
  unknown: 8,
}

/// <summary> AI Cursor </summary>
export function classifyStreamPhase(
  status: string,
  opts?: { hasContent?: boolean; lastStepKind?: 'status' | 'tool' },
): StreamPhase {
  const s = String(status || '')
  if (opts?.lastStepKind === 'tool' || /调用工具|tool/i.test(s)) return 'tool'
  if (/正在发送/.test(s)) return 'sending'
  if (/准备|启动 Agent|正在启动|恢复会话|正在恢复/.test(s)) return 'boot'
  if (
    /首 token|首包|等待本地|等待模型|正在加载本地|正在连接模型/.test(s)
  )
    return 'wait_first'
  if (/思考/.test(s)) return 'thinking'
  if (/生成|写回复|已收到模型响应|正在处理/.test(s) || opts?.hasContent)
    return 'generating'
  if (opts?.hasContent) return 'generating'
  return 'unknown'
}

/// <summary> AI Cursor — user-facing wait copy (hide internal pipeline jargon) </summary>
export function describeStreamWait(opts: {
  phase: StreamPhase
  isLocal?: boolean
}): { title: string; tip?: string } {
  const local = Boolean(opts.isLocal)
  switch (opts.phase) {
    case 'sending':
      return { title: '正在发送…' }
    case 'boot':
      return {
        title: '正在启动…',
        tip: local ? '准备本地环境' : '准备运行环境',
      }
    case 'wait_first':
      return local
        ? { title: '正在加载本地模型…', tip: '第一次会稍慢' }
        : { title: '正在连接模型…' }
    case 'thinking':
      return { title: '正在思考…' }
    case 'generating':
      return { title: '正在写回复…' }
    case 'tool':
      return { title: '正在处理…' }
    default:
      return { title: '处理中…' }
  }
}

/// <summary> AI Cursor </summary>
function historyKey(model: string, isLocal: boolean): string {
  return `${isLocal ? 'local' : 'cloud'}::${model || 'default'}`
}

/// <summary> AI Cursor </summary>
export function loadEtaHistory(
  model: string,
  isLocal: boolean,
): ModelEtaHistory | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const all = JSON.parse(raw) as Record<string, ModelEtaHistory>
    const hit = all[historyKey(model, isLocal)]
    if (!hit || !(hit.ttftSec > 0 || hit.turnSec > 0)) return null
    return hit
  } catch {
    return null
  }
}

/// <summary> AI Cursor </summary>
export function recordEtaSample(opts: {
  model: string
  isLocal: boolean
  ttftSec: number | null
  turnSec: number
}): void {
  const turnSec = Math.max(1, opts.turnSec)
  const ttftSec =
    opts.ttftSec != null && opts.ttftSec > 0
      ? Math.max(0.5, opts.ttftSec)
      : null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const all = (raw ? JSON.parse(raw) : {}) as Record<string, ModelEtaHistory>
    const key = historyKey(opts.model, opts.isLocal)
    const prev = all[key]
    const alpha = prev && prev.samples >= 3 ? 0.35 : 0.55
    const next: ModelEtaHistory = {
      ttftSec: ttftSec
        ? prev?.ttftSec
          ? prev.ttftSec * (1 - alpha) + ttftSec * alpha
          : ttftSec
        : prev?.ttftSec || turnSec * 0.45,
      turnSec: prev?.turnSec
        ? prev.turnSec * (1 - alpha) + turnSec * alpha
        : turnSec,
      samples: (prev?.samples || 0) + 1,
      updatedAt: Date.now(),
    }
    all[key] = next
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    /* ignore quota / private mode */
  }
}

/// <summary> AI Cursor </summary>
function phaseRemaining(expected: number, phaseElapsed: number): number {
  if (phaseElapsed <= expected) return Math.max(0, expected - phaseElapsed)
  // Overrun: keep a soft tail so ETA doesn't snap to 0 while still busy.
  const over = phaseElapsed - expected
  return Math.max(2, expected * 0.35 * Math.exp(-over / Math.max(6, expected)))
}

/// <summary> AI Cursor </summary>
export function estimateRemainingSec(opts: {
  isLocal: boolean
  model: string
  phase: StreamPhase
  elapsedSec: number
  phaseElapsedSec: number
  hasContent: boolean
  contentChars: number
  toolCount: number
  firstTokenSec: number | null
}): number {
  const base = opts.isLocal ? { ...LOCAL_BASE } : { ...CLOUD_BASE }
  const hist = loadEtaHistory(opts.model, opts.isLocal)
  if (hist?.ttftSec) {
    base.wait_first = Math.max(
      opts.isLocal ? 8 : 2,
      Math.min(opts.isLocal ? 90 : 30, hist.ttftSec),
    )
    base.thinking = Math.max(
      4,
      Math.min(opts.isLocal ? 60 : 25, hist.ttftSec * 0.7),
    )
  }
  if (hist?.turnSec) {
    base.generating = Math.max(
      4,
      Math.min(opts.isLocal ? 90 : 40, hist.turnSec * 0.35),
    )
  }

  const cur = phaseRemaining(base[opts.phase] || base.unknown, opts.phaseElapsedSec)

  // Future phases still ahead (coarse pipeline).
  let ahead = 0
  switch (opts.phase) {
    case 'sending':
      ahead = base.boot + base.wait_first + base.thinking * 0.5 + base.generating * 0.4
      break
    case 'boot':
      ahead = base.wait_first + base.thinking * 0.5 + base.generating * 0.4
      break
    case 'wait_first':
      ahead = base.thinking * 0.55 + base.generating * 0.45
      break
    case 'thinking':
      ahead = base.generating * 0.55
      break
    case 'generating': {
      // Once tokens flow, shrink ETA using elapsed-vs-typical turn length.
      const typical = hist?.turnSec || (opts.isLocal ? 45 : 18)
      const leftFromTurn = phaseRemaining(typical, opts.elapsedSec)
      // Streaming heuristic: assume ~25 chars/s local, ~60 cloud after first token.
      const rate = opts.isLocal ? 25 : 60
      const streamLeft =
        opts.contentChars > 40
          ? Math.max(2, Math.min(40, 180 / Math.max(8, rate)))
          : base.generating * 0.5
      ahead = Math.min(leftFromTurn, streamLeft)
      break
    }
    case 'tool':
      ahead = base.tool * 0.35 + base.generating * 0.35
      break
    default:
      ahead = base.unknown * 0.4
  }

  // Extra tool tax if many tools already ran (agent loops).
  if (opts.toolCount > 0 && opts.phase !== 'tool')
    ahead += Math.min(24, opts.toolCount * (opts.isLocal ? 3 : 1.5))

  // If first token already arrived, cut wait_first-style padding.
  if (opts.firstTokenSec != null && opts.phase !== 'wait_first' && opts.phase !== 'boot')
    ahead *= 0.85

  const total = Math.round(cur + ahead)
  return Math.max(1, Math.min(opts.isLocal ? 300 : 120, total))
}

/// <summary> AI Cursor </summary>
export function formatEtaSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '估算中…'
  const s = Math.max(1, Math.round(sec))
  if (s < 60) return `约 ${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r > 0 ? `约 ${m}分${r}秒` : `约 ${m}分钟`
}
