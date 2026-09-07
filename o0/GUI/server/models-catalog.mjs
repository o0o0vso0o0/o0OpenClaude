/**
 * AI Cursor — ChatAnywhere model catalog (API + pricing doc).
 * Pricing: https://chatanywhere.apifox.cn/doc-2694962
 */
import fs from 'fs'
import path from 'path'

const SERIES_ORDER = [
  'local',
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

/** Default local Ollama OpenAI-compatible endpoint */
export const LOCAL_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'
export const LOCAL_OLLAMA_API_KEY = 'ollama'

/** Built-in local deployments (one row per quant; Thinking is a separate toggle). */
const LOCAL_OLLAMA_DEPLOYMENTS = [
  {
    ollamaId: 'qwen3.8:27b',
    label: '千问3.8 · 27B · Q4',
    description: '推荐（快，已验证可跑）',
  },
  {
    ollamaId: 'qwen3.8:27b-q8_0',
    label: '千问3.8 · 27B · Q8',
    description: '更高保真，~30GB',
  },
  {
    ollamaId: 'qwen3.8:27b-mxfp8',
    label: '千问3.8 · 27B · FP8',
    description: '~32GB；Windows/AMD 可能不稳定',
  },
  {
    ollamaId: 'qwen3.8:27b-bf16',
    label: '千问3.8 · 27B · BF16',
    description: '~56GB；需大页面文件，加载峰值高',
  },
]

/// <summary> AI Cursor </summary>
export function localQuantTag(ollamaId) {
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
export function localModelLabel(ollamaId) {
  const id = String(ollamaId || '').trim()
  const known = LOCAL_OLLAMA_DEPLOYMENTS.find(d => d.ollamaId === id)
  if (known?.label) return known.label
  const quant = localQuantTag(id)
  if (/^qwen3\.8:27b/i.test(id))
    return `千问3.8 · 27B · ${quant || '本地'}`
  return quant ? `${id} · ${quant}` : id || '未选模型'
}

/// <summary> AI Cursor </summary>
export function localDisplayLabel(ollamaId, think) {
  const base = localModelLabel(ollamaId)
  if (!base) return '未选模型'
  return `${base} · ${think ? 'Think开' : 'Think关'}`
}

/** @deprecated use LOCAL_OLLAMA_DEPLOYMENTS — kept for id checks */
const LOCAL_OLLAMA_FALLBACK = LOCAL_OLLAMA_DEPLOYMENTS.map(d => ({
  id: d.ollamaId,
  description: d.description,
}))

/// <summary> AI Cursor </summary>
export function localCatalogId(ollamaId, think) {
  return `${String(ollamaId || '').trim()}|think=${think ? '1' : '0'}`
}

/// <summary> AI Cursor </summary>
export function parseLocalModelSelection(selectionId) {
  const raw = String(selectionId || '').trim()
  const m = raw.match(/^(.*)\|think=([01])$/i)
  if (m)
    return {
      model: m[1].trim(),
      ollamaThink: m[2] === '1',
      catalogId: raw,
    }
  return {
    model: raw,
    ollamaThink: null,
    catalogId: raw,
  }
}

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
export function isLocalOllamaBaseUrl(baseUrl) {
  const u = String(baseUrl || '').toLowerCase()
  return (
    u.includes('127.0.0.1:11434') ||
    u.includes('localhost:11434') ||
    u.includes('0.0.0.0:11434')
  )
}

/// <summary> AI Cursor </summary>
export function isLocalOllamaModelId(modelId) {
  const parsed = parseLocalModelSelection(modelId)
  const id = String(parsed.model || '').trim().toLowerCase()
  if (!id) return false
  if (LOCAL_OLLAMA_DEPLOYMENTS.some(m => m.ollamaId.toLowerCase() === id))
    return true
  // Ollama-style tags: name:tag
  if (/^qwen3\.8:/.test(id)) return true
  return false
}

/// <summary> AI Cursor </summary>
async function fetchApiModels(baseUrl, apiKey) {
  if (!apiKey && !isLocalOllamaBaseUrl(baseUrl)) return []
  let u = String(baseUrl || '').replace(/\/+$/, '')
  if (!/\/v1$/i.test(u)) u = `${u}/v1`
  const res = await fetch(`${u}/models`, {
    headers: { Authorization: `Bearer ${apiKey || LOCAL_OLLAMA_API_KEY}` },
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
async function fetchLocalOllamaModels(localBaseUrl = LOCAL_OLLAMA_BASE_URL) {
  /** @type {Map<string, object>} */
  const byId = new Map()
  /** @type {Set<string>} */
  let onlineIds = new Set()

  for (const d of LOCAL_OLLAMA_DEPLOYMENTS) {
    byId.set(d.ollamaId, {
      id: d.ollamaId,
      ollamaId: d.ollamaId,
      label: d.label || localModelLabel(d.ollamaId),
      created: 0,
      ownedBy: 'local-ollama',
      description: d.description,
      online: false,
    })
  }

  try {
    const listed = await fetchApiModels(localBaseUrl, LOCAL_OLLAMA_API_KEY)
    onlineIds = new Set(listed.map(m => m.id))
    for (const m of listed) {
      const prev = byId.get(m.id)
      if (prev) {
        byId.set(m.id, {
          ...prev,
          created: m.created || 0,
          online: true,
        })
        continue
      }
      if (!LOCAL_OLLAMA_DEPLOYMENTS.some(d => d.ollamaId === m.id)) {
        byId.set(m.id, {
          id: m.id,
          ollamaId: m.id,
          label: localModelLabel(m.id),
          created: m.created || 0,
          ownedBy: m.ownedBy || 'local-ollama',
          description: '本地 Ollama',
          online: true,
        })
      }
    }
  } catch {
    /* Ollama down — keep fallbacks */
  }

  for (const entry of byId.values()) {
    if (onlineIds.has(entry.ollamaId)) entry.online = true
  }

  return [...byId.values()]
}

/// <summary> AI Cursor </summary>
function mergeLocalModels(catalog, localModels) {
  const models = [...(catalog.models || [])]
  const tabs = [...(catalog.tabs || [])].filter(t => t.id !== 'local')
  const localEntries = (localModels || []).map(m => ({
    id: m.id,
    ollamaId: m.ollamaId || parseLocalModelSelection(m.id).model,
    label:
      m.label ||
      localModelLabel(m.ollamaId || parseLocalModelSelection(m.id).model),
    series: 'local',
    created: m.created || 0,
    createdLabel: m.created
      ? new Date(m.created * 1000).toISOString().slice(0, 10)
      : '',
    ownedBy: m.ownedBy || 'local-ollama',
    price: {
      kind: 'token',
      input: 0,
      output: 0,
      unit: '1K Tokens',
      label: '本地',
    },
    priceLabel: '本地',
    description: m.description || '本地 Ollama',
    fromApi: Boolean(m.online),
    fromPricing: false,
    provider: 'ollama',
    baseUrl: LOCAL_OLLAMA_BASE_URL,
  }))

  for (const entry of localEntries) {
    const i = models.findIndex(x => x.id === entry.id)
    if (i >= 0) models[i] = { ...models[i], ...entry }
    else models.push(entry)
  }

  const localTab = {
    id: 'local',
    label: 'LOCAL',
    count: localEntries.length,
    models: localEntries,
  }
  return {
    ...catalog,
    models,
    tabs: [localTab, ...tabs],
    localOllama: {
      baseUrl: LOCAL_OLLAMA_BASE_URL,
      online: localEntries.some(m => m.fromApi),
      count: localEntries.length,
    },
  }
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
export async function getModelsCatalog({
  baseUrl,
  apiKey,
  dataDir,
  force = false,
  cloudBaseUrl = null,
  cloudApiKey = null,
  localBaseUrl = LOCAL_OLLAMA_BASE_URL,
}) {
  const cachePath = path.join(dataDir, 'models-cache.json')
  const now = Date.now()

  // Always fetch cloud list from cloud endpoint (not current baseUrl if on Ollama).
  const pricingBase = cloudBaseUrl ||
    (isLocalOllamaBaseUrl(baseUrl) ? 'https://api.chatanywhere.tech/v1' : baseUrl)
  const pricingKey =
    cloudApiKey != null && String(cloudApiKey).trim()
      ? String(cloudApiKey)
      : isLocalOllamaBaseUrl(baseUrl)
        ? ''
        : apiKey

  if (!force && memoryCache && now - memoryCache.at < CACHE_TTL_MS) {
    const localModels = await fetchLocalOllamaModels(localBaseUrl)
    return mergeLocalModels(memoryCache.catalog, localModels)
  }

  if (!force && fs.existsSync(cachePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      if (raw?.at && now - raw.at < CACHE_TTL_MS && raw.catalog?.tabs) {
        const localModels = await fetchLocalOllamaModels(localBaseUrl)
        return mergeLocalModels(raw.catalog, localModels)
      }
    } catch {
      /* ignore */
    }
  }

  let apiModels = []
  let apiError = null
  try {
    apiModels = await fetchApiModels(pricingBase, pricingKey)
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

  const localModels = await fetchLocalOllamaModels(localBaseUrl)

  if (pricingMap.size === 0 && apiModels.length === 0 && localModels.length === 0) {
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

  // Cache cloud-only catalog; local list is merged fresh each time.
  memoryCache = { at: now, catalog }
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify({ at: now, catalog }), 'utf8')
  } catch {
    /* ignore cache write */
  }
  return mergeLocalModels(catalog, localModels)
}

/// <summary> AI Cursor </summary>
export async function lookupModelPrice(modelId, opts) {
  const id = String(modelId || '').trim()
  if (!id) return null
  try {
    const catalog = await getModelsCatalog(opts)
    const hit = (catalog.models || []).find(m => m.id === id)
    if (hit?.price) return hit.price
    for (const tab of catalog.tabs || []) {
      const m = (tab.models || []).find(x => x.id === id)
      if (m?.price) return m.price
    }
  } catch {
    /* ignore */
  }
  return null
}

/// <summary> AI Cursor </summary>
export function formatCaAmount(n) {
  if (!Number.isFinite(n)) return '?'
  if (n === 0) return '0'
  if (n > 0 && n < 1e-6) return n.toExponential(2)
  const s = n.toFixed(6).replace(/\.?0+$/, '')
  return s || '0'
}

/// <summary> AI Cursor </summary>
export function calcTokenCostCa(price, promptTokens, completionTokens) {
  const pin = Number(promptTokens) || 0
  const pout = Number(completionTokens) || 0
  if (!price || price.kind !== 'token')
    return { costCa: null, inputRate: null, outputRate: null }
  const unit = String(price.unit || '1K Tokens').toLowerCase()
  const per = unit.includes('1m') || unit.includes('百万') ? 1_000_000 : 1000
  const inputRate = Number(price.input) || 0
  const outputRate = Number(price.output) || 0
  const costCa = (pin / per) * inputRate + (pout / per) * outputRate
  return { costCa, inputRate, outputRate, per }
}

const COST_FOOTER_RE = /\n\n---\n费用：[\s\S]*$/

/// <summary> AI Cursor </summary>
export function stripCostFooter(content) {
  return String(content || '').replace(COST_FOOTER_RE, '')
}

/// <summary> AI Cursor </summary>
export function buildCostFooter({
  promptTokens,
  completionTokens,
  costCa,
  priceKnown,
}) {
  const pin = Number(promptTokens) || 0
  const pout = Number(completionTokens) || 0
  const turnCost =
    priceKnown && Number.isFinite(costCa)
      ? `${formatCaAmount(costCa)} CA`
      : '价格未知'
  return `费用：入 ${pin} / 出 ${pout} tokens · ${turnCost}`
}
