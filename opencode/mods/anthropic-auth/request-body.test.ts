import { describe, expect, mock, test } from 'bun:test'
import { Result } from 'effect'
import { rewriteRequestBody as rewrite } from './request-body.ts'
import { CLAUDE_CODE_IDENTITY, OPENCODE_IDENTITY_PREFIX } from './system-prompt.ts'
import { REALISTIC_SYSTEM_PROMPT } from './system-prompt-sample.ts'
import { prefixToolNames as prefix, stripToolPrefix, ToolNameAliasTable } from './tool-alias.ts'

// Rewriting answers a Result now; a rejected tool name throws here, as the old helpers did.
const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}
const prefixToolNames = (...args: Parameters<typeof prefix>) => unwrap(prefix(...args))
const rewriteRequestBody = (...args: Parameters<typeof rewrite>) => unwrap(rewrite(...args))

const encoder = new TextEncoder()

function shortAlias(name: string): string {
  return `mcp_T${Buffer.from(new TextEncoder().encode(name)).toString('base64url')}`
}

function longAlias(name: string): string {
  // Bun's own hasher: an implementation apart from the one under test.
  return `mcp_H${new Bun.CryptoHasher('sha256').update(name).digest('base64url')}`
}

// The table's encode answers a Result; a rejection throws here, as it did.
const encodeAlias = (aliases: ToolNameAliasTable, name: string) => unwrap(aliases.encode(name))

describe('prefixToolNames', () => {
  test('preserves malformed tool and message entries without throwing', () => {
    const aliases = new ToolNameAliasTable()
    const body = {
      tools: [null, 'not-a-tool', {}, { name: 'valid' }],
      messages: [
        null,
        'not-a-message',
        {},
        { content: null },
        {
          content: [
            'not-a-block',
            null,
            {},
            { type: 'tool_use', name: 'valid' },
          ],
        },
      ],
    }

    let rewritten = ''
    expect(() => {
      rewritten = prefixToolNames(body, false, aliases)
    }).not.toThrow()
    const result = JSON.parse(rewritten)
    expect(result.tools.slice(0, 3)).toEqual([null, 'not-a-tool', {}])
    expect(result.tools[3].name).toBe(shortAlias('valid'))
    expect(result.messages.slice(0, 4)).toEqual([
      null,
      'not-a-message',
      {},
      { content: null },
    ])
    expect(result.messages[4].content.slice(0, 3)).toEqual([
      'not-a-block',
      null,
      {},
    ])
    expect(result.messages[4].content[3].name).toBe(shortAlias('valid'))
    aliases.dispose()
  })

  test('prefixes tool definition names', () => {
    const body = {
      tools: [
        { name: 'read_file', type: 'function' },
        { name: 'write_file', type: 'function' },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBe(shortAlias('read_file'))
    expect(result.tools[1].name).toBe(shortAlias('write_file'))
  })

  test('prefixes tool_use block names in messages', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: '1' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0].name).toBe(shortAlias('bash'))
    expect(result.messages[0].content[1].type).toBe('text')
  })

  test('does not prefix non-tool_use blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'hello',
    })
  })

  test('handles missing tools and messages gracefully', () => {
    const body = { model: 'claude-3' }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.model).toBe('claude-3')
  })

  test('handles tools without names', () => {
    const body = {
      tools: [{ type: 'function' }],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBeUndefined()
  })
})

describe('stripToolPrefix', () => {
  test('strips mcp_ prefix from tool names', () => {
    const text = `{"name": "${shortAlias('read_file')}"}`
    expect(stripToolPrefix(text)).toBe('{"name": "read_file"}')
  })

  test('strips multiple prefixed names', () => {
    const text = `{"name": "${shortAlias('tool_a')}"} and {"name": "${shortAlias('tool_b')}"}`
    const result = stripToolPrefix(text)
    expect(result).toContain('"name": "tool_a"')
    expect(result).toContain('"name": "tool_b"')
  })

  test('does not strip names without mcp_ prefix', () => {
    const text = '{"name": "regular_tool"}'
    expect(stripToolPrefix(text)).toBe(text)
  })

  test('handles whitespace variations in JSON', () => {
    const text = `{"name"  :  "${shortAlias('tool')}"}`
    expect(stripToolPrefix(text)).toBe('{"name": "tool"}')
  })
})

