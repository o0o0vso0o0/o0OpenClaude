/**
 * AI Cursor — OpenClaude GUI local server (no TUI).
 * Serves API + static UI. Proxies OpenAI-compatible chat (e.g. chatanywhere.tech).
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
  stripCostFooter,
  buildCostFooter,
} from './models-catalog.mjs'

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

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '4mb' }))
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
  res.json({
    baseUrl: s.baseUrl,
    model: s.model,
    apiKey: key,
    apiKeySet: Boolean(key.trim()),
    apiKeyPreview: key
      ? `${key.slice(0, 4)}…${key.slice(-4)}`
      : '',
  })
})

app.put('/api/settings', (req, res) => {
  const cur = readSettings()
  const body = req.body || {}
  const next = {
    baseUrl: body.baseUrl != null ? String(body.baseUrl).trim() : cur.baseUrl,
    model: body.model != null ? String(body.model).trim() : cur.model,
    apiKey: cur.apiKey,
    modelLastUsed: { ...(cur.modelLastUsed || {}) },
  }
  if (typeof body.apiKey === 'string') {
    const key = body.apiKey.trim()
    if (key && key !== '********') next.apiKey = key
  }
  if (body.clearApiKey === true) next.apiKey = ''
  // modelLastUsed only updates on real chat send (/api/chat), not on picker select
  const saved = writeSettings(next)
  const key = saved.apiKey ? String(saved.apiKey) : ''
  res.json({
    baseUrl: saved.baseUrl,
    model: saved.model,
    apiKey: key,
    apiKeySet: Boolean(key.trim()),
    apiKeyPreview: key
      ? `${key.slice(0, 4)}…${key.slice(-4)}`
      : '',
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

app.post('/api/chat', async (req, res) => {
  const { sessionId, content } = req.body || {}
  if (!sessionId || typeof content !== 'string' || !content.trim())
    return res.status(400).json({ error: 'sessionId and content required' })

  const session = readSession(sessionId)
  if (!session) return res.status(404).json({ error: 'session not found' })

  const settings = readSettings()
  if (!settings.apiKey || !String(settings.apiKey).trim())
    return res.status(400).json({ error: '请先在设置中填写 API Key' })

  const modelId = settings.model || DEFAULT_SETTINGS.model
  touchModelLastUsed(modelId, settings)

  const userMsg = {
    id: randomUUID(),
    role: 'user',
    content: content.trim(),
    createdAt: new Date().toISOString(),
  }
  session.messages.push(userMsg)
  if (session.messages.filter(m => m.role === 'user').length === 1)
    session.title = content.trim().slice(0, 40) || session.title
  try {
    writeSession(session)
  } catch (e) {
    return res.status(500).json({ error: `保存会话失败: ${e?.message || e}` })
  }

  const apiMessages = session.messages.map(m => ({
    role: m.role,
    content: stripCostFooter(m.content),
  }))

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  // IMPORTANT: use res 'close', not req 'close'.
  // Express has already consumed the POST body; req 'close' often fires immediately
  // and would abort the upstream stream loop → empty assistant replies.
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

  send('user', userMsg)

  const assistantId = randomUUID()
  let assistantText = ''
  /** @type {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number } | null} */
  let usage = null
  send('assistant_start', { id: assistantId })

  const baseUrl = normalizeBaseUrl(settings.baseUrl)
  const url = `${baseUrl}/chat/completions`

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: apiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    if (!upstream.ok) {
      const errText = await upstream.text()
      send('error', {
        error: `上游 API ${upstream.status}: ${errText.slice(0, 500)}`,
      })
      if (!res.writableEnded) res.end()
      return
    }

    const reader = upstream.body?.getReader()
    if (!reader) {
      send('error', { error: '上游无流式响应体' })
      if (!res.writableEnded) res.end()
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      if (closed) {
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        break
      }
      const { done, value } = await reader.read()
      if (done) break
      touchHeartbeat()
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() || ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload)
          if (json.usage && typeof json.usage === 'object') usage = json.usage
          const delta =
            json.choices?.[0]?.delta?.content ??
            json.choices?.[0]?.delta?.reasoning_content
          if (delta) {
            assistantText += delta
            if (!send('delta', { id: assistantId, text: delta })) break
          }
        } catch {
          // ignore partial JSON
        }
      }
    }

    if (!closed) {
      const promptTokens = Number(usage?.prompt_tokens) || 0
      const completionTokens = Number(usage?.completion_tokens) || 0
      const hasUsage = Boolean(usage)
      const price = await lookupModelPrice(modelId, {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        dataDir: DATA_DIR,
      })
      const { costCa } = calcTokenCostCa(price, promptTokens, completionTokens)
      const priceKnown = costCa != null && hasUsage

      const body = assistantText || '(空回复)'
      const footer = hasUsage
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
        usage: hasUsage
          ? {
              promptTokens,
              completionTokens,
              totalTokens: Number(usage?.total_tokens) || promptTokens + completionTokens,
              costCa: priceKnown ? costCa : null,
            }
          : null,
        costFooter: footer || null,
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
        },
      })
    }
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
  if (DEV)
    console.log('[openclaude-gui] DEV mode: start UI with npm run dev:ui (proxied to this API)')
  if (LIFETIME)
    console.log(
      `[openclaude-gui] lifetime: exit if no UI heartbeat for ${HEARTBEAT_MS}ms`,
    )
  if (OPEN_BROWSER) {
    setTimeout(() => openBrowser(url), 400)
  }
})

if (LIFETIME) {
  setInterval(() => {
    if (!lastHeartbeatAt || shuttingDown) return
    if (Date.now() - lastHeartbeatAt > HEARTBEAT_MS)
      shutdown('no heartbeat')
  }, HEARTBEAT_CHECK_MS).unref()
}
