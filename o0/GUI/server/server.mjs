/**
 * AI Cursor — OpenClaude GUI local server (no TUI).
 * Agent harness via CLI stream-json; OpenAI-compatible provider (e.g. chatanywhere).
 */
import cors from 'cors'
import express from 'express'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import {
  getModelsCatalog,
  lookupModelPrice,
  calcTokenCostCa,
  buildCostFooter,
  isLocalOllamaBaseUrl,
  isLocalOllamaModelId,
  parseLocalModelSelection,
  LOCAL_OLLAMA_API_KEY,
  LOCAL_OLLAMA_BASE_URL,
} from './models-catalog.mjs'
import { resolveOpenClaudeCli, runAgentTurn, findSessionJsonl } from './agent-harness.mjs'
import { analyzeSessionJsonl, buildUsageDetail } from './usage-analysis.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GUI_ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.OPENCLAUDE_GUI_PORT || 3920)
const HOST = process.env.OPENCLAUDE_GUI_HOST || '127.0.0.1'
const DEV = process.argv.includes('--dev')
const OPEN_BROWSER =
  process.env.OPENCLAUDE_GUI_OPEN !== '0' &&
  (process.env.OPENCLAUDE_GUI_OPEN === '1' || !DEV)

/** Exit when UI stops heartbeating (Release). Disabled in --dev. */
const LIFETIME =
  !DEV &&
  process.env.OPENCLAUDE_GUI_LIFETIME !== '0'
const HEARTBEAT_MS = Number(process.env.OPENCLAUDE_GUI_HEARTBEAT_MS || 45000)
const HEARTBEAT_CHECK_MS = 1000

const DATA_DIR =
  process.env.OPENCLAUDE_GUI_DATA ||
  path.join(GUI_ROOT, 'data')

let lastHeartbeatAt = 0
let shuttingDown = false
let exitTimer = null
let activeRequests = 0
/** @type {import('http').Server | null} */
let server = null

/// <summary> AI Cursor </summary>
function touchHeartbeat() {
  lastHeartbeatAt = Date.now()
  if (exitTimer) {
    clearTimeout(exitTimer)
    exitTimer = null
  }
}

/// <summary> AI Cursor </summary>
function scheduleShutdown(reason, delayMs = 2500) {
  if (!LIFETIME || shuttingDown) return
  if (exitTimer) clearTimeout(exitTimer)
  exitTimer = setTimeout(() => shutdown(reason), delayMs)
}

/// <summary> AI Cursor </summary>
function shutdown(reason) {
  if (shuttingDown) return
  if (activeRequests > 0) {
    console.log(`[openclaude-gui] skip shutdown (${reason}): ${activeRequests} active request(s)`)
    touchHeartbeat()
    return
  }
  shuttingDown = true
  console.log(`[openclaude-gui] shutting down (${reason})`)
  if (server)
    server.close(() => process.exit(0))
  else
    process.exit(0)
  setTimeout(() => process.exit(0), 1500).unref()
}

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')

const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.chatanywhere.tech/v1',
  model: 'gpt-4o-mini',
  /** Remembered cloud endpoint when switching to local Ollama */
  cloudBaseUrl: 'https://api.chatanywhere.tech/v1',
  cloudApiKey: '',
  localBaseUrl: LOCAL_OLLAMA_BASE_URL,
  localApiKey: LOCAL_OLLAMA_API_KEY,
  /** Agent 工作目录（仓库根） */
  cwd: '',
  /** Plan mode：只读规划，限制写文件 */
  planMode: false,
  /** Local Ollama: pass think:true to /api/chat (Qwen3.x) */
  ollamaThink: false,
  /** @type {Record<string, string>} modelId -> ISO last-used time */
  modelLastUsed: {},
}

/// <summary> AI Cursor </summary>
function isLocalPlaceholderKey(key) {
  const k = String(key || '').trim().toLowerCase()
  return !k || k === 'ollama' || k === 'local' || k === '********'
}