describe('rewriteRequestBody', () => {
  test('prefixes tool names and rewrites system prompt', () => {
    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })
    const result = JSON.parse(rewriteRequestBody(body))
    expect(result.tools[0].name).toBe(shortAlias('bash'))
    // system[0] = billing header, system[1] = identity, system[2] = rest
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('You are a helpful assistant.')
  })

  test('handles missing system field', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))
    // system[0] = billing header, system[1] = identity (no rest block)
    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('returns original string on invalid JSON', () => {
    const body = 'not valid json'
    expect(rewriteRequestBody(body)).toBe(body)
  })

  test('does not call onError when identity is present (rules always match)', () => {
    const onError = mock(() => {})
    const body = JSON.stringify({
      messages: [],
      system: `${OPENCODE_IDENTITY_PREFIX}\nsome other content`,
    })
    rewriteRequestBody(body)
    expect(onError).not.toHaveBeenCalled()
  })

  test('rewrites realistic OpenCode request end-to-end', () => {
    //  Input system prompt (array of blocks):
    //    [0] "You are OpenCode..." + generic content + "# Code References\n..."
    //    [1] "Additional context block"
    //
    //  Expected output (three-block layout):
    //    system[0] = billing header
    //    system[1] = identity
    //    system[2..n] = sanitized system blocks
    //    User messages are untouched.

    const systemPrompt = [
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'You have access to tools.',
      '',
      '# Code References',
      '',
      'Here are some files.',
    ].join('\n')

    const body = JSON.stringify({
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read_file', type: 'function' },
      ],
      messages: [
        { role: 'user', content: 'Help me fix this bug' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: 'tool_1' },
            { type: 'text', text: 'Let me check' },
          ],
        },
      ],
      system: [
        { type: 'text', text: systemPrompt },
        { type: 'text', text: 'Additional context block' },
      ],
    })

    const result = JSON.parse(rewriteRequestBody(body))

    // Three-block layout: billing header, identity, sanitized blocks
    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toContain('You have access to tools.')
    expect(result.system[2].text).toContain('# Code References')
    expect(result.system[2].text).not.toContain(OPENCODE_IDENTITY_PREFIX)
    expect(result.system[3].text).toBe('Additional context block')

    // User messages are untouched
    expect(result.messages[0].content).toBe('Help me fix this bug')
    expect(result.messages[1].content[0].name).toBe(shortAlias('bash'))
  })

  test('handles body with no messages array', () => {
    const body = JSON.stringify({ model: 'claude-3' })
    const result = JSON.parse(rewriteRequestBody(body))
    // No messages → no billing header; system[0] = identity only
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('keeps system blocks in system[] (string content)', () => {
    const body = JSON.stringify({
      system: 'Custom instructions for the assistant.',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2] = rest
    expect(result.system).toHaveLength(3)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('Custom instructions for the assistant.')

    // User message is untouched
    expect(result.messages[0].content).toBe('hello')
  })

  test('keeps system blocks in system[] (array content)', () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'Block A instructions' },
        { type: 'text', text: 'Block B instructions' },
      ],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2..3] = rest
    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('Block A instructions')
    expect(result.system[3].text).toBe('Block B instructions')

    // User message is untouched
    expect(result.messages[0].content).toHaveLength(1)
    expect(result.messages[0].content[0].text).toBe('hello')
  })

  test('keeps system intact when no user messages exist', () => {
    const body = JSON.stringify({
      system: 'Some instructions',
      messages: [],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // No user messages → no billing header; system[0] = identity, system[1] = rest
    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Some instructions')
  })

  test('keeps multiple system blocks as separate entries', () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
        { type: 'text', text: 'Third block' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2..4] = original blocks
    expect(result.system).toHaveLength(5)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('First block')
    expect(result.system[3].text).toBe('Second block')
    expect(result.system[4].text).toBe('Third block')

    // User message is untouched
    expect(result.messages[0].content).toBe('hi')
  })

  test('omits empty and unsupported system blocks without object coercion', () => {
    const result = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
          system: [
            '',
            { type: 'text', text: 'https://opencode.ai/docs' },
            { type: 'text', text: '' },
            [],
            { type: 'image', source: { type: 'base64', data: 'x' } },
          ],
        }),
      ),
    )

    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(
      result.system.every((block: { text: string }) => block.text !== ''),
    ).toBe(true)
    expect(JSON.stringify(result)).not.toContain('[object Object]')
  })

  test('is byte-idempotent with one identity, billing block, and prefixed tools', () => {
    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello' }],
      system: 'Useful instructions',
    })

    const aliases = new ToolNameAliasTable()
    const once = rewriteRequestBody(body, undefined, aliases)
    const twice = rewriteRequestBody(once, undefined, aliases)
    const parsed = JSON.parse(twice)

    expect(twice).toBe(once)
    expect(
      parsed.system.filter(
        (block: { text: string }) => block.text === CLAUDE_CODE_IDENTITY,
      ),
    ).toHaveLength(1)
    expect(
      parsed.system.filter((block: { text: string }) =>
        block.text.includes('x-anthropic-billing-header'),
      ),
    ).toHaveLength(1)
    expect(parsed.tools[0].name).toBe(shortAlias('bash'))
    aliases.dispose()
  })

  test('preserves native mixed tool names while making the rewrite idempotent', () => {
    const body = JSON.stringify({
      tools: [{ name: 'mcp_Bash' }, { name: 'bash' }],
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'mcp_Bash', id: 'native-1' },
            { type: 'tool_use', name: 'bash', id: 'native-2' },
          ],
        },
      ],
    })

    const aliases = new ToolNameAliasTable()
    const once = JSON.parse(rewriteRequestBody(body, undefined, aliases))
    const twiceText = rewriteRequestBody(
      JSON.stringify(once),
      undefined,
      aliases,
    )

    expect(once.tools.map((tool: { name: string }) => tool.name)).toEqual([
      shortAlias('mcp_Bash'),
      shortAlias('bash'),
    ])
    expect(
      once.messages[1].content.map((block: { name: string }) => block.name),
    ).toEqual([shortAlias('mcp_Bash'), shortAlias('bash')])
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(once), aliases)).tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(['mcp_Bash', 'bash'])
    expect(twiceText).toBe(JSON.stringify(once))
    aliases.dispose()
  })

  test('normalizes rewritten-looking system blocks and already-prefixed tools', () => {
    const body = JSON.stringify({
      tools: [{ name: 'mcp_Bash' }],
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        { type: 'text', text: CLAUDE_CODE_IDENTITY },
        { type: 'text', text: 'x-anthropic-billing-header: stale' },
        { type: 'text', text: 'Meaningful instructions' },
        { type: 'text', text: 'x-anthropic-billing-header: duplicate' },
        { type: 'text', text: CLAUDE_CODE_IDENTITY },
      ],
    })

    const aliases = new ToolNameAliasTable()
    const onceText = rewriteRequestBody(body, undefined, aliases)
    const once = JSON.parse(onceText)
    const twiceText = rewriteRequestBody(onceText, undefined, aliases)

    expect(once.system).toHaveLength(3)
    expect(once.system[0].text).toBe(
      'x-anthropic-billing-header: cc_version=2.1.280.790; cc_entrypoint=sdk-cli; cch=2cf24;',
    )
    expect(once.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(once.system[2].text).toBe('Meaningful instructions')
    expect(once.tools[0].name).toBe('mcp_Bash')
    expect(JSON.parse(stripToolPrefix(onceText, aliases)).tools[0].name).toBe(
      'mcp_Bash',
    )
    expect(twiceText).toBe(onceText)
    aliases.dispose()
  })

  test('a compaction changes only the billing stamp before the first breakpoint, a block with no breakpoint of its own', () => {
    const request = (messages: Array<{ role: string; content: string }>) =>
      JSON.stringify({
        tools: [{ name: 'bash', description: 'Run a command.', input_schema: { type: 'object' } }],
        system: [
          { type: 'text', text: REALISTIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Project instructions.', cache_control: { type: 'ephemeral' } },
        ],
        messages,
      })
    // One session: its first request, then its first request after a compaction,
    // whose conversation starts at the summary.
    const before = JSON.parse(
      rewriteRequestBody(
        request([
          { role: 'user', content: 'Fix the login bug in auth.ts, please.' },
          { role: 'assistant', content: 'Looking at auth.ts.' },
          { role: 'user', content: 'Go on.' },
        ]),
      ),
    )
    const after = JSON.parse(
      rewriteRequestBody(
        request([
          { role: 'user', content: 'What did we do so far?' },
          { role: 'assistant', content: 'We fixed the login bug.' },
          { role: 'user', content: 'Go on.' },
        ]),
      ),
    )
    const firstBreakpoint = (system: Array<{ cache_control?: unknown }>) =>
      system.findIndex((block) => block.cache_control !== undefined)
    const cachedPrefix = (body: { tools: unknown; system: Array<{ cache_control?: unknown }> }) =>
      JSON.stringify([body.tools, body.system.slice(1, firstBreakpoint(body.system) + 1)])

    // The stamp leads the system prompt as Claude Code sends it, and follows the
    // first user message, so the compaction changed it ...
    expect(before.system[0].text).toStartWith('x-anthropic-billing-header:')
    expect(after.system[0].text).toStartWith('x-anthropic-billing-header:')
    expect(after.system[0].text).not.toBe(before.system[0].text)
    // ... but it carries no breakpoint, and Anthropic reads it as metadata, out
    // of the cache key: everything else up to the first breakpoint is byte-identical.
    expect(before.system[0]).toEqual({ type: 'text', text: before.system[0].text })
    expect(firstBreakpoint(before.system)).toBe(2)
    expect(firstBreakpoint(after.system)).toBe(2)
    expect(cachedPrefix(after)).toBe(cachedPrefix(before))
    expect(JSON.stringify(after.system.slice(1))).toBe(JSON.stringify(before.system.slice(1)))
  })

  test('is byte-idempotent when there are no users or tools', () => {
    const body = JSON.stringify({ system: 'Only instructions', messages: [] })
    const once = rewriteRequestBody(body)
    const twice = rewriteRequestBody(once)

    expect(twice).toBe(once)
    expect(JSON.parse(twice).system).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'Only instructions' },
    ])
    expect(twice).not.toContain('x-anthropic-billing-header')
    expect(twice).not.toContain('mcp_')
  })
})

