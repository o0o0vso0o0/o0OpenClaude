import { afterEach, describe, expect, test } from 'bun:test'
import {
  formatStubToolDescription,
  isToolDescriptionStubEnabled,
  shouldStubToolDescription,
} from './toolDescriptionStub.js'

const ORIGINAL_STUB = process.env.CLAUDE_CODE_TOOL_DESC_STUB
const ORIGINAL_OPENAI = process.env.CLAUDE_CODE_USE_OPENAI
const ORIGINAL_FOUNDRY = process.env.CLAUDE_CODE_USE_FOUNDRY

afterEach(() => {
  if (ORIGINAL_STUB === undefined) delete process.env.CLAUDE_CODE_TOOL_DESC_STUB
  else process.env.CLAUDE_CODE_TOOL_DESC_STUB = ORIGINAL_STUB
  if (ORIGINAL_OPENAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = ORIGINAL_OPENAI
  if (ORIGINAL_FOUNDRY === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY
  else process.env.CLAUDE_CODE_USE_FOUNDRY = ORIGINAL_FOUNDRY
})

describe('toolDescriptionStub', () => {
  test('formats [d] stub from searchHint', () => {
    expect(
      formatStubToolDescription(
        { name: 'Bash', searchHint: 'run shell commands' },
        'A very long prompt\nmore lines',
      ),
    ).toBe('[d] run shell commands')
  })

  test('falls back to clipped first line of full description', () => {
    expect(
      formatStubToolDescription(
        { name: 'Bash' },
        '# Bash tool\nMore details here',
      ),
    ).toBe('[d] Bash tool')
  })

  test('never stubs ToolSearch', () => {
    process.env.CLAUDE_CODE_TOOL_DESC_STUB = '1'
    expect(shouldStubToolDescription({ name: 'ToolSearch' })).toBe(false)
    expect(shouldStubToolDescription({ name: 'Bash' })).toBe(true)
  })

  test('CLAUDE_CODE_TOOL_DESC_STUB=false disables stubs', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_TOOL_DESC_STUB = '0'
    expect(isToolDescriptionStubEnabled()).toBe(false)
    expect(shouldStubToolDescription({ name: 'Bash' })).toBe(false)
  })
})
