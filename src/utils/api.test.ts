import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type Tools } from '../Tool.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import { toolToAPISchema } from './api.js'

test('toolToAPISchema preserves provider-specific schema keywords in input_schema', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'WebFetch',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'Public HTTP or HTTPS URL',
          },
          metadata: {
            type: 'object',
            propertyNames: {
              pattern: '^[a-z]+$',
            },
            properties: {
              callback: {
                type: 'string',
                format: 'uri-reference',
              },
            },
          },
        },
      },
      prompt: async () => 'Fetch a URL',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  expect(schema).toMatchObject({
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Public HTTP or HTTPS URL',
        },
        metadata: {
          type: 'object',
          propertyNames: {
            pattern: '^[a-z]+$',
          },
          properties: {
            callback: {
              type: 'string',
              format: 'uri-reference',
            },
          },
        },
      },
    },
  })
})

test('toolToAPISchema keeps skill required for SkillTool', async () => {
  const schema = await toolToAPISchema(SkillTool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [] as unknown as Tools,
    agents: [],
  })

  expect((schema as { input_schema: unknown }).input_schema).toMatchObject({
    type: 'object',
    required: ['skill'],
  })
})

test('toolToAPISchema stubs long descriptions on OpenAI path but keeps parameters', async () => {
  const prevStub = process.env.CLAUDE_CODE_TOOL_DESC_STUB
  const prevOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_TOOL_DESC_STUB = '1'
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  try {
    const schema = await toolToAPISchema(
      {
        name: 'Bash',
        searchHint: 'run shell commands',
        inputSchema: z.strictObject({
          command: z.string(),
        }),
        prompt: async () =>
          'A very long bash tool prompt with lots of git and safety rules that should not appear on the wire when stubbing is enabled.',
      } as unknown as Tool,
      {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        tools: [] as unknown as Tools,
        agents: [],
      },
    )

    expect(schema).toMatchObject({
      name: 'Bash',
      description: '[d] run shell commands',
    })
    expect(
      (schema as { description: string }).description.includes('git and safety'),
    ).toBe(false)
    expect((schema as { input_schema: { properties?: unknown } }).input_schema)
      .toBeDefined()
  } finally {
    if (prevStub === undefined) delete process.env.CLAUDE_CODE_TOOL_DESC_STUB
    else process.env.CLAUDE_CODE_TOOL_DESC_STUB = prevStub
    if (prevOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = prevOpenAI
  }
})

test('toolToAPISchema removes extra required keys not in properties (MCP schema sanitization)', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'mcp__test__create_object',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name', 'attributes'],
      },
      prompt: async () => 'Create an object',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  const inputSchema = (schema as { input_schema: { required?: string[] } }).input_schema
  expect(inputSchema.required).toEqual(['name'])
})
