/// <summary> AI Cursor </summary>
import { useCallback, useEffect, useState } from 'react'
import { fetchOllamaLoaded, unloadOllamaModel, type OllamaLoadedModel } from './api'

type Props = {
  onClose: () => void
}

/// <summary> AI Cursor </summary>
export default function OllamaVramPanel({ onClose }: Props) {
  const [models, setModels] = useState<OllamaLoadedModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyName, setBusyName] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchOllamaLoaded()
      setModels(data.models || [])
      if (!data.ok && data.error) setError(data.error)
    } catch (e) {
      setModels([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function onUnload(name: string) {
    setBusyName(name)
    setError(null)
    try {
      await unloadOllamaModel(name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyName(null)
    }
  }

  async function onUnloadAll() {
    setBusyName('__all__')
    setError(null)
    try {
      for (const m of models) await unloadOllamaModel(m.name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await refresh()
    } finally {
      setBusyName(null)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-wide ollama-vram-panel" onClick={e => e.stopPropagation()}>
        <div className="model-picker-head">
          <div>
            <h2>显存中的本地模型</h2>
            <p>来自 Ollama <code>/api/ps</code>。卸载后下次对话会重新加载。</p>
          </div>
          <div className="sidebar-actions">
            <button type="button" className="btn btn-ghost" disabled={loading || Boolean(busyName)} onClick={() => void refresh()}>
              刷新
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={loading || models.length === 0 || Boolean(busyName)}
              onClick={() => void onUnloadAll()}
            >
              全部卸载
            </button>
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="ollama-vram-list">
          {loading && <div className="empty-inline">查询中…</div>}
          {!loading && models.length === 0 && (
            <div className="empty-inline">当前没有已加载到显存/内存的模型。</div>
          )}
          {!loading &&
            models.map(m => (
              <div key={m.name} className="ollama-vram-row">
                <div className="ollama-vram-main">
                  <div className="model-id">{m.name}</div>
                  <div className="model-row-meta">
                    {m.sizeLabel ? <span>约占用 {m.sizeLabel}</span> : null}
                    {m.details?.quantization_level ? (
                      <span>{m.details.quantization_level}</span>
                    ) : null}
                    {m.details?.parameter_size ? <span>{m.details.parameter_size}</span> : null}
                    {m.expiresAt ? (
                      <span title={m.expiresAt}>
                        到期 {new Date(m.expiresAt).toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={Boolean(busyName)}
                  onClick={() => void onUnload(m.name)}
                >
                  {busyName === m.name ? '卸载中…' : '卸载'}
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
