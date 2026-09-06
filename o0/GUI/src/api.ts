/// <summary> AI Cursor </summary>
export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: string
}

export type SessionSummary = {
  id: string
  title: string
  updatedAt: string
  createdAt: string
  messageCount: number
}

export type Session = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

export type SettingsPublic = {
  baseUrl: string
  model: string
  apiKey: string
  apiKeySet: boolean
  apiKeyPreview?: string
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = (data as { error?: string }).error || res.statusText
    throw new Error(err)
  }
  return data as T
}

export async function fetchSettings(): Promise<SettingsPublic> {
  return parseJson(await fetch('/api/settings'))
}

export async function saveSettings(body: {
  apiKey?: string
  baseUrl?: string
  model?: string
  clearApiKey?: boolean
}): Promise<SettingsPublic> {
  return parseJson(
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const data = await parseJson<{ sessions: SessionSummary[] }>(
    await fetch('/api/sessions'),
  )
  return data.sessions
}

export async function createSession(title?: string): Promise<Session> {
  return parseJson(
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  )
}

export async function fetchSession(id: string): Promise<Session> {
  return parseJson(await fetch(`/api/sessions/${id}`))
}

export async function deleteSession(id: string): Promise<void> {
  await parseJson(await fetch(`/api/sessions/${id}`, { method: 'DELETE' }))
}

/// <summary> AI Cursor </summary>
export function startGuiLifetimeHeartbeat(): () => void {
  const ping = () => {
    fetch('/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {})
  }
  ping()
  const id = window.setInterval(ping, 2000)
  const onPageHide = () => {
    try {
      // Delayed shutdown on server; refresh cancels via next heartbeat.
      navigator.sendBeacon('/api/shutdown')
    } catch {
      fetch('/api/shutdown', { method: 'POST', keepalive: true }).catch(() => {})
    }
  }
  window.addEventListener('pagehide', onPageHide)
  return () => {
    window.clearInterval(id)
    window.removeEventListener('pagehide', onPageHide)
  }
}

export type StreamHandlers = {
  onUser: (msg: ChatMessage) => void
  onAssistantStart: (id: string) => void
  onDelta: (id: string, text: string) => void
  onDone: (msg: ChatMessage, sessionMeta: { id: string; title: string; updatedAt: string }) => void
  onError: (message: string) => void
}

/// <summary> AI Cursor </summary>
export async function streamChat(
  sessionId: string,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content }),
    signal,
  })

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error || res.statusText)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n')
    buffer = chunks.pop() || ''

    for (const line of chunks) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
        continue
      }
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw) continue
      let data: Record<string, unknown>
      try {
        data = JSON.parse(raw)
      } catch {
        continue
      }

      if (eventName === 'user') handlers.onUser(data as unknown as ChatMessage)
      else if (eventName === 'assistant_start')
        handlers.onAssistantStart(String(data.id))
      else if (eventName === 'delta')
        handlers.onDelta(String(data.id), String(data.text || ''))
      else if (eventName === 'done')
        handlers.onDone(
          data.message as ChatMessage,
          data.session as { id: string; title: string; updatedAt: string },
        )
      else if (eventName === 'error')
        handlers.onError(String(data.error || 'unknown error'))
    }
  }
}
