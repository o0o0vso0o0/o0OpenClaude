/**
 * AI Cursor — ChatAnywhere model catalog (API + pricing doc).
 * Pricing: https://chatanywhere.apifox.cn/doc-2694962
 */
import fs from 'fs'
import path from 'path'

const SERIES_ORDER = [
  'claude',
  'gpt',
  'o',
  'deepseek',
  'kimi',
  'qwen',
  'gemini',
  'glm',
  'minimax',
  'grok',
  'ca',
]

const PRICING_DOC_URL = 'https://chatanywhere.apifox.cn/doc-2694962'
const CACHE_TTL_MS = 60 * 60 * 1000

let memoryCache = null

/// <summary> AI Cursor </summary>
function seriesOf(name) {
  if (!name) return 'other'
  let i = 0
  while (i < name.length && /[A-Za-z]/.test(name[i])) i++
  return (i > 0 ? name.slice(0, i) : 'other').toLowerCase()
}

/// <summary> AI Cursor </summary>
function parseFirstNumber(text) {
  const m = String(text || '').match(/\d+(\.\d+)?/)
  return m ? Number(m[0]) : 0
}

/// <summary> AI Cursor </summary>
function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/// <summary> AI Cursor </summary>
function extractTables(html) {
  const out = []
  let i = 0
  while (i < html.length) {
    const start = html.toLowerCase().indexOf('<table', i)
    if (start < 0) break
    let depth = 1
    let pos = start + 6
    while (depth > 0 && pos < html.length) {
      const open = html.toLowerCase().indexOf('<table', pos)
      const close = html.toLowerCase().indexOf('</table>', pos)
      if (close < 0) break
      if (open >= 0 && open < close) {
        depth++
        pos = open + 6
      } else {
        depth--
        pos = close + 8
      }
    }
    if (depth !== 0) break
    out.push(html.slice(start, pos))
    i = pos
  }
  return out
}

/// <summary> AI Cursor </summary>
function tableHeaders(tableHtml) {
  const thead = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)
  const headBlock = thead ? thead[1] : tableHtml
  const firstTr = headBlock.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)
  if (!firstTr) return []
  return [...firstTr[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m =>
    stripHtml(m[1]),
  )
}

/// <summary> AI Cursor </summary>
function tableBodyRows(tableHtml) {
  const tbody = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)
  const body = tbody ? tbody[1] : tableHtml
  const rows = []
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cols = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
      stripHtml(m[1]),
    )
    if (cols.length) rows.push(cols)
  }
  return rows
}

/// <summary> AI Cursor </summary>
function isMainPricingHeader(headers) {
  const h = headers.join(' ')
  return h.includes('模型') && h.includes('Input') && h.includes('Output') && h.includes('特点')
}

/// <summary> AI Cursor </summary>
function isSpecialPricingHeader(headers) {
  const h = headers.join(' ')
  return h.includes('模型') && h.includes('价格') && h.includes('支持')
}

/// <summary> AI Cursor </summary>
function parseSpecialPrice(priceText) {
  const p = String(priceText || '').trim()
  const lower = p.toLowerCase()
  if (/图.*token|token.*图|text.?input|image.?input/i.test(p) || lower.includes('text'))
    return {
      kind: 'imageTokens',
      label: p,
      textInput: parseFirstNumber(p),
    }
  if (p.includes('分钟') && (p.includes('Token') || p.includes('token')))
    return {
      kind: 'minuteAndToken',
      label: p,
      minute: parseFirstNumber(p),
      token: parseFirstNumber(p.replace(/^.*?[/／]/, '') || p),
    }
  if (p.includes('张') || /\/\s*img/i.test(p))
    return { kind: 'image', label: p, image: parseFirstNumber(p) }
  if (p.includes('字符') || lower.includes('char'))
    return { kind: 'token', label: p, input: parseFirstNumber(p), output: 0, unit: '1K chars' }
  if (p.includes('次') || lower.includes('/call'))
    return { kind: 'use', label: p, call: parseFirstNumber(p) }
  if (p.includes('分钟'))
    return { kind: 'minute', label: p, minute: parseFirstNumber(p) }
  return { kind: 'token', label: p, input: parseFirstNumber(p), output: 0, unit: '1K Tokens' }
}

