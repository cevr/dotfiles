import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { prefixToolNames as prefix, ToolNameAliasTable } from '../tool-alias.ts'
import { createStrippedStream } from './response-stream.ts'

// Rewriting answers a Result now; a rejected tool name throws here, as the old helpers did.
const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}
const prefixToolNames = (...args: Parameters<typeof prefix>) => unwrap(prefix(...args))

const encoder = new TextEncoder()

function shortAlias(name: string): string {
  return `mcp_T${Buffer.from(new TextEncoder().encode(name)).toString('base64url')}`
}

async function responseText(response: Response): Promise<string> {
  return await response.text()
}

function splitEveryByte(text: string): Uint8Array[] {
  const bytes = encoder.encode(text)
  return Array.from(bytes, (byte) => new Uint8Array([byte]))
}

function responseFromChunks(chunks: Uint8Array[], contentType: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': contentType } })
}

describe('createStrippedStream', () => {
  test('strips tool prefixes from streamed response body', async () => {
    const chunks = [
      `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${shortAlias('bash')}"}}\n\n`,
      `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${shortAlias('read')}"}}\n\n`,
    ]

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })

    const original = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const stripped = createStrippedStream(original)

    const text = await stripped.text()
    expect(text).toContain('"name":"bash"')
    expect(text).toContain('"name":"read"')
    expect(text).not.toContain(shortAlias('bash'))
    expect(text).not.toContain(shortAlias('read'))
  })

  test('preserves response status and headers', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })

    const original = new Response(stream, {
      status: 201,
      statusText: 'Created',
      headers: {
        'content-type': 'text/event-stream',
        'x-custom': 'value',
      },
    })

    const stripped = createStrippedStream(original)
    expect(stripped.status).toBe(201)
    expect(stripped.headers.get('x-custom')).toBe('value')
  })

  test('strips a tool prefix split across arbitrary stream chunks', async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","na',
      `me":"${shortAlias('bash').slice(0, 4)}`,
      `${shortAlias('bash').slice(4, 8)}`,
      `${shortAlias('bash').slice(8)}"}}\n\n`,
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })

    const text = await createStrippedStream(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ).text()

    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain('mcp_')
  })

  test('preserves unicode when every input byte is a separate chunk', async () => {
    const input = `data: {"type":"content_block_start","text":"Привет 👋","content_block":{"type":"tool_use","name":"${shortAlias('Read')}"}}\n\n`
    const bytes = new TextEncoder().encode(input)
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })

    const text = await createStrippedStream(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ).text()

    expect(text).toContain('Привет 👋')
    expect(text).toContain('"name":"Read"')
    expect(text).not.toContain('�')
  })

  test('drops stale content-length after rewriting the response body', () => {
    const original = new Response(
      `data: {"name":"${shortAlias('Read')}"}\n\n`,
      {
        headers: {
          'content-type': 'text/event-stream',
          'content-length': '999',
          'x-custom': 'value',
        },
      },
    )

    const stripped = createStrippedStream(original)

    expect(stripped.headers.get('content-length')).toBeNull()
    expect(stripped.headers.get('x-custom')).toBe('value')
  })

  test('returns original response if no body', () => {
    const original = new Response(null, { status: 204 })
    const result = createStrippedStream(original)
    expect(result).toBe(original)
  })
})

describe('alias-aware request and response transforms', () => {
  test('decodes JSON responses with the explicit table', async () => {
    const aliases = new ToolNameAliasTable()
    const name = 'j'.repeat(64)
    const request = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, aliases),
    )
    const response = new Response(
      JSON.stringify({
        type: 'message',
        content: [{ type: 'tool_use', name: request.tools[0].name }],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
    expect(
      JSON.parse(await responseText(createStrippedStream(response, aliases)))
        .content[0].name,
    ).toBe(name)
    aliases.dispose()
  })

  test('decodes SSE responses across every byte boundary with the same table', async () => {
    const aliases = new ToolNameAliasTable()
    const name = 's'.repeat(64)
    const request = JSON.parse(
      prefixToolNames({ tools: [{ name }] }, false, aliases),
    )
    const sse = `data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"${request.tools[0].name}"}}\n\n`
    const output = await responseText(
      createStrippedStream(
        responseFromChunks(splitEveryByte(sse), 'text/event-stream'),
        aliases,
      ),
    )
    expect(JSON.parse(output.slice(6)).content_block.name).toBe(name)
    aliases.dispose()
  })
})
