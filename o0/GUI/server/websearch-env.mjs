/**
 * AI Cursor — env + lifecycle for local SearXNG under o0/WebSearch (or Release/WebSearch).
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import { spawn } from 'child_process'

/// <summary> AI Cursor </summary>
export function resolveWebSearchRoot(guiRoot) {
  const candidates = [
    path.resolve(guiRoot, '..', 'WebSearch'), // Release\gui → Release\WebSearch ; o0\GUI → o0\WebSearch
  ]
  for (const p of candidates)
    if (
      fs.existsSync(path.join(p, 'docker-compose.yml')) ||
      fs.existsSync(path.join(p, 'server.mjs'))
    )
      return p
  return path.resolve(guiRoot, '..', 'WebSearch')
}

/// <summary> AI Cursor </summary>
export function readSearxngPort(root) {
  let port = '8888'
  const envFile = path.join(root, '.env')
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/^\s*SEARXNG_PORT\s*=\s*(\d+)/m)
    if (m) port = m[1]
  }
  const portFile = path.join(root, '.compat.port')
  if (fs.existsSync(portFile)) {
    const t = fs.readFileSync(portFile, 'utf8').trim()
    if (/^\d+$/.test(t)) port = t
  }
  return port
}

/// <summary> AI Cursor </summary>
export function applyLocalSearxngEnv(env, guiRoot, opts = {}) {
  const root = resolveWebSearchRoot(guiRoot)
  const port = readSearxngPort(root)
  const base = `http://127.0.0.1:${port}/search`
  const tavily = String(
    opts.tavilyApiKey || env.TAVILY_API_KEY || process.env.TAVILY_API_KEY || '',
  ).trim()
  const mode = String(opts.webSearchBackend || '').trim().toLowerCase()
  // Settings: 'local' | 'tavily'. Missing → Tavily if key present, else local.
  const useTavily =
    mode === 'local' || mode === 'custom' || mode === 'searxng'
      ? false
      : mode === 'tavily'
        ? Boolean(tavily)
        : Boolean(tavily)

  if (tavily) env.TAVILY_API_KEY = tavily

  if (useTavily) {
    env.WEB_SEARCH_PROVIDER = 'tavily'
  } else {
    env.WEB_SEARCH_PROVIDER = 'custom'
    env.WEB_PROVIDER = 'searxng'
    env.WEB_SEARCH_API = base
    env.WEB_PARAMS = env.WEB_PARAMS || JSON.stringify({ format: 'json' })
    env.WEB_CUSTOM_ALLOW_HTTP = env.WEB_CUSTOM_ALLOW_HTTP || 'true'
    env.WEB_CUSTOM_ALLOW_PRIVATE = env.WEB_CUSTOM_ALLOW_PRIVATE || 'true'
  }
  env.OPENCLAUDE_WEBSEARCH_ROOT = root
  if (!env.WEB_SEARCH_API) env.WEB_SEARCH_API = base
  return {
    root,
    port,
    url: base,
    provider: env.WEB_SEARCH_PROVIDER,
    backend: useTavily ? 'tavily' : 'local',
    tavily: Boolean(tavily),
  }
}

/// <summary> AI Cursor </summary>
function resolveNodeForWebSearch(root) {
  const candidates = [
    path.resolve(root, '..', 'runtime', 'node', 'node.exe'), // Release\WebSearch
    path.resolve(root, '..', 'Release', 'runtime', 'node', 'node.exe'), // o0\WebSearch
    'node',
  ]
  for (const n of candidates) {
    if (n === 'node') return n
    if (fs.existsSync(n)) return n
  }
  return 'node'
}

/// <summary> AI Cursor </summary>
function probeHealth(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const req = http.get(
      `http://127.0.0.1:${port}/health`,
      { timeout: timeoutMs },
      res => {
        res.resume()
        resolve(res.statusCode >= 200 && res.statusCode < 500)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/// <summary> AI Cursor </summary>
function tryDockerComposeUp(root) {
  try {
    const r = spawn('docker', ['compose', 'up', '-d'], {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
      shell: true,
    })
    return new Promise(resolve => {
      r.on('error', () => resolve(false))
      r.on('exit', code => resolve(code === 0))
    })
  } catch {
    return Promise.resolve(false)
  }
}

/// <summary> AI Cursor </summary>
export async function ensureLocalSearxngStarted(guiRoot) {
  const root = resolveWebSearchRoot(guiRoot)
  if (!fs.existsSync(root)) return { ok: false, reason: 'missing WebSearch dir' }
  const port = readSearxngPort(root)
  if (await probeHealth(port))
    return { ok: true, mode: 'already', port }

  if (await tryDockerComposeUp(root)) {
    for (let i = 0; i < 20; i++) {
      if (await probeHealth(port)) return { ok: true, mode: 'docker', port }
      await new Promise(r => setTimeout(r, 250))
    }
  }

  const serverJs = path.join(root, 'server.mjs')
  if (!fs.existsSync(serverJs))
    return { ok: false, reason: 'no server.mjs' }

  const node = resolveNodeForWebSearch(root)
  const logFile = path.join(root, 'compat.log')
  const out = fs.openSync(logFile, 'a')
  const child = spawn(node, [serverJs], {
    cwd: root,
    env: { ...process.env, SEARXNG_PORT: String(port) },
    windowsHide: true,
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  fs.writeFileSync(path.join(root, '.compat.port'), String(port), 'utf8')
  if (child.pid)
    fs.writeFileSync(path.join(root, '.compat.pid'), String(child.pid), 'utf8')

  for (let i = 0; i < 30; i++) {
    if (await probeHealth(port))
      return { ok: true, mode: 'compat', port, pid: child.pid }
    await new Promise(r => setTimeout(r, 100))
  }
  return { ok: false, reason: 'compat start timeout', port, pid: child.pid }
}

/// <summary> AI Cursor </summary>
export function stopLocalSearxng(guiRoot) {
  const root = resolveWebSearchRoot(guiRoot)
  const port = readSearxngPort(root)
  const pidFile = path.join(root, '.compat.pid')
  let killed = false

  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid)
        killed = true
      } catch {
        /* already gone */
      }
    }
    try {
      fs.unlinkSync(pidFile)
    } catch {
      /* ignore */
    }
  }

  // Port fallback (Windows): taskkill via powershell if still listening
  if (process.platform === 'win32') {
    try {
      spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ],
        { windowsHide: true, stdio: 'ignore', shell: false },
      )
      killed = true
    } catch {
      /* ignore */
    }
  }

  try {
    spawn('docker', ['compose', 'down'], {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
      shell: true,
    })
  } catch {
    /* ignore */
  }

  try {
    fs.unlinkSync(path.join(root, '.compat.port'))
  } catch {
    /* ignore */
  }

  return { ok: true, killed, port }
}