/// <summary> AI Cursor </summary>
function settingsPublic(s) {
  const local = isLocalOllamaBaseUrl(s.baseUrl) || isLocalOllamaModelId(s.model)
  const cloudKey = String(s.cloudApiKey || '').trim()
  const activeKey = String(s.apiKey || '').trim()
  // Settings UI edits the cloud key; local Ollama uses placeholder "ollama" internally.
  const keyForUi = local
    ? cloudKey && !isLocalPlaceholderKey(cloudKey)
      ? cloudKey
      : ''
    : activeKey && !isLocalPlaceholderKey(activeKey)
      ? activeKey
      : cloudKey && !isLocalPlaceholderKey(cloudKey)
        ? cloudKey
        : ''
  const cli = resolveOpenClaudeCli(GUI_ROOT)
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    cwd: s.cwd || '',
    planMode: Boolean(s.planMode),
    ollamaThink: Boolean(s.ollamaThink),
    apiKey: keyForUi,
    apiKeySet: Boolean(keyForUi) || local,
    apiKeyPreview: keyForUi
      ? `${keyForUi.slice(0, 4)}…${keyForUi.slice(-4)}`
      : local
        ? 'local'
        : '',
    provider: local ? 'ollama' : 'openai',
    agentCli: cli?.label || null,
    agentReady: Boolean(cli),
  }
}

/// <summary> AI Cursor </summary>
function applyModelEndpointSwitch(next, cur) {
  const model = String(next.model || '').trim()
  const wantLocal = isLocalOllamaModelId(model)
  const curLocal =
    isLocalOllamaBaseUrl(cur.baseUrl) || isLocalOllamaModelId(cur.model)

  if (wantLocal) {
    if (!curLocal) {
      next.cloudBaseUrl = cur.baseUrl || DEFAULT_SETTINGS.cloudBaseUrl
      const leavingKey = String(cur.apiKey || '').trim()
      // Never stash the Ollama placeholder as the cloud key.
      next.cloudApiKey = !isLocalPlaceholderKey(leavingKey)
        ? leavingKey
        : String(cur.cloudApiKey || '')
    } else {
      next.cloudBaseUrl = cur.cloudBaseUrl || DEFAULT_SETTINGS.cloudBaseUrl
      next.cloudApiKey = String(cur.cloudApiKey || '')
    }
    next.baseUrl = cur.localBaseUrl || LOCAL_OLLAMA_BASE_URL
    next.apiKey = LOCAL_OLLAMA_API_KEY
    next.localBaseUrl = next.baseUrl
    next.localApiKey = LOCAL_OLLAMA_API_KEY
  } else if (curLocal) {
    const cloudKey = String(cur.cloudApiKey || '').trim()
    next.baseUrl = cur.cloudBaseUrl || DEFAULT_SETTINGS.cloudBaseUrl
    next.apiKey = !isLocalPlaceholderKey(cloudKey)
      ? cloudKey
      : !isLocalPlaceholderKey(cur.apiKey)
        ? String(cur.apiKey)
        : ''
    next.cloudBaseUrl = next.baseUrl
    next.cloudApiKey = next.apiKey
  }
  return next
}

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  if (!fs.existsSync(SETTINGS_PATH))
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8')
}

function readSettings() {
  ensureDirs()
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      modelLastUsed: {
        ...DEFAULT_SETTINGS.modelLastUsed,
        ...(raw.modelLastUsed && typeof raw.modelLastUsed === 'object'
          ? raw.modelLastUsed
          : {}),
      },
    }
  } catch {
    return { ...DEFAULT_SETTINGS, modelLastUsed: {} }
  }
}

