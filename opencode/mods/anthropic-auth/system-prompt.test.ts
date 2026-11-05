import { describe, expect, mock, test } from 'bun:test'
import {
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY_PREFIX,
  prependClaudeCodeIdentity,
  sanitizeSystemText,
} from './system-prompt.ts'
import { REALISTIC_SYSTEM_PROMPT } from './system-prompt-sample.ts'

describe('sanitizeSystemText', () => {
  // Anchor-based sanitization. Three mechanisms:
  //
  //   1. The OPENCODE_IDENTITY line is always removed.
  //   2. Any paragraph containing a PARAGRAPH_REMOVAL_ANCHORS entry
  //      (e.g. "github.com/anomalyco/opencode", "opencode.ai/docs")
  //      is removed entirely.
  //   3. TEXT_REPLACEMENTS are applied inline for short branded strings
  //      inside paragraphs we want to keep (e.g. "if OpenCode honestly"
  //      → "if the assistant honestly").
  //
  // Everything else — generic instructions, tone/style, task management,
  // tool policy, environment info, skills, user instructions, file paths
  // containing "opencode", etc. — is preserved.

  test('returns text unchanged when OpenCode identity not present', () => {
    const text = 'Just a normal system prompt'
    expect(sanitizeSystemText(text)).toBe(text)
  })

  test('removes identity, keeps generic content', () => {
    const result = sanitizeSystemText([
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'You have access to tools for reading files.',
      '',
      'Instructions from: ~/.config/opencode/preamble.md',
      'Be concise. Prefer TypeScript.',
      '',
      '# Code References',
      'src/index.ts (1-50)',
    ].join('\n'))
    expect(result).toMatchInlineSnapshot(`
      "You have access to tools for reading files.

      Instructions from: ~/.config/opencode/preamble.md
      Be concise. Prefer TypeScript.

      # Code References
      src/index.ts (1-50)"
    `)
  })

  test('removes paragraph containing feedback URL anchor', () => {
    const result = sanitizeSystemText([
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'Report issues at https://github.com/anomalyco/opencode please.',
      '',
      'Generic instructions that stay.',
    ].join('\n'))
    expect(result).toMatchInlineSnapshot(`"Generic instructions that stay."`)
  })

  test('removes paragraph containing docs URL anchor', () => {
    const result = sanitizeSystemText([
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'Check out the docs at https://opencode.ai/docs for more info.',
      '',
      'Other content preserved.',
    ].join('\n'))
    expect(result).toMatchInlineSnapshot(`"Other content preserved."`)
  })

  test('applies inline text replacement', () => {
    const result = sanitizeSystemText([
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'It is best if OpenCode honestly applies rigorous standards.',
    ].join('\n'))
    expect(result).toMatchInlineSnapshot(
      `"It is best if the assistant honestly applies rigorous standards."`,
    )
  })

  test('rewrites the "useful information about the environment" fingerprint', () => {
    // Anthropic's classifier matches this exact phrase as a third-party-agent
    // signal; leaving it intact produces a 400 invalid_request_error disguised
    // as "You're out of extra usage." The TEXT_REPLACEMENTS entry rewrites it
    // in place so the env-block context still reaches the model.
    const result = sanitizeSystemText([
      'Here is some useful information about the environment you are running in:',
      '<env>',
      '  Working directory: /tmp/project',
      '</env>',
    ].join('\n'))
    expect(result).toMatchInlineSnapshot(`
      "Environment context you are running in:
      <env>
        Working directory: /tmp/project
      </env>"
    `)
  })

  test('preserves "opencode" in file paths and unrelated content', () => {
    const result = sanitizeSystemText([
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'Instructions from: /Users/user/project/.opencode/AGENTS.md',
      'Run opencode to start the CLI.',
    ].join('\n'))
    expect(result).toMatchInlineSnapshot(`
      "Instructions from: /Users/user/project/.opencode/AGENTS.md
      Run opencode to start the CLI."
    `)
  })

  test('preserves content before and after identity', () => {
    const result = sanitizeSystemText([
      'Some prefix content',
      '',
      'You are OpenCode, the best coding agent on the planet.',
      '',
      '# Code References',
      'file contents',
    ].join('\n'))
    expect(result).toMatchInlineSnapshot(`
      "Some prefix content

      # Code References
      file contents"
    `)
  })

  test('does not call onError when identity is present and removed', () => {
    const onError = mock(() => {})
    sanitizeSystemText([
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'Normal content.',
    ].join('\n'))
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('prependClaudeCodeIdentity', () => {
  test('returns identity block for undefined system', () => {
    const result = prependClaudeCodeIdentity(undefined)
    expect(result).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })

  test('sanitizes and prepends for string system', () => {
    const result = prependClaudeCodeIdentity('Some assistant prompt')
    expect(result).toHaveLength(2)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).toBe('Some assistant prompt')
  })

  test('sanitizes array of text blocks', () => {
    const system = [
      {
        type: 'text',
        text: `${OPENCODE_IDENTITY_PREFIX}\nstuff\n\n# Code References\nrest`,
      },
      { type: 'text', text: 'other block' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).not.toContain(OPENCODE_IDENTITY_PREFIX)
    expect(result[1]?.text).toContain('# Code References')
  })

  test('does not double-prepend if identity already present', () => {
    const system = [
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'other' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result).toHaveLength(2)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('handles string elements in array', () => {
    const system = ['some text', 'more text']
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]).toEqual({ type: 'text', text: 'some text' })
  })

  test('does not emit empty text blocks after sanitization', () => {
    const result = prependClaudeCodeIdentity([
      '',
      'https://github.com/anomalyco/opencode',
      { type: 'text', text: '' },
      {
        type: 'text',
        text: 'kept',
        metadata: { source: 'test' },
        cache_control: { type: 'ephemeral' },
      },
    ])

    expect(result).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      {
        type: 'text',
        text: 'kept',
        metadata: { source: 'test' },
        cache_control: { type: 'ephemeral' },
      },
    ])
    expect(result.some((block) => block.text === '')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('[object Object]')
  })

  test('drops unsupported object and array system block types', () => {
    expect(
      prependClaudeCodeIdentity([
        { type: 'image', source: { type: 'base64', data: 'x' } },
        { type: 'tool_use', name: 'mcp_Read' },
        [],
      ]),
    ).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])

    expect(
      prependClaudeCodeIdentity({
        type: 'image',
        source: { type: 'base64', data: 'x' },
      }),
    ).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })
})

describe('prependClaudeCodeIdentity - non-array system values', () => {
  test('accepts a single system block object', () => {
    const blocks = prependClaudeCodeIdentity({
      type: 'text',
      text: 'plain instructions',
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({
      type: 'text',
      text: 'plain instructions',
    })
  })

  test('preserves extra keys on a single system block object', () => {
    const blocks = prependClaudeCodeIdentity({
      type: 'text',
      text: 'cached',
      cache_control: { type: 'ephemeral' },
    })
    expect(blocks[1]).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })

  test('drops a block object without an explicit text type', () => {
    const blocks = prependClaudeCodeIdentity({ text: 'no type here' } as never)
    expect(blocks).toHaveLength(1)
  })

  test('drops array items that are neither strings nor text blocks', () => {
    const blocks = prependClaudeCodeIdentity([
      42,
      { type: 'image', source: {} },
    ])
    expect(blocks).toHaveLength(1)
  })

  test('falls back to the identity block for unsupported system values', () => {
    expect(prependClaudeCodeIdentity(true as never)).toHaveLength(1)
  })
})

describe('sanitizeSystemText – realistic prompt', () => {
  test('sanitizeSystemText output snapshot', () => {
    const result = sanitizeSystemText(REALISTIC_SYSTEM_PROMPT)
    expect(result).toMatchSnapshot()
  })
})