/// <summary> AI Cursor </summary>
function formatPrice(price) {
  if (!price) return '价格未知'
  if (price.kind === 'token') {
    const unit = price.unit || '1K Tokens'
    const note = price.note ? ` ${price.note}` : ''
    return `入 ${price.input} / 出 ${price.output} /${unit}${note}`
  }
  if (price.kind === 'image') return `${price.image} / 张`
  if (price.kind === 'minute') return `${price.minute} / 分钟`
  if (price.kind === 'use') return `${price.call} / 次`
  if (price.kind === 'minuteAndToken')
    return `${price.minute}/分钟 + ${price.token}/1K Tokens`
  if (price.kind === 'imageTokens') return price.label || '按图+Token'
  return price.label || '价格未知'
}

/// <summary> AI Cursor </summary>
async function fetchPricingDoc() {
  const res = await fetch(PRICING_DOC_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://chatanywhere.apifox.cn/',
    },
  })
  if (!res.ok) throw new Error(`pricing doc HTTP ${res.status}`)
  return await res.text()
}

/// <summary> AI Cursor </summary>
function parsePricingHtml(html) {
  /** @type {Map<string, object>} */
  const map = new Map()
  for (const tableHtml of extractTables(html)) {
    const headers = tableHeaders(tableHtml)
    const rows = tableBodyRows(tableHtml)
    if (isMainPricingHeader(headers)) {
      for (const cols of rows) {
        if (cols.length < 5) continue
        const name = cols[0].trim()
        if (!name || name.includes('模型')) continue
        const inputRaw = cols[1]
        const outputRaw = cols[2]
        const noteBits = []
        if (/阶梯/.test(inputRaw) || /阶梯/.test(outputRaw)) noteBits.push('阶梯计价')
        if (/搜索/.test(outputRaw)) noteBits.push('含搜索费')
        map.set(name, {
          name,
          price: {
            kind: 'token',
            input: parseFirstNumber(inputRaw),
            output: parseFirstNumber(outputRaw),
            unit: '1K Tokens',
            note: noteBits.length ? `(${noteBits.join('·')})` : '',
          },
          description: cols[4] || '',
          supported: (cols[3] || '').includes('支持'),
        })
        const p = map.get(name).price
        p.label = formatPrice(p)
      }
    } else if (isSpecialPricingHeader(headers)) {
      for (const cols of rows) {
        if (cols.length < 3) continue
        const name = cols[0].trim()
        if (!name || name.includes('模型')) continue
        const parsed = parseSpecialPrice(cols[1])
        parsed.label = formatPrice(parsed) === '价格未知' ? cols[1] : formatPrice(parsed)
        map.set(name, {
          name,
          price: { ...parsed, label: parsed.label || cols[1] },
          description: '',
          supported: (cols[2] || '').includes('支持'),
        })
      }
    }
  }
  return map
}