function writeSettings(next) {
  ensureDirs()
  const merged = {
    ...DEFAULT_SETTINGS,
    ...next,
    modelLastUsed: {
      ...DEFAULT_SETTINGS.modelLastUsed,
      ...(next.modelLastUsed && typeof next.modelLastUsed === 'object'
        ? next.modelLastUsed
        : {}),
    },
    cloudBaseUrl: next.cloudBaseUrl || DEFAULT_SETTINGS.cloudBaseUrl,
    cloudApiKey: next.cloudApiKey != null ? next.cloudApiKey : '',
    localBaseUrl: next.localBaseUrl || LOCAL_OLLAMA_BASE_URL,
    localApiKey: next.localApiKey || LOCAL_OLLAMA_API_KEY,
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}

/// <summary> AI Cursor </summary>
function touchModelLastUsed(modelId, settings = null) {
  const id = String(modelId || '').trim()
  if (!id) return settings || readSettings()
  const cur = settings || readSettings()
  const modelLastUsed = { ...(cur.modelLastUsed || {}) }
  modelLastUsed[id] = new Date().toISOString()
  return writeSettings({ ...cur, model: cur.model, modelLastUsed })
}

/// <summary> AI Cursor </summary>
function attachFrequentTab(catalog, modelLastUsed) {
  const used = modelLastUsed && typeof modelLastUsed === 'object' ? modelLastUsed : {}
  const byId = new Map((catalog.models || []).map(m => [m.id, m]))
  const frequent = Object.entries(used)
    .map(([id, at]) => {
      const base = byId.get(id) || {
        id,
        series: 'frequent',
        created: 0,
        createdLabel: '',
        price: null,
        priceLabel: '价格未知',
        description: '',
        fromApi: false,
        fromPricing: false,
      }
      const ts = Date.parse(String(at)) || 0
      return {
        ...base,
        lastUsedAt: String(at),
        lastUsedLabel: ts
          ? new Date(ts).toLocaleString()
          : String(at),
        lastUsedTs: ts,
      }
    })
    .sort((a, b) => b.lastUsedTs - a.lastUsedTs)
    .map(({ lastUsedTs, ...rest }) => rest)

  const tabs = [
    {
      id: 'frequent',
      label: '常用',
      count: frequent.length,
      models: frequent,
    },
    ...(catalog.tabs || []).filter(t => t.id !== 'frequent'),
  ]
  return { ...catalog, tabs }
}

function listSessions(filterStatus = 'all') {
  ensureDirs()
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  const sessions = files.map(f => {
    const full = path.join(SESSIONS_DIR, f)
    const data = JSON.parse(fs.readFileSync(full, 'utf8'))
    const status =
      data.status === 'discarded' ? 'discarded' : 'active'
    return {
      id: data.id,
      title: data.title || '新会话',
      updatedAt: data.updatedAt || data.createdAt,
      createdAt: data.createdAt,
      messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
      status,
      discardedAt: data.discardedAt || null,
    }
  })
  const filtered =
    filterStatus === 'active' || filterStatus === 'discarded'
      ? sessions.filter(s => s.status === filterStatus)
      : sessions
  filtered.sort((a, b) => {
    if (filterStatus === 'discarded')
      return String(b.discardedAt || b.updatedAt).localeCompare(
        String(a.discardedAt || a.updatedAt),
      )
    return String(b.updatedAt).localeCompare(String(a.updatedAt))
  })
  return filtered
}

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`)
}

function readSession(id) {
  const p = sessionPath(id)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function writeSession(session) {
  ensureDirs()
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), 'utf8')
}

function openBrowser(url) {
  const platform = process.platform
  if (platform === 'win32')
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  else if (platform === 'darwin')
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  else
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

function normalizeBaseUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!u) u = DEFAULT_SETTINGS.baseUrl
  if (!/\/v1$/i.test(u)) u = `${u}/v1`
  return u
}

const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
])
const MAX_CHAT_IMAGES = 6
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/// <summary> AI Cursor </summary>
function normalizeChatImages(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    let mediaType = String(item.mediaType || item.media_type || '').toLowerCase()
    let data = String(item.data || '')
    if (data.startsWith('data:')) {
      const m = data.match(/^data:([^;]+);base64,(.+)$/s)
      if (!m) continue
      mediaType = mediaType || m[1].toLowerCase()
      data = m[2]
    }
    if (mediaType === 'image/jpg') mediaType = 'image/jpeg'
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) continue
    data = data.replace(/\s+/g, '')
    if (!data) continue
    const approxBytes = Math.floor((data.length * 3) / 4)
    if (approxBytes > MAX_IMAGE_BYTES) continue
    out.push({
      id: String(item.id || randomUUID()),
      name: String(item.name || 'image').slice(0, 120),
      mediaType,
      data,
    })
    if (out.length >= MAX_CHAT_IMAGES) break
  }
  return out
}

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '25mb' }))
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) touchHeartbeat()
  next()
})

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  activeRequests++
  let settled = false
  const done = () => {
    if (settled) return
    settled = true
    activeRequests = Math.max(0, activeRequests - 1)
    touchHeartbeat()
  }
  res.on('finish', done)
  res.on('close', done)
  next()
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'openclaude-gui', port: PORT })
})

/// <summary> AI Cursor </summary>
app.post('/api/heartbeat', (_req, res) => {
  touchHeartbeat()
  res.json({ ok: true, lifetime: LIFETIME })
})

/// <summary> AI Cursor </summary>
app.post('/api/shutdown', (_req, res) => {
  // Delayed so a page refresh can cancel via the next heartbeat.
  scheduleShutdown('client shutdown', 2500)
  res.json({ ok: true, delayedMs: 2500 })
})

app.get('/api/models', async (req, res) => {
  try {
    const settings = readSettings()
    const force = req.query.refresh === '1' || req.query.refresh === 'true'
    const catalog = await getModelsCatalog({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      cloudBaseUrl: settings.cloudBaseUrl || DEFAULT_SETTINGS.cloudBaseUrl,
      cloudApiKey:
        settings.cloudApiKey != null && String(settings.cloudApiKey).trim()
          ? settings.cloudApiKey
          : isLocalOllamaBaseUrl(settings.baseUrl)
            ? ''
            : settings.apiKey,
      localBaseUrl: settings.localBaseUrl || LOCAL_OLLAMA_BASE_URL,
      dataDir: DATA_DIR,
      force,
    })
    res.json(attachFrequentTab(catalog, settings.modelLastUsed))
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) })
  }
})

/// <summary> AI Cursor </summary>
function ollamaNativeBase(settings) {
  let u = String(
    settings?.localBaseUrl || settings?.baseUrl || LOCAL_OLLAMA_BASE_URL,
  ).replace(/\/+$/, '')
  u = u.replace(/\/v1$/i, '')
  return u || 'http://127.0.0.1:11434'
}

/// <summary> AI Cursor </summary>
async function listInstalledOllamaModelIds(base) {
  const r = await fetch(`${base}/api/tags`)
  if (!r.ok) throw new Error(`Ollama /api/tags HTTP ${r.status}`)
  const json = await r.json()
  const models = Array.isArray(json?.models) ? json.models : []
  const ids = new Set()
  for (const m of models) {
    const name = String(m.name || m.model || '').trim()
    if (!name) continue
    ids.add(name)
    // also accept bare tag without :latest
    if (name.endsWith(':latest')) ids.add(name.slice(0, -':latest'.length))
  }
  return ids
}

/// <summary> AI Cursor </summary>
function isOllamaModelInstalled(installed, modelId) {
  const id = String(modelId || '').trim()
  if (!id) return false
  if (installed.has(id)) return true
  if (installed.has(`${id}:latest`)) return true
  // digest-style or alias match: compare case-insensitively
  const lower = id.toLowerCase()
  for (const x of installed) if (String(x).toLowerCase() === lower) return true
  return false
}

/// <summary> AI Cursor </summary>
function formatBytes(n) {
  const v = Number(n) || 0
  if (v <= 0) return ''
  if (v < 1024) return `${v} B`
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`
  return `${(v / 1024 ** 3).toFixed(2)} GB`
}

