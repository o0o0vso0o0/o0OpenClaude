import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import {
  getAPIProvider,
  type LegacyAPIProvider,
} from './model/providers.js'

// Keep in sync with ANTHROPIC_WIRE_PROVIDERS in toolSearch.ts — leaf module
// avoids importing toolSearch (which pulls analyzeContext → api → this file).
const ANTHROPIC_WIRE_PROVIDERS: ReadonlySet<LegacyAPIProvider> = new Set([
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'minimax',
])

/**
 * AI Cursor
 * OpenCode-style progressive disclosure for OpenAI-compatible wires:
 * keep full parameter schemas on the wire, but replace long tool.prompt()
 * text with a short `[d]` stub. Full guidance is fetched via ToolSearch.
 *
 * Override with CLAUDE_CODE_TOOL_DESC_STUB=true/false.
 */
export function isToolDescriptionStubEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_TOOL_DESC_STUB)) return false
  if (isEnvTruthy(process.env.CLAUDE_CODE_TOOL_DESC_STUB)) return true
  return !ANTHROPIC_WIRE_PROVIDERS.has(getAPIProvider())
}

/**
 * AI Cursor
 * ToolSearch keeps a full description; everything else may be stubbed.
 */
export function shouldStubToolDescription(tool: {
  name: string
}): boolean {
  if (!isToolDescriptionStubEnabled()) return false
  return tool.name !== TOOL_SEARCH_TOOL_NAME
}

/**
 * AI Cursor
 * Build a short stub. Prefer curated searchHint, else a clipped first line.
 */
export function formatStubToolDescription(
  tool: { name: string; searchHint?: string },
  fullDescription?: string,
): string {
  const hint =
    tool.searchHint?.trim() ||
    extractShortHint(fullDescription) ||
    tool.name
  return `[d] ${hint}`
}

/**
 * AI Cursor
 */
function extractShortHint(fullDescription: string | undefined): string | null {
  if (!fullDescription) return null
  const firstLine =
    fullDescription
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0) ?? ''
  if (!firstLine) return null
  // Drop markdown headings / bullets for a cleaner stub
  const cleaned = firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '')
  if (cleaned.length <= 96) return cleaned
  return `${cleaned.slice(0, 95)}…`
}
