/**
 * AI Cursor — spawn OpenClaude CLI headless (stream-json) as agent harness.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  analyzeSessionJsonl,
  buildUsageDetail,
} from './usage-analysis.mjs'
import {
  categorizeToolName,
  emptyToolCounts,
  extractFileChangeFromToolResult,
  formatCommandsSummary,
  formatEditedSummary,
  formatExploredSummary,
  formatThoughtFor,
  formatWorkedFor,
  toolInputFilePath,
} from './agent-activity.mjs'

/// <summary> AI Cursor </summary>
export function resolveOpenClaudeCli(guiRoot) {
  const fromEnv = String(process.env.OPENCLAUDE_CLI || '').trim()
  if (fromEnv && fs.existsSync(fromEnv))
    return {
      node: resolveNode(guiRoot),
      script: path.resolve(fromEnv),
      label: path.resolve(fromEnv),
    }

  const candidates = [
    path.resolve(guiRoot, '..', 'bin', 'openclaude'), // Release\bin
    path.resolve(guiRoot, '..', '..', 'dist', 'cli.mjs'), // repo from o0/GUI
    path.resolve(guiRoot, '..', '..', 'bin', 'openclaude'),
  ]
  for (const script of candidates) {
    if (!fs.existsSync(script)) continue
    return {
      node: resolveNode(guiRoot),
      script,
      label: script,
    }
  }
  return null
}

/// <summary> AI Cursor </summary>
function resolveNode(guiRoot) {
  const releaseNode = path.resolve(guiRoot, '..', 'runtime', 'node', 'node.exe')
  if (fs.existsSync(releaseNode)) return releaseNode
  return process.execPath
}

/// <summary> AI Cursor </summary>
function buildUserMessage(text, images = []) {
  const list = Array.isArray(images) ? images : []
  if (list.length === 0) {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    }
  }
  const blocks = []
  for (const img of list) {
    const media =
      String(img.mediaType || img.media_type || 'image/png').toLowerCase()
    const data = String(img.data || '').replace(/^data:[^;]+;base64,/, '')
    if (!data) continue
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: media,
        data,
      },
    })
  }
  const prompt = String(text || '').trim() || '请查看图片。'
  blocks.push({ type: 'text', text: prompt })
  return {
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
  }
}

/// <summary> AI Cursor </summary>
function buildControlRequest(subtype, extra = {}) {
  return {
    type: 'control_request',
    request_id: randomUUID(),
    request: { subtype, ...extra },
  }
}

/// <summary> AI Cursor </summary>
function buildControlResponse(requestId, result) {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: result || {},
    },
  }
}

/// <summary> AI Cursor </summary>
function toolPreview(input) {
  if (!input || typeof input !== 'object') return String(input ?? '')
  if (input.command) return String(input.command)
  if (input.file_path || input.path) return String(input.file_path || input.path)
  if (input.query) return String(input.query)
  try {
    const s = JSON.stringify(input)
    return s.length > 160 ? `${s.slice(0, 160)}…` : s
  } catch {
    return String(input)
  }
}

/// <summary> AI Cursor </summary>
export function findSessionJsonl(configDir, sessionId) {
  const id = String(sessionId || '').trim()
  const root = String(configDir || '').trim()
  if (!id || !root) return null
  const projects = path.join(root, 'projects')
  if (!fs.existsSync(projects)) return null
  let dirs = []
  try {
    dirs = fs.readdirSync(projects)
  } catch {
    return null
  }
  for (const name of dirs) {
    const candidate = path.join(projects, name, `${id}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/// <summary> AI Cursor </summary>
function isMissingSessionError(err) {
  const msg = err?.message || String(err || '')
  return /No conversation found with session ID/i.test(msg)
}

/// <summary> AI Cursor </summary>
export async function runAgentTurn(opts) {
  try {
    return await runAgentTurnOnce(opts)
  } catch (err) {
    if (!opts?.resumeSessionId || !isMissingSessionError(err)) throw err
    opts.onEvent?.({
      type: 'status',
      text: '上次 Agent 会话已失效，正在开新会话…',
    })
    const result = await runAgentTurnOnce({
      ...opts,
      resumeSessionId: null,
    })
    return { ...result, resumeCleared: true }
  }
}

/// <summary> AI Cursor </summary>
function runAgentTurnOnce(opts) {
  const {
    guiRoot,
    prompt,
    images = [],
    cwd,
    model,
    apiKey,
    baseUrl,
    resumeSessionId = null,
    configDir = null,
    maxTurns = 50,
    planMode = false,
    ollamaThink = false,
    onEvent = () => {},
    signal = null,
  } = opts

  const cli = resolveOpenClaudeCli(guiRoot)
  if (!cli)
    return Promise.reject(
      new Error(
        '未找到 OpenClaude CLI（dist/cli.mjs 或 Release/bin/openclaude）。请先编译 CLI，或设置 OPENCLAUDE_CLI。',
      ),
    )

  const workCwd = String(cwd || process.cwd()).trim() || process.cwd()
  if (!fs.existsSync(workCwd))
    return Promise.reject(new Error(`工作目录不存在: ${workCwd}`))

  const permissionMode = planMode ? 'plan' : 'bypassPermissions'
  const args = [
    cli.script,
    '--print',
    '--verbose',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--permission-mode',
    permissionMode,
    '--model',
    String(model || '').trim() || 'gpt-4o-mini',
    '--max-turns',
    String(maxTurns || 50),
  ]
  if (!planMode) args.push('--dangerously-skip-permissions')

  // Prefer absolute .jsonl path so resume works across cwd/project-dir mismatches.
  const resumeId = resumeSessionId ? String(resumeSessionId).trim() : ''
  const resumePath = resumeId ? findSessionJsonl(configDir, resumeId) : null
  if (resumePath) args.push('--resume', resumePath)
  else if (resumeId) args.push('--resume', resumeId)

  const env = {
    ...process.env,
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_API_KEY: String(apiKey || ''),
    OPENAI_BASE_URL: String(baseUrl || '').replace(/\/+$/, ''),
    OPENAI_MODEL: String(model || ''),
  }
  env.OPENCLAUDE_OLLAMA_THINK = ollamaThink ? '1' : '0'
  if (configDir) {
    env.OPENCLAUDE_CONFIG_DIR = configDir
    env.CLAUDE_CONFIG_DIR = configDir
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    let stderrBuf = ''
    let agentSessionId = resumeId || null
    let assistantText = ''
    /** @type {Set<string>} */
    const seenTools = new Set()
    /** @type {object | null} */
    let resultMsg = null
    /** @type {object | null} */
    let contextUsage = null
    /** @type {{ id: string, resolve: (v: any) => void, reject: (e: any) => void } | null} */
    let pendingContextReq = null
    let contextRequested = false
    let lastThinkingStatusAt = 0
    let inThinkingBlock = false
    const turnStartedAt = Date.now()
    let thinkingStartedAt = 0
    let thinkingMs = 0
    const toolCounts = emptyToolCounts()
    /** @type {Map<string, { filePath: string, added: number, removed: number }>} */
    const filesChangedMap = new Map()
    /** @type {Map<string, { name: string, input: object }>} */
    const pendingTools = new Map()

    /// <summary> AI Cursor </summary>
    function filesChangedList() {
      return [...filesChangedMap.values()].map(f => ({
        filePath: f.filePath,
        added: f.added,
        removed: f.removed,
      }))
    }

    /// <summary> AI Cursor </summary>
    function emitActivitySummaries({ active = true } = {}) {
      const explored = formatExploredSummary(toolCounts, { active })
      if (explored)
        onEvent({ type: 'activity', kind: 'explored', text: explored, active })
      const edited = formatEditedSummary(toolCounts, { active })
      if (edited)
        onEvent({ type: 'activity', kind: 'edited', text: edited, active })
      const cmds = formatCommandsSummary(toolCounts, { active })
      if (cmds)
        onEvent({ type: 'activity', kind: 'commands', text: cmds, active })
      const files = filesChangedList()
      if (files.length)
        onEvent({ type: 'files_changed', files })
    }

    /// <summary> AI Cursor </summary>
    function noteThinkingStart() {
      if (!thinkingStartedAt) thinkingStartedAt = Date.now()
      inThinkingBlock = true
    }

    /// <summary> AI Cursor </summary>
    function noteThinkingDone() {
      if (!inThinkingBlock && !thinkingStartedAt) return
      if (thinkingStartedAt) {
        thinkingMs += Math.max(0, Date.now() - thinkingStartedAt)
        thinkingStartedAt = 0
      }
      inThinkingBlock = false
      onEvent({ type: 'thinking_done' })
      if (thinkingMs > 0)
        onEvent({
          type: 'activity',
          kind: 'thought',
          text: formatThoughtFor(thinkingMs),
          active: false,
        })
    }

    /// <summary> AI Cursor </summary>
    function registerToolUse(id, name, input) {
      const toolId = id || `${name}-${seenTools.size}`
      if (seenTools.has(toolId)) return
      seenTools.add(toolId)
      const inp = input && typeof input === 'object' ? input : {}
      pendingTools.set(toolId, { name: name || 'Tool', input: inp })
      const cat = categorizeToolName(name)
      if (cat in toolCounts) toolCounts[cat] += 1
      const fileHint = toolInputFilePath(inp)
      if (cat === 'writes' && fileHint && !filesChangedMap.has(fileHint))
        filesChangedMap.set(fileHint, {
          filePath: fileHint,
          added: 0,
          removed: 0,
        })
      onEvent({
        type: 'tool',
        id: toolId,
        name: name || 'Tool',
        preview: toolPreview(inp),
      })
      emitActivitySummaries({ active: true })
    }

    /// <summary> AI Cursor </summary>
    function ingestToolResultPayload(payload, toolUseId) {
      const change = extractFileChangeFromToolResult(payload)
      if (change) {
        const prev = filesChangedMap.get(change.filePath)
        filesChangedMap.set(change.filePath, {
          filePath: change.filePath,
          added: (prev?.added || 0) + (change.added || 0),
          removed: (prev?.removed || 0) + (change.removed || 0),
        })
        onEvent({ type: 'files_changed', files: filesChangedList() })
        return
      }
      if (!toolUseId || !pendingTools.has(toolUseId)) return
      const pending = pendingTools.get(toolUseId)
      if (categorizeToolName(pending.name) !== 'writes') return
      const fp = toolInputFilePath(pending.input)
      if (fp && !filesChangedMap.has(fp))
        filesChangedMap.set(fp, { filePath: fp, added: 0, removed: 0 })
      if (fp) onEvent({ type: 'files_changed', files: filesChangedList() })
    }

    /// <summary> AI Cursor </summary>
    function handleUserToolResults(msg) {
      const top =
        msg.tool_use_result ||
        msg.toolUseResult ||
        msg.toolUseResult?.data ||
        null
      if (top && typeof top === 'object')
        ingestToolResultPayload(top, msg.tool_use_id || msg.toolUseID)
      const content = msg.message?.content
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (block?.type !== 'tool_result') continue
        const toolUseId = block.tool_use_id || block.toolUseID
        let payload = block.toolUseResult || block.tool_use_result
        if (!payload && typeof block.content === 'string') {
          try {
            const parsed = JSON.parse(block.content)
            if (parsed && typeof parsed === 'object') payload = parsed
          } catch {
            /* ignore */
          }
        } else if (!payload && Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part?.type === 'text' && typeof part.text === 'string') {
              try {
                const parsed = JSON.parse(part.text)
                if (parsed && typeof parsed === 'object') {
                  payload = parsed
                  break
                }
              } catch {
                /* ignore */
              }
            }
          }
        } else if (!payload && block.content && typeof block.content === 'object')
          payload = block.content
        if (payload) ingestToolResultPayload(payload, toolUseId)
      }
    }

    const localHint =
      /11434|ollama/i.test(String(baseUrl || '')) ||
      /^qwen3\.8:/i.test(String(model || ''))
    onEvent({
      type: 'status',
      text: resumeId ? '正在恢复会话…' : '正在启动…',
    })

    const child = spawn(cli.node, args, {
      cwd: workCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    onEvent({
      type: 'status',
      text: localHint ? '正在加载本地模型…' : '正在连接模型…',
    })

    const finish = (err, value) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener?.('abort', onAbort)
      if (pendingContextReq) {
        try {
          pendingContextReq.reject(new Error('agent finished'))
        } catch {
          /* ignore */
        }
        pendingContextReq = null
      }
      try {
        if (child.stdin?.writable) child.stdin.end()
      } catch {
        /* ignore */
      }
      if (err) reject(err)
      else resolve(value)
    }

    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      finish(new Error('已取消'))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener?.('abort', onAbort)
    }

    const writeMsg = msg => {
      if (!child.stdin?.writable) return
      child.stdin.write(`${JSON.stringify(msg)}\n`)
    }

    /// <summary> AI Cursor </summary>
    function requestContextUsage(timeoutMs = 25000) {
      if (contextRequested) return Promise.resolve(contextUsage)
      contextRequested = true
      const req = buildControlRequest('get_context_usage')
      return new Promise(resolveCtx => {
        const timer = setTimeout(() => {
          if (pendingContextReq?.id === req.request_id) {
            pendingContextReq = null
            resolveCtx(null)
          }
        }, timeoutMs)
        pendingContextReq = {
          id: req.request_id,
          resolve: data => {
            clearTimeout(timer)
            pendingContextReq = null
            contextUsage = data
            resolveCtx(data)
          },
          reject: () => {
            clearTimeout(timer)
            pendingContextReq = null
            resolveCtx(null)
          },
        }
        writeMsg(req)
      })
    }

    /// <summary> AI Cursor </summary>
    async function finalizeTurn(exitCode) {
      if (settled) return
      if (!contextRequested && resultMsg && !resultMsg.is_error) {
        try {
          await requestContextUsage()
        } catch {
          /* ignore */
        }
      }
      try {
        if (child.stdin?.writable) child.stdin.end()
      } catch {
        /* ignore */
      }

      const usage = resultMsg?.usage || null
      const ok =
        resultMsg &&
        (resultMsg.subtype === 'success' ||
          resultMsg.is_error === false ||
          typeof resultMsg.result === 'string')

      if (!resultMsg && exitCode !== 0) {
        finish(
          new Error(
            `Agent 退出码 ${exitCode}${stderrBuf ? `: ${stderrBuf.slice(-800)}` : ''}`,
          ),
        )
        return
      }

      if (resultMsg?.is_error || resultMsg?.subtype === 'error') {
        finish(
          new Error(
            resultMsg.errors?.join?.('\n') ||
              resultMsg.result ||
              resultMsg.subtype ||
              'Agent 执行失败',
          ),
        )
        return
      }

      const sid = agentSessionId || resumeId || null
      const jsonlPath = sid ? findSessionJsonl(configDir, sid) : null
      const composition = analyzeSessionJsonl(jsonlPath)
      const usageDetail = usage
        ? buildUsageDetail({
            usage,
            numTurns: resultMsg?.num_turns,
            modelUsage: resultMsg?.modelUsage,
            composition,
            contextUsage,
            model: String(model || '').trim() || null,
          })
        : null

      finish(null, {
        text: assistantText || (ok ? String(resultMsg?.result || '') : ''),
        agentSessionId,
        usage: usage
          ? {
              promptTokens: Number(usage.input_tokens) || 0,
              completionTokens: Number(usage.output_tokens) || 0,
              totalTokens:
                (Number(usage.input_tokens) || 0) +
                (Number(usage.output_tokens) || 0),
              cacheReadInputTokens:
                Number(usage.cache_read_input_tokens) || 0,
              cacheCreationInputTokens:
                Number(usage.cache_creation_input_tokens) || 0,
              numTurns: Number(resultMsg?.num_turns) || null,
            }
          : null,
        usageDetail,
        totalCostUsd:
          typeof resultMsg?.total_cost_usd === 'number'
            ? resultMsg.total_cost_usd
            : null,
        ...(() => {
          if (thinkingStartedAt) {
            thinkingMs += Math.max(0, Date.now() - thinkingStartedAt)
            thinkingStartedAt = 0
          }
          const workedMs = Math.max(0, Date.now() - turnStartedAt)
          const items = []
          if (thinkingMs > 0)
            items.push({
              kind: 'thought',
              text: formatThoughtFor(thinkingMs),
              active: false,
            })
          const explored = formatExploredSummary(toolCounts, { active: false })
          if (explored)
            items.push({ kind: 'explored', text: explored, active: false })
          const edited = formatEditedSummary(toolCounts, { active: false })
          if (edited)
            items.push({ kind: 'edited', text: edited, active: false })
          const cmds = formatCommandsSummary(toolCounts, { active: false })
          if (cmds)
            items.push({ kind: 'commands', text: cmds, active: false })
          const workedText = formatWorkedFor(workedMs)
          items.push({
            kind: 'worked',
            text: workedText,
            active: false,
            ms: workedMs,
          })
          onEvent({
            type: 'activity',
            kind: 'worked',
            text: workedText,
            active: false,
            ms: workedMs,
          })
          emitActivitySummaries({ active: false })
          return {
            activity: items,
            filesChanged: filesChangedList(),
            workedMs,
            thinkingMs,
          }
        })(),
        cli: cli.label,
        exitCode,
        ok: Boolean(ok || assistantText),
      })
    }

    const handleMsg = msg => {
      if (!msg || typeof msg !== 'object') return
      if (msg.session_id) agentSessionId = msg.session_id

      if (msg.type === 'control_response') {
        const resp = msg.response || {}
        if (pendingContextReq && resp.request_id === pendingContextReq.id) {
          if (resp.subtype === 'success')
            pendingContextReq.resolve(resp.response || null)
          else pendingContextReq.resolve(null)
        }
        return
      }

      if (msg.type === 'control_request') {
        const req = msg.request || msg
        const requestId = req.request_id || msg.request_id
        // Host→CLI context requests are sent by us; CLI→host permission asks
        // still get auto-allow.
        if (req.subtype === 'get_context_usage') return
        const toolUseId = req.tool_use_id || req.toolUseID || null
        const input =
          req.input && typeof req.input === 'object' ? req.input : {}
        writeMsg(
          buildControlResponse(requestId, {
            behavior: 'allow',
            updatedInput: input,
            toolUseID: toolUseId || undefined,
          }),
        )
        return
      }

      if (msg.type === 'stream_event' && msg.event) {
        const ev = msg.event
        if (
          ev.type === 'content_block_delta' &&
          (ev.delta?.type === 'thinking_delta' ||
            ev.delta?.type === 'reasoning_delta')
        ) {
          const chunk =
            ev.delta.thinking ||
            ev.delta.reasoning ||
            ev.delta.text ||
            ''
          if (chunk) {
            noteThinkingStart()
            onEvent({ type: 'thinking', text: String(chunk) })
          }
          const now = Date.now()
          if (now - lastThinkingStatusAt > 1500) {
            lastThinkingStatusAt = now
            onEvent({ type: 'status', text: '正在思考…' })
            onEvent({
              type: 'activity',
              kind: 'thought',
              text: 'Thinking…',
              active: true,
            })
          }
        }
        if (
          ev.type === 'content_block_start' &&
          (ev.content_block?.type === 'thinking' ||
            ev.content_block?.type === 'reasoning')
        ) {
          noteThinkingStart()
          onEvent({ type: 'status', text: '正在思考…' })
          onEvent({
            type: 'activity',
            kind: 'thought',
            text: 'Thinking…',
            active: true,
          })
        }
        if (ev.type === 'content_block_stop' && inThinkingBlock)
          noteThinkingDone()
        if (
          ev.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          ev.delta.text
        ) {
          if (inThinkingBlock) noteThinkingDone()
          assistantText += ev.delta.text
          onEvent({ type: 'delta', text: ev.delta.text })
        }
        if (
          ev.type === 'content_block_start' &&
          ev.content_block?.type === 'tool_use'
        ) {
          if (inThinkingBlock) noteThinkingDone()
          const tu = ev.content_block
          registerToolUse(tu.id, tu.name || 'Tool', tu.input)
        }
        if (ev.type === 'message_start')
          onEvent({ type: 'status', text: '正在写回复…' })
        return
      }

      if (msg.type === 'user') {
        handleUserToolResults(msg)
        return
      }

      if (msg.type === 'assistant') {
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use')
              registerToolUse(block.id, block.name || 'Tool', block.input)
          }
          if (!assistantText) {
            const text = content
              .filter(b => b?.type === 'text')
              .map(b => b.text || '')
              .join('')
            if (text) {
              assistantText = text
              onEvent({ type: 'delta', text })
            }
          }
        }
        return
      }

      if (msg.type === 'tool_progress' || msg.type === 'tool_use_summary') {
        onEvent({
          type: 'status',
          text: msg.summary || msg.message || msg.type,
        })
        return
      }

      if (msg.type === 'result') {
        resultMsg = msg
        if (
          (!assistantText || !assistantText.trim()) &&
          typeof msg.result === 'string' &&
          msg.result
        ) {
          assistantText = msg.result
          onEvent({ type: 'delta', text: msg.result })
        }
        onEvent({ type: 'status', text: '正在整理用量…' })
        void requestContextUsage().finally(() => {
          try {
            if (child.stdin?.writable) child.stdin.end()
          } catch {
            /* ignore */
          }
        })
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          handleMsg(JSON.parse(trimmed))
        } catch {
          /* ignore partial/non-json */
        }
      }
    })

    child.stderr.on('data', chunk => {
      const t = String(chunk || '')
      stderrBuf += t
      const trimmed = t.trim()
      if (!trimmed) return
      if (/^\(node:\d+\)|^DeprecationWarning|^ExperimentalWarning/i.test(trimmed))
        return
      onEvent({ type: 'stderr', text: trimmed.slice(0, 500) })
    })

    child.on('error', err => finish(err))

    child.on('close', code => {
      if (settled) return
      if (buffer.trim()) {
        try {
          handleMsg(JSON.parse(buffer.trim()))
        } catch {
          /* ignore */
        }
      }
      void finalizeTurn(code)
    })

    // Defer stdin write slightly so --resume init can bind before large image payloads.
    setImmediate(() => {
      if (settled || signal?.aborted) return
      writeMsg(buildUserMessage(prompt, images))
    })
  })
}
