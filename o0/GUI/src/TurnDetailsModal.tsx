/// <summary> AI Cursor </summary>
import type { ChatMessage, ToolCallItem, WebPageItem } from './api'

type Props = {
  message: ChatMessage
  onClose: () => void
}

/// <summary> AI Cursor </summary>
function formatToolInput(tool: ToolCallItem): string {
  try {
    return JSON.stringify(tool.input ?? {}, null, 2)
  } catch {
    return String(tool.preview || '')
  }
}

/// <summary> AI Cursor </summary>
export default function TurnDetailsModal({ message, onClose }: Props) {
  const tools = message.tools || []
  const pages = message.webPages || []
  const filesChanged = message.filesChanged || []
  const filesRead = message.filesRead || []
  const record =
    message.promptRecord ||
    [
      '=== 本轮用户消息 ===',
      message.userPrompt || '(未记录)',
      '',
      '=== 工具调用 ===',
      tools.length
        ? tools.map((t, i) => `${i + 1}. ${t.name}\n${formatToolInput(t)}`).join('\n\n')
        : '(无)',
    ].join('\n')

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal modal-wide turn-details-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="本轮详情"
      >
        <div className="modal-header">
          <h2>本轮详情 / 完整记录</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body turn-details-body">
          <section>
            <h3>完整记录</h3>
            <pre className="turn-details-pre">{record}</pre>
          </section>

          <section>
            <h3>工具调用（{tools.length}）</h3>
            {tools.length === 0 ? (
              <p className="muted">本轮没有工具调用</p>
            ) : (
              <ul className="turn-tool-list">
                {tools.map(t => (
                  <li key={t.toolId || t.name}>
                    <div className="turn-tool-name">{t.name}</div>
                    {t.preview ? (
                      <div className="turn-tool-preview">{t.preview}</div>
                    ) : null}
                    <pre className="turn-details-pre">{formatToolInput(t)}</pre>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>网页（{pages.length}）</h3>
            {pages.length === 0 ? (
              <p className="muted">无搜索/抓取网页</p>
            ) : (
              <ul className="turn-page-list">
                {pages.map((p: WebPageItem) => (
                  <li key={p.url}>
                    <a href={p.url} target="_blank" rel="noreferrer">
                      {p.title || p.url}
                    </a>
                    <div className="turn-page-url">{p.url}</div>
                    {p.source ? (
                      <div className="turn-page-source">{p.source}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>文件</h3>
            {!filesRead.length && !filesChanged.length ? (
              <p className="muted">无读写文件</p>
            ) : (
              <ul className="turn-file-list">
                {filesRead.map(f => (
                  <li key={`r-${f}`}>
                    <span className="tag">读</span> {f}
                  </li>
                ))}
                {filesChanged.map(f => (
                  <li key={`w-${f.filePath}`}>
                    <span className="tag">写</span> {f.filePath}{' '}
                    <span className="msg-files-stat">
                      <span className="add">+{f.added || 0}</span>
                      <span className="del">-{f.removed || 0}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