/// <summary> AI Cursor </summary>
app.get('/api/ollama/loaded', async (_req, res) => {
  const settings = readSettings()
  const base = ollamaNativeBase(settings)
  try {
    const r = await fetch(`${base}/api/ps`)
    if (!r.ok) throw new Error(`Ollama /api/ps HTTP ${r.status}`)
    const json = await r.json()
    const models = (Array.isArray(json?.models) ? json.models : []).map(m => {
      const name = String(m.name || m.model || '')
      const size = Number(m.size) || 0
      const sizeVram = Number(m.size_vram) || 0
      return {
        name,
        model: String(m.model || name),
        size,
        sizeVram,
        sizeLabel: formatBytes(sizeVram || size),
        details: m.details || null,
        expiresAt: m.expires_at || null,
      }
    })
    res.json({ ok: true, baseUrl: base, models })
  } catch (err) {
    res.status(502).json({
      ok: false,
      baseUrl: base,
      models: [],
      error: err?.message || String(err),
    })
  }
})

/// <summary> AI Cursor </summary>
app.post('/api/ollama/unload', async (req, res) => {
  const settings = readSettings()
  const base = ollamaNativeBase(settings)
  const model = String(req.body?.model || '').trim()
  if (!model) return res.status(400).json({ ok: false, error: 'model required' })
  try {
    const r = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    })
    const text = await r.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!r.ok)
      throw new Error(
        (json && (json.error || json.message)) ||
          `Ollama unload HTTP ${r.status}: ${text.slice(0, 200)}`,
      )
    res.json({
      ok: true,
      model,
      doneReason: json?.done_reason || null,
    })
  } catch (err) {
    res.status(502).json({ ok: false, model, error: err?.message || String(err) })
  }
})

app.get('/api/settings', (_req, res) => {
  res.json(settingsPublic(readSettings()))
})

