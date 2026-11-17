// The paid route against a local fake of the Images API: the requests it
// sends, each failure it maps, that the key never reaches an outcome, and the
// cost rule end to end: through the image model, a request without `paid`
// reads no key and sends nothing to the paid API.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Ref, Result } from "effect"
import * as backends from "../memory/backends.ts"
import { disk, layer as filesLayer } from "../memory/files.ts"
import { Images, layer as model } from "../model.ts"
import type { Request } from "../request.ts"
import { type PaidAsk, PaidImages } from "../service.ts"
import { layer } from "./images.ts"

const KEY = "sk-proj-paidKEY0123456789abcdef"
const PNG_A = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])
const PNG_B = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 2])

/** What the fake saw of one request: its path, headers, and its JSON body or its form's fields (a file as `name:type:size`). */
interface Seen {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly json: Option.Option<unknown>
  readonly form: ReadonlyArray<readonly [string, string]>
}

type Answer = (seen: Seen) => Response

const fieldOf = (value: FormDataEntryValue) => {
  if (value instanceof File) return `${value.name}:${value.type}:${value.size}`
  return value
}

const read = (request: globalThis.Request): Effect.Effect<Seen> => {
  const path = new URL(request.url).pathname
  const headers = Object.fromEntries(request.headers)
  if ((headers["content-type"] ?? "").startsWith("multipart/form-data")) {
    return Effect.map(Effect.promise(() => request.formData()), (form) => ({
      path,
      headers,
      json: Option.none(),
      form: [...form.entries()].map(([name, value]) => [name, fieldOf(value)] as const),
    }))
  }
  return Effect.map(Effect.promise(() => request.json()), (json): Seen => ({ path, headers, json: Option.some(json), form: [] }))
}

const fake = (answer: Answer) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) =>
            Effect.runPromise(
              read(request).pipe(
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

const images = (...data: ReadonlyArray<string>) => Response.json({ created: 1, data: data.map((b64_json) => ({ b64_json })) })

const ask = (overrides: Partial<PaidAsk>): PaidAsk => ({
  model: "gpt-image-2.5-flare",
  prompt: "a red cube",
  size: "auto",
  format: "png",
  quality: Option.none(),
  background: Option.none(),
  n: Option.none(),
  sources: [],
  mask: Option.none(),
  ...overrides,
})

/** `generate(asked)` against a fake answering `answer`, with `key` stored; the result, what the fake saw and the key's reads. */
const run = (answer: Answer, asked: PaidAsk, key: Option.Option<string> = Option.some(KEY)) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* fake(answer)
        const calls = yield* backends.log
        const paid = yield* Layer.build(layer({ origin: server.origin, timeoutMs: 10_000 }).pipe(Layer.provide(backends.key(calls, key)))).pipe(Effect.map((built) => Context.get(built, PaidImages)))
        const result = yield* Effect.result(paid.generate(asked))
        return { result, seen: yield* Ref.get(server.seen), calls: yield* Ref.get(calls) }
      }),
    ),
  )

type Ran = Awaited<ReturnType<typeof run>>

const failure = (ran: Ran) => Result.match(ran.result, { onFailure: (failed) => `${failed.code} ${failed.message}`, onSuccess: () => "succeeded" })
const bytes = (ran: Ran) => Result.match(ran.result, { onFailure: () => [], onSuccess: (all) => all.map((one) => [...one]) })

describe("the paid route's requests", () => {
  test("a generation is JSON to /images/generations with the key and the options set", async () => {
    const ran = await run(() => images(PNG_A.toBase64(), PNG_B.toBase64()), ask({ size: "1536x1024", quality: Option.some("high"), background: Option.some("opaque"), n: Option.some(2) }))
    expect(bytes(ran)).toEqual([[...PNG_A], [...PNG_B]])
    expect(ran.seen.map((one) => [one.path, one.headers.authorization, one.json])).toEqual([
      [
        "/images/generations",
        `Bearer ${KEY}`,
        Option.some({ prompt: "a red cube", model: "gpt-image-2.5-flare", size: "1536x1024", output_format: "png", quality: "high", background: "opaque", n: 2 }),
      ],
    ])
    expect(ran.calls).toEqual(["key"])
  })

  test("an edit is multipart to /images/edits: one source as image, several as image[], the mask as mask", async () => {
    const one = await run(() => images(PNG_A.toBase64()), ask({ sources: [{ data: PNG_A, media: "image/png" }], mask: Option.some({ data: PNG_B, media: "image/png" }) }))
    expect(one.seen.map((seen) => [seen.path, seen.form])).toEqual([
      [
        "/images/edits",
        [
          ["prompt", "a red cube"],
          ["model", "gpt-image-2.5-flare"],
          ["size", "auto"],
          ["output_format", "png"],
          ["image", "image-0.png:image/png:5"],
          ["mask", "mask.png:image/png:5"],
        ],
      ],
    ])
    const two = await run(() => images(PNG_A.toBase64()), ask({ sources: [{ data: PNG_A, media: "image/jpeg" }, { data: PNG_B, media: "image/webp" }], n: Option.some(3) }))
    expect(two.seen.flatMap((seen) => seen.form.filter(([name]) => name.startsWith("image") || name === "n"))).toEqual([
      ["n", "3"],
      ["image[]", "image-0.jpg:image/jpeg:5"],
      ["image[]", "image-1.webp:image/webp:5"],
    ])
  })
})

