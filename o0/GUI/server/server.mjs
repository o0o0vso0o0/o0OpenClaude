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
  /** Agent 工作目录（仓库根） */
  cwd: '',
  /** Plan mode：只读规划，限制写文件 */
  planMode: false,
  /** @type {Record<string, string>} modelId -> ISO last-used time */
  modelLastUsed: {},
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

function listSessions() {
  ensureDirs()
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  const sessions = files.map(f => {
    const full = path.join(SESSIONS_DIR, f)
    const data = JSON.parse(fs.readFileSync(full, 'utf8'))
    return {
      id: data.id,
      title: data.title || '新会话',
      updatedAt: data.updatedAt || data.createdAt,
      createdAt: data.createdAt,
      messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
    }
  })
  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return sessions
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
      dataDir: DATA_DIR,
      force,
    })
    res.json(attachFrequentTab(catalog, settings.modelLastUsed))
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) })
  }
})

app.get('/api/settings', (_req, res) => {
  const s = readSettings()
  const key = s.apiKey ? String(s.apiKey) : ''
  const cli = resolveOpenClaudeCli(GUI_ROOT)
  res.json({
    baseUrl: s.baseUrl,
    model: s.model,
    cwd: s.cwd || '',
    planMode: Boolean(s.planMode),
    apiKey: key,
    apiKeySet: Boolean(key.trim()),
    apiKeyPreview: key
      ? `${key.slice(0, 4)}…${key.slice(-4)}`
      : '',
    agentCli: cli?.label || null,
    agentReady: Boolean(cli),
  })
})

app.put('/api/settings', (req, res) => {
  const cur = readSettings()
  const body = req.body || {}
  const next = {
    baseUrl: body.baseUrl != null ? String(body.baseUrl).trim() : cur.baseUrl,
    model: body.model != null ? String(body.model).trim() : cur.model,
    cwd: body.cwd != null ? String(body.cwd).trim() : cur.cwd || '',
    planMode:
      body.planMode != null ? Boolean(body.planMode) : Boolean(cur.planMode),
    apiKey: cur.apiKey,
    modelLastUsed: { ...(cur.modelLastUsed || {}) },
  }
  if (typeof body.apiKey === 'string') {
    const key = body.apiKey.trim()
    if (key && key !== '********') next.apiKey = key
  }
  if (body.clearApiKey === true) next.apiKey = ''
  const saved = writeSettings(next)
  const key = saved.apiKey ? String(saved.apiKey) : ''
  const cli = resolveOpenClaudeCli(GUI_ROOT)
  res.json({
    baseUrl: saved.baseUrl,
    model: saved.model,
    cwd: saved.cwd || '',
    planMode: Boolean(saved.planMode),
    apiKey: key,
    apiKeySet: Boolean(key.trim()),
    apiKeyPreview: key
      ? `${key.slice(0, 4)}…${key.slice(-4)}`
      : '',
    agentCli: cli?.label || null,
    agentReady: Boolean(cli),
  })
})

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: listSessions() })
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
    messages: [],
  }
  writeSession(session)
  res.status(201).json(session)
})

app.get('/api/sessions/:id', (req, res) => {
  const session = readSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  res.json(session)
})

app.patch('/api/sessions/:id', (req, res) => {
  const session = readSession(req.params.id)
  if (!session) return res.status(404).json({ error: 'session not found' })
  if (typeof req.body?.title === 'string' && req.body.title.trim())
    session.title = req.body.title.trim()
  session.updatedAt = new Date().toISOString()
  writeSession(session)
  res.json(session)
})

app.delete('/api/sessions/:id', (req, res) => {
  const p = sessionPath(req.params.id)
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'session not found' })
  fs.unlinkSync(p)
  res.json({ ok: true })
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

  const baseUrl = normalizeBaseUrl(settings.baseUrl)

  try {
    const workCwd =
      String(settings.cwd || '').trim() ||
      process.env.OPENCLAUDE_GUI_CWD ||
      path.resolve(GUI_ROOT, '..', '..')
    const configDir = path.join(DATA_DIR, 'openclaude-config')
    fs.mkdirSync(configDir, { recursive: true })

    let assistantText = ''
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