app.put('/api/settings', async (req, res) => {
  const cur = readSettings()
  const body = req.body || {}
  const next = {
    baseUrl: body.baseUrl != null ? String(body.baseUrl).trim() : cur.baseUrl,
    model: body.model != null ? String(body.model).trim() : cur.model,
    cwd: body.cwd != null ? String(body.cwd).trim() : cur.cwd || '',
    planMode:
      body.planMode != null ? Boolean(body.planMode) : Boolean(cur.planMode),
    ollamaThink:
      body.ollamaThink != null
        ? Boolean(body.ollamaThink)
        : Boolean(cur.ollamaThink),
    apiKey: cur.apiKey,
    cloudBaseUrl: cur.cloudBaseUrl || DEFAULT_SETTINGS.cloudBaseUrl,
    cloudApiKey: cur.cloudApiKey != null ? cur.cloudApiKey : '',
    localBaseUrl: cur.localBaseUrl || LOCAL_OLLAMA_BASE_URL,
    localApiKey: cur.localApiKey || LOCAL_OLLAMA_API_KEY,
    modelLastUsed: { ...(cur.modelLastUsed || {}) },
  }
  if (body.model != null) {
    const parsed = parseLocalModelSelection(next.model)
    next.model = parsed.model
    if (parsed.ollamaThink != null) next.ollamaThink = parsed.ollamaThink
  }
  if (typeof body.apiKey === 'string') {
    const key = body.apiKey.trim()
    if (key && key !== '********') {
      // While on local Ollama, the settings field edits the remembered cloud key.
      if (isLocalOllamaBaseUrl(next.baseUrl) || isLocalOllamaModelId(next.model)) {
        if (!isLocalPlaceholderKey(key)) {
          next.cloudApiKey = key
          // Keep active runtime key as Ollama placeholder.
          next.apiKey = LOCAL_OLLAMA_API_KEY
          next.localApiKey = LOCAL_OLLAMA_API_KEY
        }
      } else {
        next.apiKey = key
        if (!isLocalPlaceholderKey(key)) next.cloudApiKey = key
      }
    }
  }
  if (body.clearApiKey === true) {
    if (isLocalOllamaBaseUrl(next.baseUrl) || isLocalOllamaModelId(next.model)) {
      next.cloudApiKey = ''
      next.apiKey = LOCAL_OLLAMA_API_KEY
    } else {
      next.apiKey = ''
      next.cloudApiKey = ''
    }
  }

  // Switching model also switches endpoint (local Ollama <-> cloud).
  if (body.model != null && String(body.model).trim() !== String(cur.model || ''))
    applyModelEndpointSwitch(next, cur)
  // Manual baseUrl edit while keeping model: if user points at Ollama, sync local fields.
  else if (body.baseUrl != null && isLocalOllamaBaseUrl(next.baseUrl)) {
    next.localBaseUrl = next.baseUrl
    next.apiKey = LOCAL_OLLAMA_API_KEY
    next.localApiKey = LOCAL_OLLAMA_API_KEY
    if (!isLocalOllamaBaseUrl(cur.baseUrl)) {
      next.cloudBaseUrl = cur.baseUrl
      if (!isLocalPlaceholderKey(cur.apiKey))
        next.cloudApiKey = String(cur.apiKey || '')
    }
  } else if (
    body.baseUrl != null &&
    !isLocalOllamaBaseUrl(next.baseUrl) &&
    isLocalOllamaBaseUrl(cur.baseUrl)
  ) {
    next.cloudBaseUrl = next.baseUrl
    if (!isLocalPlaceholderKey(next.apiKey)) next.cloudApiKey = next.apiKey
    else if (!isLocalPlaceholderKey(cur.cloudApiKey))
      next.apiKey = String(cur.cloudApiKey)
  }

  // Validate local model exists BEFORE persisting.
  if (isLocalOllamaModelId(next.model) || isLocalOllamaBaseUrl(next.baseUrl)) {
    try {
      const base = ollamaNativeBase(next)
      const installed = await listInstalledOllamaModelIds(base)
      if (!isOllamaModelInstalled(installed, next.model)) {
        const available = [...installed].sort().join(', ') || '(无)'
        return res.status(400).json({
          error: `本地模型「${next.model}」尚未安装。请先执行：ollama pull ${next.model}\n本机已有：${available}`,
        })
      }
    } catch (err) {
      return res.status(502).json({
        error: `无法验证本地模型是否已安装：${err?.message || err}`,
      })
    }
  }

  const saved = writeSettings(next)
  res.json(settingsPublic(saved))
})

