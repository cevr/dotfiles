// A 429 from Anthropic, read far enough to name what it means. The body is
// read within a bound of bytes, chunks and time; past any of them, or when it
// is not Anthropic's error shape, the response goes on byte for byte as it came.
import { Clock, Context, Duration, Effect, Fiber } from "effect"
import { contentLength, isJsonMediaType } from "../content-headers.ts"
import {
  MAX_RATE_LIMIT_BODY_BYTES,
  MAX_RATE_LIMIT_BODY_CHUNKS,
  probeTimeout,
  rateLimitDiagnostic,
  type RateLimitCategory,
} from "../rate-limit.ts"

export interface RateLimitEnhancement {
  readonly response: Response
  readonly category: RateLimitCategory
}

export interface RateLimitOptions {
  readonly probeTimeoutMs?: number
}

type ByteReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array }

interface ByteReader {
  readonly read: () => Promise<ByteReadResult>
  readonly cancel: (reason?: unknown) => Promise<void>
  readonly releaseLock: () => void
}

type ByteReadOutcome =
  | { readonly ok: true; readonly result: ByteReadResult }
  | { readonly ok: false; readonly error: unknown }

const guardedRead = (reader: ByteReader): Promise<ByteReadOutcome> =>
  reader.read().then(
    (result) => ({ ok: true, result }),
    (error: unknown) => ({ ok: false, error }),
  )

const TIMED_OUT = Symbol("timed-out")

/**
 * The time a probe reads by: the host's clock, from the context the probe runs
 * in, so a simulated host's clock bounds it as OpenCode's does.
 */
interface ProbeClock {
  readonly now: () => number
  /** A wait of `ms` on the clock, and its cancel. */
  readonly after: (ms: number) => { readonly elapsed: Promise<void>; readonly cancel: () => void }
}

const probeClock = (context: Context.Context<never>): ProbeClock => {
  const clock = Context.get(context, Clock.Clock)
  return {
    now: () => clock.currentTimeMillisUnsafe(),
    after: (ms) => {
      const fiber = Effect.runForkWith(context)(clock.sleep(Duration.millis(ms)))
      return { elapsed: Effect.runPromise(Effect.asVoid(Fiber.await(fiber))), cancel: () => fiber.interruptUnsafe() }
    },
  }
}

/** `operation`'s outcome, or `TIMED_OUT` once `timeoutMs` passes first. */
async function beforeTimeout(
  operation: Promise<ByteReadOutcome>,
  timeoutMs: number,
  clock: ProbeClock,
): Promise<ByteReadOutcome | typeof TIMED_OUT> {
  const timer = clock.after(timeoutMs)
  const outcome = await Promise.race([operation, timer.elapsed.then((): typeof TIMED_OUT => TIMED_OUT)])
  timer.cancel()
  return outcome
}

/**
 * `response` again with the bytes already read (`prefix`) first, then the rest
 * of `reader`; `pending` is a read already started, `terminalError` the
 * failure the source already reported.
 */
function replayResponse(
  response: Response,
  reader: ByteReader,
  prefix: readonly Uint8Array[],
  pending: Promise<ByteReadOutcome> | undefined,
  sourceDone: boolean,
  terminalError?: unknown,
): Response {
  let index = 0
  let next = pending
  let done = sourceDone
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefix.length) {
        const chunk = prefix[index]
        index += 1
        if (chunk) controller.enqueue(chunk)
        return
      }
      if (terminalError !== undefined) {
        release()
        controller.error(terminalError)
        return
      }
      if (done) {
        release()
        controller.close()
        return
      }
      const outcome = next ? await next : await guardedRead(reader)
      next = undefined
      if (!outcome.ok) {
        release()
        controller.error(outcome.error)
        return
      }
      if (outcome.result.done) {
        done = true
        release()
        controller.close()
        return
      }
      controller.enqueue(outcome.result.value)
    },
    async cancel(reason) {
      await reader.cancel(reason).then(release, (error: unknown) => {
        release()
        return Promise.reject(error)
      })
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

type BodyProbe =
  | {
      readonly type: "complete"
      readonly text: string
      readonly passthrough: () => Response
      readonly dispose: () => void
    }
  | { readonly type: "passthrough"; readonly response: Response }

function decode(decoder: TextDecoder, bytes?: Uint8Array): string | undefined {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true })
  } catch {
    return undefined
  }
}

