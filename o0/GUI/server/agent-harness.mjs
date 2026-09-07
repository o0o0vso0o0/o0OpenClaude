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

    const localHint =
      /11434|ollama/i.test(String(baseUrl || '')) ||
      /^qwen3\.8:/i.test(String(model || ''))
    onEvent({
      type: 'status',
      text: resumeId
        ? '正在恢复会话并启动 Agent…'
        : '正在启动 Agent…',
    })

    const child = spawn(cli.node, args, {
      cwd: workCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    onEvent({
      type: 'status',
      text: localHint
        ? '已启动，等待本地模型首 token（冷启动可能较久）…'
        : '已启动，等待模型首包…',
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
            inThinkingBlock = true
            onEvent({ type: 'thinking', text: String(chunk) })
          }
          const now = Date.now()
          if (now - lastThinkingStatusAt > 1500) {
            lastThinkingStatusAt = now
            onEvent({ type: 'status', text: '模型思考中…' })
          }
        }
        if (
          ev.type === 'content_block_start' &&
          (ev.content_block?.type === 'thinking' ||
            ev.content_block?.type === 'reasoning')
        ) {
          inThinkingBlock = true
          onEvent({ type: 'status', text: '模型开始思考…' })
        }
        if (ev.type === 'content_block_stop' && inThinkingBlock) {
          inThinkingBlock = false
          onEvent({ type: 'thinking_done' })
        }
        if (
          ev.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          ev.delta.text
        ) {
          if (inThinkingBlock) {
            inThinkingBlock = false
            onEvent({ type: 'thinking_done' })
          }
          assistantText += ev.delta.text
          onEvent({ type: 'delta', text: ev.delta.text })
        }
        if (
          ev.type === 'content_block_start' &&
          ev.content_block?.type === 'tool_use'
        ) {
          if (inThinkingBlock) {
            inThinkingBlock = false
            onEvent({ type: 'thinking_done' })
          }
          const tu = ev.content_block
          const id = tu.id || `${tu.name}-${seenTools.size}`
          if (!seenTools.has(id)) {
            seenTools.add(id)
            onEvent({
              type: 'tool',
              id,
              name: tu.name || 'Tool',
              preview: toolPreview(tu.input),
            })
          }
        }
        if (ev.type === 'message_start')
          onEvent({ type: 'status', text: '已收到模型响应，正在生成…' })
        return
      }

      if (msg.type === 'assistant') {
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use') {
              const id = block.id || `${block.name}-${seenTools.size}`
              if (!seenTools.has(id)) {
                seenTools.add(id)
                onEvent({
                  type: 'tool',
                  id,
                  name: block.name || 'Tool',
                  preview: toolPreview(block.input),
                })
              }
            }
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
        onEvent({ type: 'status', text: '正在分析上下文构成…' })
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