app.get('/api/sessions', (req, res) => {
  const status = String(req.query.status || 'all').trim()
  res.json({ sessions: listSessions(status) })
})

app.post('/api/sessions', (req, res) => {
  const id = randomUUID()
  const now = new Date().toISOString()
  const title = (req.body && req.body.title) || '新会话'
  const session = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    discardedAt: null,
    messages: [],
  }
  writeSession(session)
  res.status(201).json(session)
})

app.get('/api/sessions/:id', (req, res) => {
  const session = readSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  if (!session.status) session.status = 'active'
  res.json(session)
})

app.patch('/api/sessions/:id', (req, res) => {
  const session = readSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  if (typeof req.body?.title === 'string' && req.body.title.trim())
    session.title = req.body.title.trim()
  if (req.body?.status === 'active' || req.body?.status === 'discarded') {
    session.status = req.body.status
    if (req.body.status === 'discarded')
      session.discardedAt = new Date().toISOString()
    else session.discardedAt = null
  }
  session.updatedAt = new Date().toISOString()
  writeSession(session)
  res.json(session)
})

/// <summary> AI Cursor — soft delete: move to discarded group </summary>
app.post('/api/sessions/:id/discard', (req, res) => {
  const session = readSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  session.status = 'discarded'
  session.discardedAt = new Date().toISOString()
  session.updatedAt = session.discardedAt
  writeSession(session)
  res.json(session)
})

/// <summary> AI Cursor — restore from discarded to active </summary>
app.post('/api/sessions/:id/restore', (req, res) => {
  const session = readSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  session.status = 'active'
  session.discardedAt = null
  session.updatedAt = new Date().toISOString()
  writeSession(session)
  res.json(session)
})

/// <summary> AI Cursor — permanent delete (default soft via /discard) </summary>
app.delete('/api/sessions/:id', (req, res) => {
  const permanent =
    String(req.query.permanent || '') === '1' ||
    req.query.permanent === 'true'
  const session = readSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  if (!permanent) {
    session.status = 'discarded'
    session.discardedAt = new Date().toISOString()
    session.updatedAt = session.discardedAt
    writeSession(session)
    return res.json({ ok: true, discarded: true, session })
  }
  const p = sessionPath(req.params.id)
  fs.unlinkSync(p)
  res.json({ ok: true, permanent: true })
})

/// <summary> AI Cursor </summary>
app.get('/api/sessions/:id/messages/:messageId/usage-detail', (req, res) => {
  const session = readSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  const msg = (session.messages || []).find(m => m.id === req.params.messageId)
  if (!msg) return res.status(404).json({ error: 'message not found' })
  if (msg.usageDetail) return res.json({ usageDetail: msg.usageDetail, cached: true })

  const configDir = path.join(DATA_DIR, 'openclaude-config')
  const jsonlPath = session.agentSessionId
    ? findSessionJsonl(configDir, session.agentSessionId)
    : null
  const composition = analyzeSessionJsonl(jsonlPath)
  const usage = msg.usage || {}
  const usageDetail = buildUsageDetail({
    usage: {
      input_tokens: usage.promptTokens || 0,
      output_tokens: usage.completionTokens || 0,
      cache_read_input_tokens: usage.cacheReadInputTokens || 0,
      cache_creation_input_tokens: usage.cacheCreationInputTokens || 0,
    },
    numTurns: usage.numTurns || null,
    composition,
    model: msg.model || null,
  })

  // Persist so later clicks are free.
  msg.usageDetail = usageDetail
  writeSession(session)
  res.json({ usageDetail, cached: false })
})