async function probeBody(response: Response, timeoutMs: number, clock: ProbeClock): Promise<BodyProbe> {
  if (!response.body) return { type: "passthrough", response }
  const reader: ByteReader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const chunks: Uint8Array[] = []
  const parts: string[] = []
  const deadline = clock.now() + timeoutMs
  const passthrough = (pending?: Promise<ByteReadOutcome>, error?: unknown): BodyProbe => ({
    type: "passthrough",
    response: replayResponse(response, reader, chunks, pending, false, error),
  })
  let chunkCount = 0
  let total = 0

  while (true) {
    const remaining = deadline - clock.now()
    if (remaining <= 0) return passthrough()
    const operation = guardedRead(reader)
    const outcome = await beforeTimeout(operation, remaining, clock)
    if (outcome === TIMED_OUT) return passthrough(operation)
    if (!outcome.ok) return passthrough(undefined, outcome.error)
    const result = outcome.result

    if (result.done) {
      const tail = decode(decoder)
      if (tail === undefined) {
        return { type: "passthrough", response: replayResponse(response, reader, chunks, undefined, true) }
      }
      parts.push(tail)
      return {
        type: "complete",
        text: parts.join(""),
        passthrough: () => replayResponse(response, reader, chunks, undefined, true),
        dispose: () => reader.releaseLock(),
      }
    }

    chunkCount += 1
    const chunk = result.value
    if (chunk.byteLength === 0) {
      if (chunkCount > MAX_RATE_LIMIT_BODY_CHUNKS) return passthrough()
      continue
    }
    chunks.push(chunk)
    if (chunkCount > MAX_RATE_LIMIT_BODY_CHUNKS) return passthrough()
    total += chunk.byteLength
    if (total > MAX_RATE_LIMIT_BODY_BYTES) return passthrough()
    const decoded = decode(decoder, chunk)
    if (decoded === undefined) return passthrough()
    parts.push(decoded)
  }
}

async function enhance(response: Response, connection: string, options: RateLimitOptions, clock: ProbeClock): Promise<RateLimitEnhancement> {
  const unknown = { response, category: "unknown-rate-limit" as const }
  if (response.status !== 429 || !response.body || !isJsonMediaType(response.headers)) return unknown
  const declaredLength = contentLength(response.headers)
  if (declaredLength !== undefined && declaredLength > MAX_RATE_LIMIT_BODY_BYTES) return unknown

  const probe = await probeBody(response, probeTimeout(options.probeTimeoutMs), clock)
  if (probe.type === "passthrough") return { response: probe.response, category: "unknown-rate-limit" }

  const diagnostic = rateLimitDiagnostic(probe.text, response.headers, connection)
  if (diagnostic === undefined) return { response: probe.passthrough(), category: "unknown-rate-limit" }
  probe.dispose()
  return {
    category: diagnostic.category,
    response: new Response(diagnostic.body, {
      status: response.status,
      statusText: response.statusText,
      headers: diagnostic.headers,
    }),
  }
}

/**
 * A 429 as OpenCode shows it, on the login `connection` names: the diagnostic
 * in Anthropic's error shape, or the response unchanged when its body is not
 * one Anthropic would send, or not read in time.
 */
export const enhanceRateLimitResponse = (
  response: Response,
  connection: string,
  options: RateLimitOptions = {},
): Effect.Effect<RateLimitEnhancement> =>
  Effect.context<never>().pipe(Effect.flatMap((context) => Effect.promise(() => enhance(response, connection, options, probeClock(context)))))
