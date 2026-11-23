// @reads all
// @reads-reason subprocess reads at mods/image/codex/subscription.test.ts: const dir = spawnSync(["mktemp", "-d", "-t", "image-codex"]).stdout.toString().trim()
// The subscription route against a local fake of the Codex backend: the
// request it sends, each failure it maps, and that the login's token and
// account never reach an outcome, a redirect's target or a message.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { Context, Effect, Layer, Ref } from "effect"
import { MODEL_REFUSED } from "../model.ts"
import { Subscription, type SubscriptionAsk } from "../service.ts"
import { FALLBACK_VERSION } from "./credentials.ts"
import { INSTRUCTION, layer } from "./subscription.ts"

const TOKEN = "eyJtokenPart1.eyJtokenPart2.signatureXYZ"
const ACCOUNT = "acct-7f3e9c21-secret"
const IMAGE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7])

/** What the fake saw of one request. */
interface Seen {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

type Answer = (seen: Seen) => Response

const sse = (...events: ReadonlyArray<object>) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
const imageStream = (base64: string) =>
  new Response(sse({ type: "response.created" }, { type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: base64 } }), {
    headers: { "content-type": "text/event-stream" },
  })

/** A fake backend answering with `answer`, recording each request; stopped with the scope. */
const fake = (answer: Answer) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) =>
            Effect.runPromise(
              Effect.promise(() => request.text()).pipe(
                Effect.map((body): Seen => ({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body })),
                Effect.tap((one) => Ref.update(seen, (all) => [...all, one])),
                Effect.map(answer),
              ),
            ),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    return { origin: `http://127.0.0.1:${server.port}`, seen }
  })

/** A scratch home holding `files` (relative path, text), removed with the scope. */
const home = (files: ReadonlyArray<readonly [string, string]>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = spawnSync(["mktemp", "-d", "-t", "image-codex"]).stdout.toString().trim()
      spawnSync(["mkdir", "-p", `${dir}/.codex`])
      files.forEach(([path, text]) => Bun.write(`${dir}/${path}`, text))
      return dir
    }),
    (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
  )

const login: ReadonlyArray<readonly [string, string]> = [
  [".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-never-read-0000", tokens: { access_token: TOKEN, account_id: ACCOUNT, refresh_token: "rt-x" } })],
  [".codex/version.json", JSON.stringify({ latest_version: "0.200.0" })],
]

const ask = (overrides: Partial<SubscriptionAsk>): SubscriptionAsk => ({
  model: "gpt-6.1-sol",
  prompt: "a red cube",
  size: "auto",
  format: "png",
  references: [],
  ...overrides,
})

/** `generate(asked)` against a fake answering `answer`, with `files` in the home; its result (or failure) and what the fake saw. */
const run = (answer: Answer, asked: SubscriptionAsk, files = login, timeoutMs = 10_000) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* fake(answer)
        const dir = yield* home(files)
        const subscription = yield* Layer.build(layer({ origin: server.origin, home: dir, timeoutMs })).pipe(Effect.map((built) => Context.get(built, Subscription)))
        const result = yield* Effect.result(subscription.generate(asked))
        return { result, seen: yield* Ref.get(server.seen) }
      }),
    ),
  )

const failure = (ran: Awaited<ReturnType<typeof run>>) => {
  if (ran.result._tag === "Success") return "succeeded"
  return `${ran.result.failure.code} ${ran.result.failure.message}`
}

describe("the subscription route's request", () => {
  test("is one streamed Responses call with the image tool forced, the size in the prompt, the references as data URLs", async () => {
    const ran = await run(() => imageStream(IMAGE.toBase64()), ask({ size: "1536x1024", format: "webp", references: [{ data: Uint8Array.of(1, 2, 3), media: "image/jpeg" }] }))
    expect(ran.result._tag === "Success" && [...ran.result.success]).toEqual([...IMAGE])
    expect(ran.seen).toHaveLength(1)
    const [one] = ran.seen
    expect(one?.path).toBe("/responses")
    expect(one?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "chatgpt-account-id": ACCOUNT,
      originator: "codex_cli_rs",
      version: "0.200.0",
      "content-type": "application/json",
    })
    expect(one?.headers.session_id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(JSON.parse(one?.body ?? "{}")).toEqual({
      model: "gpt-6.1-sol",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `${INSTRUCTION}\n\na red cube\n\nOutput size: exactly 1536x1024 pixels (landscape).` },
            { type: "input_image", image_url: "data:image/jpeg;base64,AQID", detail: "auto" },
          ],
        },
      ],
      tools: [{ type: "image_generation", size: "1536x1024", output_format: "webp" }],
      tool_choice: { type: "image_generation" },
      store: false,
      stream: true,
    })
  })

  test("sends Codex's fallback version when none is recorded", async () => {
    const ran = await run(() => imageStream("AQID"), ask({}), [login[0] ?? ["", ""]])
    expect(ran.seen[0]?.headers.version).toBe(FALLBACK_VERSION)
  })
})