describe('ToolNameAliasTable', () => {
  test('rejects unpaired UTF-16 surrogates and round-trips astral pairs', () => {
    const aliases = new ToolNameAliasTable()
    expect(() => encodeAlias(aliases, '\ud800')).toThrow()
    expect(() => encodeAlias(aliases, '\udfff')).toThrow()
    const name = 'tool-😀'
    const alias = encodeAlias(aliases, name)
    expect(aliases.decode(alias)).toBe(name)
    aliases.dispose()
  })

  // Changed: a disposed table now decodes nothing (undefined) where it threw.
  test('decodes nothing after disposal and preserves malformed aliases', () => {
    const aliases = new ToolNameAliasTable()
    expect(aliases.decode('mcp_Tnot-base64!')).toBeUndefined()
    expect(aliases.decode('mcp_T')).toBeUndefined()
    expect(aliases.decode('mcp_TYWJj=')).toBeUndefined()
    aliases.dispose()
    expect(aliases.decode(shortAlias('Read'))).toBeUndefined()
  })

  test('uses UTF-8 base64url aliases for short names', () => {
    const aliases = new ToolNameAliasTable()
    const name = 'Read/é'
    const output = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, aliases),
    )
    expect(output.tools[0].name).toBe(shortAlias(name))
    expect(output.tools[0].name).toMatch(/^mcp_[A-Z][A-Za-z0-9_-]{0,59}$/)
    expect(encoder.encode(output.tools[0].name).byteLength).toBeLessThanOrEqual(
      64,
    )
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(output), aliases)).tools[0]
        .name,
    ).toBe(name)
    aliases.dispose()
  })

  test('keeps Read and read distinct and order-independent', () => {
    for (const names of [
      ['Read', 'read'],
      ['read', 'Read'],
    ]) {
      const aliases = new ToolNameAliasTable()
      const output = JSON.parse(
        prefixToolNames(
          { tools: names.map((name) => ({ name })) },
          false,
          aliases,
        ),
      )
      expect(output.tools[0].name).not.toBe(output.tools[1].name)
      const restored = JSON.parse(
        stripToolPrefix(JSON.stringify(output), aliases),
      )
      expect(restored.tools.map((tool: { name: string }) => tool.name)).toEqual(
        names,
      )
      aliases.dispose()
    }
  })

  test('shares aliases between definitions and historical tool_use references', () => {
    const aliases = new ToolNameAliasTable()
    const output = JSON.parse(
      prefixToolNames(
        {
          tools: [{ name: 'Read' }],
          messages: [{ content: [{ type: 'tool_use', name: 'Read' }] }],
        },
        false,
        aliases,
      ),
    )
    expect(output.tools[0].name).toBe(output.messages[0].content[0].name)
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(output), aliases)).messages[0]
        .content[0].name,
    ).toBe('Read')
    aliases.dispose()
  })

  test('round-trips names beginning with mcp_', () => {
    const aliases = new ToolNameAliasTable()
    const name = 'mcp_Read'
    const output = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, aliases),
    )
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(output), aliases)).tools[0]
        .name,
    ).toBe(name)
    aliases.dispose()
  })

  test('uses mcp_T at 44 bytes and mcp_H at 45 bytes', () => {
    const aliases = new ToolNameAliasTable()
    const shortName = 'x'.repeat(44)
    const longName = 'x'.repeat(45)
    const shortOutput = JSON.parse(
      prefixToolNames({ tools: [{ name: shortName }] }, false, aliases),
    )
    const longOutput = JSON.parse(
      prefixToolNames({ tools: [{ name: longName }] }, false, aliases),
    )
    expect(shortOutput.tools[0].name).toBe(shortAlias(shortName))
    expect(longOutput.tools[0].name).toBe(longAlias(longName))
    expect(shortOutput.tools[0].name).toMatch(/^mcp_T/)
    expect(longOutput.tools[0].name).toMatch(/^mcp_H/)
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(shortOutput), aliases)).tools[0]
        .name,
    ).toBe(shortName)
    expect(
      JSON.parse(stripToolPrefix(JSON.stringify(longOutput), aliases)).tools[0]
        .name,
    ).toBe(longName)
    for (const output of [shortOutput, longOutput]) {
      expect(
        encoder.encode(output.tools[0].name).byteLength,
      ).toBeLessThanOrEqual(64)
      expect(output.tools[0].name).toMatch(/^mcp_[A-Z][A-Za-z0-9_-]{0,59}$/)
    }
    aliases.dispose()
  })

  test('uses the UTF-8 byte boundary rather than JavaScript length', () => {
    const aliases = new ToolNameAliasTable()
    const shortName = 'é'.repeat(22)
    const longName = 'é'.repeat(23)
    expect(encoder.encode(shortName).byteLength).toBe(44)
    expect(encoder.encode(longName).byteLength).toBe(46)
    expect(
      JSON.parse(
        prefixToolNames({ tools: [{ name: shortName }] }, false, aliases),
      ).tools[0].name,
    ).toBe(shortAlias(shortName))
    expect(
      JSON.parse(
        prefixToolNames({ tools: [{ name: longName }] }, false, aliases),
      ).tools[0].name,
    ).toBe(longAlias(longName))
    aliases.dispose()
  })

  test('keeps all requested ASCII lengths within the alias bound', () => {
    const aliases = new ToolNameAliasTable()
    for (const length of [44, 45, 59, 60, 61, 62, 63, 64]) {
      const name = 'x'.repeat(length)
      const output = JSON.parse(
        prefixToolNames({ tools: [{ name }] }, false, aliases),
      )
      expect(
        encoder.encode(output.tools[0].name).byteLength,
      ).toBeLessThanOrEqual(64)
      expect(output.tools[0].name).toMatch(/^mcp_[A-Z][A-Za-z0-9_-]{0,59}$/)
      expect(
        JSON.parse(stripToolPrefix(JSON.stringify(output), aliases)).tools[0]
          .name,
      ).toBe(name)
    }
    aliases.dispose()
  })

  test('uses deterministic SHA-256 aliases for long names', () => {
    const name = 'x'.repeat(64)
    const first = new ToolNameAliasTable()
    const second = new ToolNameAliasTable()
    const firstAlias = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, first),
    ).tools[0].name
    const secondAlias = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, second),
    ).tools[0].name
    expect(firstAlias).toBe(longAlias(name))
    expect(secondAlias).toBe(firstAlias)
    expect(firstAlias).toMatch(/^mcp_[A-Z][A-Za-z0-9_-]{0,59}$/)
    first.dispose()
    second.dispose()
  })

  test('preserves unknown aliases exactly, including case', () => {
    const aliases = new ToolNameAliasTable()
    const text = '{"name":"mcp_Unknown_ALIAS"}'
    expect(stripToolPrefix(text, aliases)).toBe(text)
    aliases.dispose()
  })

  test('enforces entry and original-name byte budgets independently', () => {
    const entries = new ToolNameAliasTable({ maxEntries: 1, maxBytes: 1024 })
    const firstName = 'x'.repeat(45)
    const duplicate = JSON.parse(
      prefixToolNames({ tools: [{ name: firstName }] }, false, entries),
    ).tools[0].name
    expect(
      JSON.parse(
        prefixToolNames({ tools: [{ name: firstName }] }, false, entries),
      ).tools[0].name,
    ).toBe(duplicate)
    expect(() =>
      prefixToolNames({ tools: [{ name: 'y'.repeat(46) }] }, false, entries),
    ).toThrow()
    entries.dispose()

    const bytes = new ToolNameAliasTable({ maxEntries: 10, maxBytes: 45 })
    expect(() =>
      prefixToolNames({ tools: [{ name: 'y'.repeat(64) }] }, false, bytes),
    ).toThrow()
    const validName = 'z'.repeat(45)
    expect(() =>
      prefixToolNames({ tools: [{ name: validName }] }, false, bytes),
    ).not.toThrow()
    expect(() =>
      prefixToolNames({ tools: [{ name: validName }] }, false, bytes),
    ).not.toThrow()
    bytes.dispose()
  })

  test('dispose is idempotent and rejects encoding afterward', () => {
    const aliases = new ToolNameAliasTable()
    aliases.dispose()
    expect(() => aliases.dispose()).not.toThrow()
    expect(() =>
      prefixToolNames({ tools: [{ name: 'x'.repeat(45) }] }, false, aliases),
    ).toThrow()
  })
})

describe('alias-aware request and response transforms', () => {
  test('request rewriting is byte-idempotent with same and fresh tables', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: [{ type: 'tool_use', name: 'Read' }] },
      ],
      tools: [{ name: 'Read' }],
    })
    const firstTable = new ToolNameAliasTable()
    const once = rewriteRequestBody(body, undefined, firstTable)
    expect(rewriteRequestBody(once, undefined, firstTable)).toBe(once)
    const secondTable = new ToolNameAliasTable()
    expect(rewriteRequestBody(body, undefined, secondTable)).toBe(once)
    firstTable.dispose()
    secondTable.dispose()
  })
})

describe('sanitizeSystemText – realistic prompt', () => {
  test('rewriteRequestBody output snapshot', () => {
    const body = JSON.stringify({
      system: REALISTIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read', type: 'function' },
        { name: 'edit', type: 'function' },
      ],
    })
    const result = rewriteRequestBody(body)
    expect(JSON.parse(result)).toMatchSnapshot()
  })
})
