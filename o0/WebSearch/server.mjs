/**
 * AI Cursor — SearXNG-compatible JSON search for OpenClaude when Docker is unavailable.
 * GET /search?q=...&format=json  →  { results: [{ title, url, content, engine }] }
 * Primary scrape: Bing (reachable in more networks); DuckDuckGo as fallback.
 */
import http from 'http'
import { URL } from 'url'

const PORT = Number(process.env.SEARXNG_PORT || 8888)
const HOST = process.env.SEARXNG_HOST || '127.0.0.1'

/// <summary> AI Cursor </summary>
function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/// <summary> AI Cursor </summary>
function decodeBingUrl(href) {
  try {
    const u = new URL(href, 'https://www.bing.com')
    if (u.hostname.includes('bing.com') && u.pathname === '/ck/a') {
      const u2 = u.searchParams.get('u')
      if (u2) {
        // Bing often prefixes with "a1" then base64
        const raw = u2.startsWith('a1') ? u2.slice(2) : u2
        try {
          const decoded = Buffer.from(raw, 'base64').toString('utf8')
          if (/^https?:\/\//i.test(decoded)) return decoded
        } catch {
          /* keep */
        }
      }
    }
    return u.href
  } catch {
    return href
  }
}

/// <summary> AI Cursor </summary>
async function searchBingHtml(query, signal) {
  const url =
    'https://www.bing.com/search?q=' +
    encodeURIComponent(query) +
    '&setlang=zh-CN&cc=CN'
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal,
  })
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`)
  const html = await res.text()
  const results = []
  // Organic results: <li class="b_algo"> ... <h2><a href="...">title</a></h2> ... <p>snippet
  const blocks = html.split(/<li class="b_algo"/i).slice(1)
  for (const block of blocks) {
    if (results.length >= 12) break
    const am = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!am) continue
    const href = decodeBingUrl(am[1])
    const title = stripTags(am[2])
    const sm =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
    const content = stripTags(sm?.[1] || '')
    if (title && href && /^https?:\/\//i.test(href) && !href.includes('bing.com/'))
      results.push({ title, url: href, content, engine: 'bing' })
  }
  if (!results.length) throw new Error('Bing returned 0 parseable results')
  return results
}

/// <summary> AI Cursor </summary>
async function searchDuckDuckGoHtml(query, signal) {
  const body = new URLSearchParams({ q: query })
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    body,
    signal,
  })
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`)
  const html = await res.text()
  const results = []
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>|)/gi
  let m
  while ((m = re.exec(html)) && results.length < 12) {
    let url = m[1]
    try {
      const u = new URL(url, 'https://duckduckgo.com')
      if (u.hostname.includes('duckduckgo.com') && u.searchParams.has('uddg'))
        url = decodeURIComponent(u.searchParams.get('uddg') || url)
    } catch {
      /* keep */
    }
    const title = stripTags(m[2])
    const content = stripTags(m[3] || '')
    if (title && url && /^https?:\/\//i.test(url))
      results.push({ title, url, content, engine: 'duckduckgo' })
  }
  if (!results.length) throw new Error('DuckDuckGo returned 0 parseable results')
  return results
}

/// <summary> AI Cursor </summary>
async function runSearch(query) {
  const ctrl = AbortSignal.timeout(20000)
  const errors = []
  for (const fn of [searchBingHtml, searchDuckDuckGoHtml]) {
    try {
      return await fn(query, ctrl)
    } catch (e) {
      errors.push(e?.message || String(e))
    }
  }
  throw new Error(errors.join(' | '))
}

/// <summary> AI Cursor </summary>
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    if (u.pathname === '/health' || u.pathname === '/') {
      sendJson(res, 200, {
        ok: true,
        service: 'openclaude-searxng-compat',
        note: 'Docker SearXNG preferred; Node fallback scrapes Bing/DDG.',
      })
      return
    }
    if (u.pathname !== '/search') {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const q = (u.searchParams.get('q') || u.searchParams.get('query') || '').trim()
    if (!q) {
      sendJson(res, 400, { error: 'missing q', results: [] })
      return
    }
    const results = await runSearch(q)
    sendJson(res, 200, {
      query: q,
      number_of_results: results.length,
      results,
    })
  } catch (e) {
    sendJson(res, 502, {
      error: e?.message || String(e),
      results: [],
    })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[WebSearch-compat] listening http://${HOST}:${PORT}/search?q=...&format=json`)
})
