/// <summary> AI Cursor </summary>
import { Fragment } from 'react'
import type { UsageCategoryRow, UsageDetail } from './api'

type Props = {
  costLabel: string
  detail: UsageDetail | null
  loading?: boolean
  error?: string | null
  onClose: () => void
}

/// <summary> AI Cursor </summary>
function fmt(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('zh-CN')
}

/// <summary> AI Cursor </summary>
function UsageRows({
  rows,
  depth = 0,
}: {
  rows: UsageCategoryRow[]
  depth?: number
}) {
  return (
    <>
      {rows.map(row => (
        <Fragment key={row.id}>
          <tr className={depth > 0 ? 'usage-row-nested' : undefined}>
            <td style={{ paddingLeft: `${0.4 + depth * 1.1}rem` }}>
              {depth > 0 ? '↳ ' : ''}
              {row.label}
            </td>
            <td>{fmt(row.mappedTokens ?? row.tokens)}</td>
            <td>{row.share}%</td>
            <td>{row.count ?? '—'}</td>
          </tr>
          {row.children && row.children.length > 0 && (
            <UsageRows rows={row.children} depth={depth + 1} />
          )}
        </Fragment>
      ))}
    </>
  )
}

/// <summary> AI Cursor </summary>
export default function UsageDetailModal({
  costLabel,
  detail,
  loading,
  error,
  onClose,
}: Props) {
  const billed = detail?.billed
  const mapped = detail?.mappedToBilledInput || []
  const composition = detail?.composition
  const context = detail?.contextBreakdown

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal modal-wide usage-detail-modal"
        onClick={e => e.stopPropagation()}
      >
        <h2>费用明细</h2>
        <p className="usage-detail-summary">{costLabel}</p>

        {loading && <p className="muted">正在分析…</p>}
        {error && <div className="error-banner">{error}</div>}

        {!loading && detail && (
          <>
            <section className="usage-section">
              <h3>账单（本轮 API 累计）</h3>
              <div className="usage-grid">
                <div>
                  <span className="k">入</span>
                  <span className="v">{fmt(billed?.inputTokens)}</span>
                </div>
                <div>
                  <span className="k">出</span>
                  <span className="v">{fmt(billed?.outputTokens)}</span>
                </div>
                <div>
                  <span className="k">缓存读</span>
                  <span className="v">{fmt(billed?.cacheReadInputTokens)}</span>
                </div>
                <div>
                  <span className="k">缓存写</span>
                  <span className="v">
                    {fmt(billed?.cacheCreationInputTokens)}
                  </span>
                </div>
                <div>
                  <span className="k">模型请求轮次</span>
                  <span className="v">{fmt(billed?.numTurns)}</span>
                </div>
                <div>
                  <span className="k">平均每轮入</span>
                  <span className="v">{fmt(billed?.avgInputPerTurn)}</span>
                </div>
              </div>
              {detail.model && (
                <p className="muted">模型：{detail.model}</p>
              )}
            </section>

            {mapped.length > 0 && (
              <section className="usage-section">
                <h3>「入」按内容类型分摊（估算）</h3>
                <p className="muted">
                  「系统/工具定义等」若已取到 OpenClaude 上下文分析，会展开为 System
                  prompt / 工具 schema / Memory 等子项。
                </p>
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>映射入</th>
                      <th>占比</th>
                      <th>块数</th>
                    </tr>
                  </thead>
                  <tbody>
                    <UsageRows rows={mapped} />
                  </tbody>
                </table>
              </section>
            )}

            {context && context.categories.length > 0 && (
              <section className="usage-section">
                <h3>请求构成（OpenClaude /context）</h3>
                <p className="muted">
                  单次请求窗口快照（不含 Messages / 空闲缓冲），合计约{' '}
                  {fmt(context.categories.reduce((s, c) => s + c.tokens, 0))}{' '}
                  tokens。
                </p>
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>类别</th>
                      <th>tokens</th>
                      <th>占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {context.categories.map(c => (
                      <tr key={c.id}>
                        <td>{c.label}</td>
                        <td>{fmt(c.tokens)}</td>
                        <td>{c.share}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {context.systemPromptSections.length > 0 && (
                  <>
                    <h4 className="usage-subhead">System prompt 各段</h4>
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th>段落</th>
                          <th>tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {context.systemPromptSections.map(s => (
                          <tr key={s.id}>
                            <td>{s.label}</td>
                            <td>{fmt(s.tokens)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {context.systemTools.length > 0 && (
                  <>
                    <h4 className="usage-subhead">内置工具 schema（Top）</h4>
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th>工具</th>
                          <th>tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {context.systemTools.map(s => (
                          <tr key={s.id}>
                            <td>{s.label}</td>
                            <td>{fmt(s.tokens)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {context.memoryFiles.length > 0 && (
                  <>
                    <h4 className="usage-subhead">Memory / CLAUDE.md</h4>
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th>文件</th>
                          <th>tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {context.memoryFiles.map(s => (
                          <tr key={s.id}>
                            <td className="usage-path">{s.label}</td>
                            <td>{fmt(s.tokens)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </section>
            )}

            {composition && composition.categories.length > 0 && (
              <section className="usage-section">
                <h3>会话构成粗估（transcript）</h3>
                <p className="muted">
                  估算合计约 {fmt(composition.estimatedTotal)} tokens（
                  {composition.messages} 条消息）。
                </p>
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>估算 tokens</th>
                      <th>占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {composition.categories.map(row => (
                      <tr key={row.id}>
                        <td>{row.label}</td>
                        <td>{fmt(row.tokens)}</td>
                        <td>{row.share}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {detail.models && detail.models.length > 0 && (
              <section className="usage-section">
                <h3>按模型</h3>
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>入</th>
                      <th>出</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.models.map(m => (
                      <tr key={m.model}>
                        <td>{m.model}</td>
                        <td>{fmt(m.inputTokens)}</td>
                        <td>{fmt(m.outputTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {detail.notes?.length > 0 && (
              <ul className="usage-notes">
                {detail.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