/// <summary> AI Cursor </summary>
async function fetchApiModels(baseUrl, apiKey) {
  if (!apiKey) return []
  let u = String(baseUrl || '').replace(/\/+$/, '')
  if (!/\/v1$/i.test(u)) u = `${u}/v1`
  const res = await fetch(`${u}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`models API HTTP ${res.status}`)
  const json = await res.json()
  const data = Array.isArray(json?.data) ? json.data : []
  return data
    .map(m => ({
      id: String(m.id || ''),
      created: Number(m.created) || 0,
      ownedBy: String(m.owned_by || ''),
    }))
    .filter(m => m.id)
}

/// <summary> AI Cursor </summary>
function buildCatalog(apiModels, pricingMap) {
  /** @type {Map<string, object>} */
  const merged = new Map()

  for (const [name, p] of pricingMap) {
    merged.set(name, {
      id: name,
      series: seriesOf(name),
      created: 0,
      ownedBy: '',
      price: p.price,
      priceLabel: p.price?.label || formatPrice(p.price),
      description: p.description || '',
      fromApi: false,
      fromPricing: true,
    })
  }

  for (const m of apiModels) {
    const prev = merged.get(m.id)
    if (prev) {
      prev.created = m.created
      prev.ownedBy = m.ownedBy
      prev.fromApi = true
    } else {
      merged.set(m.id, {
        id: m.id,
        series: seriesOf(m.id),
        created: m.created,
        ownedBy: m.ownedBy,
        price: null,
        priceLabel: '价格未知',
        description: '',
        fromApi: true,
        fromPricing: false,
      })
    }
  }

  const models = [...merged.values()].map(m => ({
    ...m,
    priceLabel: m.priceLabel || formatPrice(m.price),
    createdLabel: m.created
      ? new Date(m.created * 1000).toISOString().slice(0, 10)
      : '',
  }))

  // Prefer chat-like models in picker: keep those with token price OR known chat series
  const chatish = models.filter(m => {
    const n = m.id.toLowerCase()
    if (n.includes('embedding') || n.includes('whisper') || n.includes('tts')) return false
    if (n.includes('dall-e') || n.includes('gpt-image') || n.includes('moderation')) return false
    if (n.includes('ocr') && !n.includes('chat')) return false
    return true
  })

  const bySeries = new Map()
  for (const m of chatish) {
    const s = m.series || 'other'
    if (!bySeries.has(s)) bySeries.set(s, [])
    bySeries.get(s).push(m)
  }

  for (const list of bySeries.values()) {
    list.sort((a, b) => {
      if (b.created !== a.created) return b.created - a.created
      return a.id.localeCompare(b.id)
    })
  }

  const known = SERIES_ORDER.filter(s => bySeries.has(s))
  const rest = [...bySeries.keys()]
    .filter(s => !SERIES_ORDER.includes(s))
    .sort((a, b) => a.localeCompare(b))
  const tabs = [...known, ...rest].map(id => ({
    id,
    label: id.toUpperCase(),
    count: bySeries.get(id).length,
    models: bySeries.get(id),
  }))

  return {
    source: 'chatanywhere',
    pricingUrl: PRICING_DOC_URL,
    currencyNote: '单位：CA币（元）/ 文档价',
    fetchedAt: new Date().toISOString(),
    tabs,
    models: chatish,
  }
}

/// <summary> AI Cursor </summary>
export async function getModelsCatalog({ baseUrl, apiKey, dataDir, force = false }) {
  const cachePath = path.join(dataDir, 'models-cache.json')
  const now = Date.now()

  if (!force && memoryCache && now - memoryCache.at < CACHE_TTL_MS)
    return memoryCache.catalog

  if (!force && fs.existsSync(cachePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      if (raw?.at && now - raw.at < CACHE_TTL_MS && raw.catalog?.tabs)
        return raw.catalog
    } catch {
      /* ignore */
    }
  }

  let apiModels = []
  let apiError = null
  try {
    apiModels = await fetchApiModels(baseUrl, apiKey)
  } catch (e) {
    apiError = e?.message || String(e)
  }

  let pricingMap = new Map()
  let pricingError = null
  try {
    const html = await fetchPricingDoc()
    pricingMap = parsePricingHtml(html)
  } catch (e) {
    pricingError = e?.message || String(e)
  }

  if (pricingMap.size === 0 && apiModels.length === 0) {
    throw new Error(
      `无法加载模型列表${apiError ? `（API: ${apiError}）` : ''}${
        pricingError ? `（定价文档: ${pricingError}）` : ''
      }`,
    )
  }

  const catalog = buildCatalog(apiModels, pricingMap)
  catalog.apiError = apiError
  catalog.pricingError = pricingError
  catalog.apiCount = apiModels.length
  catalog.pricingCount = pricingMap.size

  memoryCache = { at: now, catalog }
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify({ at: now, catalog }), 'utf8')
  } catch {
    /* ignore cache write */
  }
  return catalog
}
