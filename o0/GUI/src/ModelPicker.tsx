/// <summary> AI Cursor </summary>
import { useEffect, useMemo, useState } from 'react'
import { fetchModels, type ModelEntry, type ModelsCatalog } from './api'

type Props = {
  currentModel: string
  onSelect: (modelId: string) => void
  onClose: () => void
}

/// <summary> AI Cursor </summary>
function selectionMatches(m: ModelEntry, currentModel: string): boolean {
  if (m.provider === 'ollama' || m.ollamaId)
    return (m.ollamaId || m.id) === currentModel
  return m.id === currentModel
}

/// <summary> AI Cursor </summary>
export default function ModelPicker({ currentModel, onSelect, onClose }: Props) {
  const [catalog, setCatalog] = useState<ModelsCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tabId, setTabId] = useState<string>('')
  const [query, setQuery] = useState('')

  async function load(refresh = false) {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchModels(refresh)
      setCatalog(data)
      if (!tabId && data.tabs.length > 0) {
        const frequent = data.tabs.find(t => t.id === 'frequent')
        const local = data.tabs.find(t => t.id === 'local')
        const hit = data.tabs.find(t =>
          t.models.some(m => m.id === currentModel),
        )
        if (hit) setTabId(hit.id)
        else if (local && local.count > 0) setTabId('local')
        else if (frequent && frequent.count > 0) setTabId('frequent')
        else setTabId(data.tabs[0].id)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(
        /network|fetch|failed/i.test(msg)
          ? '无法加载模型列表：本地服务已断开。请重新运行「测试 by o0」。'
          : msg,
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeTab = useMemo(
    () => catalog?.tabs.find(t => t.id === tabId) || catalog?.tabs[0],
    [catalog, tabId],
  )

  const models: ModelEntry[] = useMemo(() => {
    const list = activeTab?.models || []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      m =>
        m.id.toLowerCase().includes(q) ||
        (m.label || '').toLowerCase().includes(q) ||
        (m.ollamaId || '').toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.priceLabel.toLowerCase().includes(q),
    )
  }, [activeTab, query])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-wide model-picker" onClick={e => e.stopPropagation()}>
        <div className="model-picker-head">
          <div>
            <h2>选择模型</h2>
            <p>
              {catalog?.currencyNote || '价格来自 ChatAnywhere 文档'}
              {catalog?.localOllama
                ? catalog.localOllama.online
                  ? ' · 本地 Ollama 在线'
                  : ' · 本地 Ollama 未检测到（仍可选手动条目）'
                : ''}
              {catalog?.fetchedAt ? ` · ${new Date(catalog.fetchedAt).toLocaleString()}` : ''}
            </p>
          </div>
          <div className="sidebar-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={loading}
              onClick={() => void load(true)}
            >
              刷新
            </button>
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        {(catalog?.apiError || catalog?.pricingError) && (
          <div className="hint warn-line">
            {catalog.apiError ? `API：${catalog.apiError}；` : ''}
            {catalog.pricingError ? `定价文档：${catalog.pricingError}` : ''}
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}

        <input
          className="model-search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索模型名 / 价格 / 说明"
        />

        <div className="model-picker-body">
          <nav className="model-tabs" aria-label="模型系列">
            {(catalog?.tabs || []).map(t => (
              <button
                key={t.id}
                type="button"
                className={`model-tab${t.id === (activeTab?.id || '') ? ' active' : ''}`}
                onClick={() => setTabId(t.id)}
              >
                <span className="model-tab-name">{t.label}</span>
                <span className="model-tab-count">{t.count}</span>
              </button>
            ))}
          </nav>

          <div className="model-list">
            {loading && <div className="empty-inline">加载中…</div>}
            {!loading && models.length === 0 && (
              <div className="empty-inline">
                {activeTab?.id === 'frequent'
                  ? '暂无常用模型：用某模型真正发送过对话后会出现在这里'
                  : '此系列暂无模型'}
              </div>
            )}
            {models.map(m => {
              const localMissing =
                (m.provider === 'ollama' || Boolean(m.ollamaId)) && m.fromApi === false
              return (
              <button
                key={m.id}
                type="button"
                disabled={localMissing}
                title={
                  localMissing
                    ? `未安装。请先执行：ollama pull ${m.ollamaId || m.id}`
                    : undefined
                }
                className={`model-row${selectionMatches(m, currentModel) ? ' selected' : ''}${localMissing ? ' disabled' : ''}`}
                onClick={() => {
                  if (localMissing) return
                  onSelect(m.id)
                }}
              >
                <div className="model-row-main">
                  <div className="model-id">
                    {m.label || m.ollamaId || m.id}
                  </div>
                  <div className="model-price">{m.priceLabel}</div>
                </div>
                <div className="model-row-meta">
                  {m.provider === 'ollama' || m.ollamaId ? (
                    <span>{m.fromApi ? '已安装' : '未 pull · 需 ollama pull'}</span>
                  ) : m.lastUsedLabel ? (
                    <span>上次使用 {m.lastUsedLabel}</span>
                  ) : m.createdLabel ? (
                    <span>发布 {m.createdLabel}</span>
                  ) : (
                    <span>发布日期未知</span>
                  )}
                  {m.ollamaId ? (
                    <span className="model-ollama-id" title={m.ollamaId}>
                      {m.ollamaId}
                    </span>
                  ) : null}
                  {m.description ? <span title={m.description}>{m.description}</span> : null}
                </div>
              </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