describe("the subscription route's failures", () => {
  test.each([
    [401, "AUTH_EXPIRED Codex token rejected (expired or invalid). Run `codex login`."],
    [403, "AUTH_EXPIRED Codex token rejected (expired or invalid). Run `codex login`."],
    [429, "GENERATION_FAILED Image generation failed: Rate limit exceeded"],
    [402, "GENERATION_FAILED Image generation failed: Quota exhausted. Check your account billing and usage limits."],
  ])("HTTP %d", async (status, expected) => {
    expect(failure(await run(() => new Response("{}", { status }), ask({})))).toBe(expected)
  })

  test("a refused model's answer carries the words the model fall-through looks for", async () => {
    const detail = JSON.stringify({ detail: `The 'gpt-6.1-sol' ${MODEL_REFUSED} with a ChatGPT account.` })
    expect(failure(await run(() => new Response(detail, { status: 400 }), ask({})))).toBe(
      `GENERATION_FAILED Image generation failed (HTTP 400): The 'gpt-6.1-sol' ${MODEL_REFUSED} with a ChatGPT account.`,
    )
  })

  test("a stream with no image, an empty one or a malformed one", async () => {
    expect(failure(await run(() => new Response(sse({ type: "response.completed" })), ask({})))).toBe("NO_IMAGE Backend returned no image. Try rephrasing the prompt.")
    expect(failure(await run(() => new Response("data: {oops\n\n"), ask({})))).toBe(
      "GENERATION_FAILED Image generation failed: response does not match the expected schema",
    )
    expect(failure(await run(() => imageStream("@@@"), ask({})))).toBe("DECODE_FAILED Backend returned invalid base64 image data")
  })

  test("no login, or a malformed one, is AUTH_MISSING and sends nothing", async () => {
    const none = await run(() => imageStream("AQID"), ask({}), [])
    expect(failure(none)).toMatch(/^AUTH_MISSING No codex credentials at .+\/\.codex\/auth\.json\. Run `codex login` first\.$/u)
    expect(none.seen).toEqual([])
    const malformed = await run(() => imageStream("AQID"), ask({}), [[".codex/auth.json", '{"tokens":{}}']])
    expect(failure(malformed)).toMatch(/^AUTH_MISSING Malformed codex credentials at /u)
    expect(malformed.seen).toEqual([])
  })

  test("a backend that never answers fails at the timeout", async () => {
    const ran = await run(() => new Response(new ReadableStream({ start: () => {} })), ask({}), login, 200)
    expect(failure(ran)).toBe("GENERATION_FAILED Image generation failed: no answer in 0.2 s")
  })

  test("a backend that cannot be reached is a transport failure", async () => {
    const ran = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* home(login)
          const subscription = yield* Layer.build(layer({ origin: "http://127.0.0.1:9", home: dir, timeoutMs: 5_000 })).pipe(Effect.map((built) => Context.get(built, Subscription)))
          return yield* Effect.flip(subscription.generate(ask({})))
        }),
      ),
    )
    expect(`${ran.code} ${ran.message}`).toBe("GENERATION_FAILED Image generation failed: request transport failed")
  })
})

describe("the subscription route's secrets", () => {
  test("a server that echoes the request's headers in its error never gets them into the outcome", async () => {
    const ran = await run((seen) => new Response(JSON.stringify({ error: { message: `bad request; you sent ${JSON.stringify(seen.headers)}` } }), { status: 400 }), ask({}))
    const words = failure(ran)
    expect(words).toStartWith("GENERATION_FAILED Image generation failed (HTTP 400): bad request; you sent")
    expect(words).not.toContain(TOKEN)
    expect(words).not.toContain("eyJtokenPart1")
    expect(words).not.toContain(ACCOUNT)
  })

  test("a stream whose failure echoes the token is redacted too", async () => {
    const ran = await run(() => new Response(sse({ type: "error", message: `token ${TOKEN} for ${ACCOUNT} is bad` })), ask({}))
    expect(failure(ran)).not.toContain(TOKEN)
    expect(failure(ran)).not.toContain(ACCOUNT)
  })

  test("a redirect is not followed, so the token never reaches another origin", async () => {
    const ran = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const elsewhere = yield* fake(() => imageStream("AQID"))
          const server = yield* fake(() => new Response("", { status: 307, headers: { location: `${elsewhere.origin}/responses` } }))
          const dir = yield* home(login)
          const subscription = yield* Layer.build(layer({ origin: server.origin, home: dir, timeoutMs: 5_000 })).pipe(Effect.map((built) => Context.get(built, Subscription)))
          const failed = yield* Effect.flip(subscription.generate(ask({})))
          return { failed, elsewhere: yield* Ref.get(elsewhere.seen) }
        }),
      ),
    )
    expect(ran.elsewhere).toEqual([])
    expect(ran.failed.code).toBe("GENERATION_FAILED")
  })
})