app.post('/api/chat', async (req, res) => {
  const { sessionId, content, images: rawImages } = req.body || {}
  if (!sessionId || typeof content !== 'string')
    return res.status(400).json({ error: 'sessionId and content required' })

  const images = normalizeChatImages(rawImages)
  const text = content.trim()
  if (!text && images.length === 0)
    return res.status(400).json({ error: 'content or images required' })

  const session = readSession(sessionId)
  if (!session) return res.status(404).json({ error: 'session not found' })

  const settings = readSettings()
  if (!settings.apiKey || !String(settings.apiKey).trim())
    return res.status(400).json({ error: '请先在设置中填写 API Key' })

  const modelId = settings.model || DEFAULT_SETTINGS.model
  if (isLocalOllamaModelId(modelId) || isLocalOllamaBaseUrl(settings.baseUrl)) {
    try {
      const base = ollamaNativeBase(settings)
      const installed = await listInstalledOllamaModelIds(base)
      if (!isOllamaModelInstalled(installed, modelId)) {
        const available = [...installed].sort().join(', ') || '(无)'
        return res.status(400).json({
          error: `本地模型「${modelId}」尚未安装（Ollama 返回不存在）。请先：ollama pull ${modelId}\n或在右上角改选已安装模型。本机已有：${available}`,
        })
      }
    } catch (err) {
      return res.status(502).json({
        error: `无法连接 Ollama 校验模型：${err?.message || err}`,
      })
    }
  }
  touchModelLastUsed(modelId, settings)

  const displayText =
    text || (images.length ? `（${images.length} 张图片）` : '')
  const userMsg = {
    id: randomUUID(),
    role: 'user',
    content: displayText,
    createdAt: new Date().toISOString(),
    images: images.map((img, i) => ({
      id: img.id || `img-${i}`,
      name: img.name || `image-${i + 1}`,
      mediaType: img.mediaType,
      dataUrl: `data:${img.mediaType};base64,${img.data}`,
    })),
  }
  session.messages.push(userMsg)
  if (session.messages.filter(m => m.role === 'user').length === 1)
    session.title = (text || '图片提问').slice(0, 40) || session.title
  try {
    writeSession(session)
  } catch (e) {
    return res.status(500).json({ error: `保存会话失败: ${e?.message || e}` })
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  let closed = false
  res.on('close', () => {
    closed = true
  })

  const send = (event, data) => {
    if (closed || res.writableEnded) return false
    try {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
      return true
    } catch (e) {
      closed = true
      console.warn('[openclaude-gui] sse write failed:', e?.message || e)
      return false
    }
  }

  /// <summary> AI Cursor </summary>
  async function finalizeAssistant(
    assistantId,
    assistantText,
    usageLike,
    usageDetail = null,
    thinkingText = null,
    activity = null,
    filesChanged = null,
  ) {
    const promptTokens = Number(usageLike?.promptTokens ?? usageLike?.prompt_tokens) || 0
    const completionTokens =
      Number(usageLike?.completionTokens ?? usageLike?.completion_tokens) || 0
    const hasCounts = promptTokens > 0 || completionTokens > 0
    const price = await lookupModelPrice(modelId, {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      dataDir: DATA_DIR,
    })
    const { costCa } = calcTokenCostCa(price, promptTokens, completionTokens)
    const priceKnown = costCa != null && hasCounts

    const body = assistantText || '(空回复)'
    const footer = hasCounts
      ? buildCostFooter({
          promptTokens,
          completionTokens,
          costCa,
          priceKnown,
        })
      : '费用：本轮用量未返回，无法计价'

    const content = `${body}\n\n---\n${footer}`
    send('delta', { id: assistantId, text: `\n\n---\n${footer}` })

    const assistantMsg = {
      id: assistantId,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      model: modelId,
      ...(thinkingText ? { thinking: String(thinkingText) } : {}),
      ...(Array.isArray(activity) && activity.length ? { activity } : {}),
      ...(Array.isArray(filesChanged) && filesChanged.length
        ? { filesChanged }
        : {}),
      usage: hasCounts
        ? {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            costCa: priceKnown ? costCa : null,
            cacheReadInputTokens:
              Number(usageLike?.cacheReadInputTokens) || 0,
            cacheCreationInputTokens:
              Number(usageLike?.cacheCreationInputTokens) || 0,
            numTurns: usageLike?.numTurns ?? null,
          }
        : null,
      usageDetail: usageDetail || null,
      costFooter: footer,
    }
    session.messages.push(assistantMsg)
    session.updatedAt = new Date().toISOString()
    writeSession(session)
    send('done', {
      message: assistantMsg,
      session: {
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        agentSessionId: session.agentSessionId || null,
      },
    })
  }

  send('user', userMsg)
  const assistantId = randomUUID()
  send('assistant_start', { id: assistantId })
  send('status', {
    id: assistantId,
    text: '正在启动…',
  })

  const baseUrl = normalizeBaseUrl(settings.baseUrl)

  try {
    const workCwd =
      String(settings.cwd || '').trim() ||
      process.env.OPENCLAUDE_GUI_CWD ||
      path.resolve(GUI_ROOT, '..', '..')
    const configDir = path.join(DATA_DIR, 'openclaude-config')
    fs.mkdirSync(configDir, { recursive: true })

    let assistantText = ''
    let assistantThinking = ''
    const ac = new AbortController()
    res.on('close', () => {
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
    })

    const result = await runAgentTurn({
      guiRoot: GUI_ROOT,
      prompt: text,
      images,
      planMode: Boolean(settings.planMode),
      ollamaThink: Boolean(settings.ollamaThink),
      cwd: workCwd,
      model: modelId,
      apiKey: settings.apiKey,
      baseUrl,
      resumeSessionId: session.agentSessionId || null,
      configDir,
      signal: ac.signal,
      onEvent: ev => {
        touchHeartbeat()
        if (closed) return
        if (ev.type === 'delta' && ev.text) {
          assistantText += ev.text
          send('delta', { id: assistantId, text: ev.text })
        } else if (ev.type === 'tool') {
          const line = `\n[tool] ${ev.name}${ev.preview ? ` · ${ev.preview}` : ''}\n`
          assistantText += line
          send('tool', {
            id: assistantId,
            toolId: ev.id,
            name: ev.name,
            preview: ev.preview || '',
          })
          send('delta', { id: assistantId, text: line })
        } else if (ev.type === 'status' && ev.text) {
          send('status', { id: assistantId, text: ev.text })
        } else if (ev.type === 'thinking' && ev.text) {
          assistantThinking += ev.text
          send('thinking', { id: assistantId, text: ev.text })
        } else if (ev.type === 'thinking_done') {
          send('thinking_done', { id: assistantId })
        } else if (ev.type === 'activity' && ev.kind && ev.text) {
          send('activity', {
            id: assistantId,
            kind: ev.kind,
            text: ev.text,
            active: Boolean(ev.active),
            ms: typeof ev.ms === 'number' ? ev.ms : undefined,
          })
        } else if (ev.type === 'files_changed' && Array.isArray(ev.files)) {
          send('files_changed', {
            id: assistantId,
            files: ev.files,
          })
        }
      },
    })

    if (result.resumeCleared) session.agentSessionId = null
    if (result.agentSessionId) session.agentSessionId = result.agentSessionId
    if (!closed)
      await finalizeAssistant(
        assistantId,
        result.text || assistantText,
        result.usage,
        result.usageDetail || null,
        assistantThinking || null,
        result.activity || null,
        result.filesChanged || null,
      )
  } catch (err) {
    console.error('[openclaude-gui] chat error:', err)
    send('error', { error: err?.message || String(err) })
  }

  try {
    if (!res.writableEnded) res.end()
  } catch {
    /* ignore */
  }
})

const distDir = path.join(GUI_ROOT, 'dist')
if (fs.existsSync(distDir))
  app.use(express.static(distDir))

app.get(/^(?!\/api).*/, (req, res, next) => {
  if (DEV) return next()
  const index = path.join(distDir, 'index.html')
  if (fs.existsSync(index)) return res.sendFile(index)
  res.status(404).send('UI not built. Run npm run build in o0/GUI, or use --dev with vite.')
})

ensureDirs()

process.on('uncaughtException', err => {
  console.error('[openclaude-gui] uncaughtException:', err)
})
process.on('unhandledRejection', err => {
  console.error('[openclaude-gui] unhandledRejection:', err)
})

server = http.createServer(app)
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`
  console.log(`[openclaude-gui] listening on ${url}`)
  console.log(`[openclaude-gui] data dir: ${DATA_DIR}`)
  const cli = resolveOpenClaudeCli(GUI_ROOT)
  console.log(
    `[openclaude-gui] agent CLI: ${cli ? cli.label : 'NOT FOUND — agent mode unavailable'}`,
  )
  if (DEV)
    console.log('[openclaude-gui] DEV mode: start UI with npm run dev:ui (proxied to this API)')
  if (LIFETIME)
    console.log(
      `[openclaude-gui] lifetime: exit if no UI heartbeat for ${HEARTBEAT_MS}ms`,
    )
  if (OPEN_BROWSER) setTimeout(() => openBrowser(url), 400)
})

if (LIFETIME) {
  setInterval(() => {
    if (!lastHeartbeatAt || shuttingDown) return
    if (Date.now() - lastHeartbeatAt > HEARTBEAT_MS)
      shutdown('no heartbeat')
  }, HEARTBEAT_CHECK_MS).unref()
}