describe("the paid route's failures", () => {
  const rejection = (status: number) => () => Response.json({ error: { message: "fixture rejection" } }, { status })

  test.each([
    [401, "AUTH_EXPIRED OpenAI API key was rejected (fixture rejection). Set OPENAI_API_KEY or store a key with `bun cmd/image/key.ts set --stdin`."],
    [403, "AUTH_EXPIRED OpenAI API key was rejected (fixture rejection). Set OPENAI_API_KEY or store a key with `bun cmd/image/key.ts set --stdin`."],
    [429, "GENERATION_FAILED Image generation failed (gpt-image-2.5-flare, HTTP 429): fixture rejection"],
  ])("HTTP %d", async (status, expected) => expect(failure(await run(rejection(status), ask({})))).toBe(expected))

  test("an unexpected body, no image, invalid base64; unpadded base64 is read", async () => {
    expect(failure(await run(() => Response.json({ data: [] }), ask({})))).toBe(
      "GENERATION_FAILED OpenAI returned an unexpected response (gpt-image-2.5-flare): response does not match the expected schema",
    )
    expect(failure(await run(() => images(), ask({})))).toBe("NO_IMAGE OpenAI returned no image data. Try rephrasing the prompt.")
    expect(failure(await run(() => images("@@@"), ask({})))).toBe("DECODE_FAILED OpenAI returned invalid base64 image data")
    expect(bytes(await run(() => images("YQ"), ask({})))).toEqual([[97]])
  })

  test("no key is AUTH_MISSING and sends nothing", async () => {
    const ran = await run(() => images("YQ"), ask({}), Option.none())
    expect(failure(ran)).toBe("AUTH_MISSING No OpenAI API key.")
    expect(ran.seen).toEqual([])
  })

  test("a server that echoes the key in its error never gets it into the outcome", async () => {
    const ran = await run((seen) => Response.json({ error: { message: `bad key ${seen.headers.authorization}` } }, { status: 401 }), ask({}))
    expect(failure(ran)).toStartWith("AUTH_EXPIRED OpenAI API key was rejected (bad key ")
    expect(failure(ran)).not.toContain(KEY)
    const plain = await run(() => new Response(`raw echo ${KEY}`, { status: 500 }), ask({}))
    expect(failure(plain)).not.toContain(KEY)
  })
})

describe("the cost rule, through the image model", () => {
  const request = (overrides: Partial<Request>): Request => ({
    prompt: "a red cube",
    images: [],
    path: "/out/cube.png",
    size: "auto",
    format: "png",
    models: ["gpt-6-sol"],
    paid: Option.none(),
    ...overrides,
  })

  /** Each request through the model, over the real paid route (its fake API and a recording key) and a recording subscription. */
  const through = (requests: ReadonlyArray<Request>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* fake(() => images(PNG_A.toBase64()))
          const calls = yield* backends.log
          const world = yield* disk([["/refs/a.png", PNG_A]], "")
          const paid = layer({ origin: api.origin, timeoutMs: 10_000 }).pipe(Layer.provide(backends.key(calls, Option.some(KEY))))
          const externals = Layer.mergeAll(paid, backends.subscription(calls, () => Effect.succeed(PNG_B)), filesLayer(world))
          const imagesService = yield* Layer.build(model.pipe(Layer.provide(externals))).pipe(Effect.map((built) => Context.get(built, Images)))
          const outcomes = yield* Effect.forEach(requests, (one) => Effect.result(imagesService.generate(one)))
          return { outcomes, calls: yield* Ref.get(calls), seen: yield* Ref.get(api.seen) }
        }),
      ),
    )

  test("a request without paid reads no key and sends nothing to the paid API", async () => {
    const ran = await through([request({}), request({ images: ["/refs/a.png"], size: "1536x1024" }), request({ format: "webp", size: "1024x1536" })])
    expect(ran.outcomes.every(Result.isSuccess)).toBe(true)
    expect(ran.calls).toEqual(["subscription gpt-6-sol", "subscription gpt-6-sol", "subscription gpt-6-sol"])
    expect(ran.seen).toEqual([])
  })

  test("a request with paid reads the key once and sends one request, and the subscription is not asked", async () => {
    const paid = { model: "flare" as const, quality: Option.none(), background: Option.none(), n: Option.none(), mask: Option.none() }
    const ran = await through([request({ paid: Option.some(paid) })])
    expect(ran.calls).toEqual(["key"])
    expect(ran.seen.map((one) => one.path)).toEqual(["/images/generations"])
  })
})
