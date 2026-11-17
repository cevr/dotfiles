// The image handlers over the recording stand-ins: which backend a request
// reaches, what is saved where, and how each failure surfaces.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Ref, Result, type Scope } from "effect"
import { Images, layer, MODEL_REFUSED } from "../model.ts"
import { fail, type ImageFailed, type Outcome } from "../outcome.ts"
import type { Paid, Request } from "../request.ts"
import type { PaidAsk, SubscriptionAsk } from "../service.ts"
import * as backends from "./backends.ts"
import { disk, file, layer as filesLayer } from "./files.ts"

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0))
const png = (width: number, height: number, mark = 0) =>
  Uint8Array.from([0x89, ...ascii("PNG"), 13, 10, 26, 10, ...be32(13), ...ascii("IHDR"), ...be32(width), ...be32(height), 8, 6, 0, 0, mark])

const REF = png(64, 64, 1)
const MASK = png(64, 64, 2)

const request = (overrides: Partial<Request>): Request => ({
  prompt: "a red cube",
  images: [],
  path: "/out/cube.png",
  size: "auto",
  format: "png",
  models: ["gpt-6.1-sol", "gpt-6-sol"],
  paid: Option.none(),
  ...overrides,
})

const flare = (overrides: Partial<Paid>): Paid => ({
  model: "flare",
  quality: Option.none(),
  background: Option.none(),
  n: Option.none(),
  mask: Option.none(),
  ...overrides,
})

interface Script {
  readonly subscription: (ask: SubscriptionAsk) => Effect.Effect<Uint8Array, ImageFailed>
  readonly paid: (ask: PaidAsk) => Effect.Effect<ReadonlyArray<Uint8Array>, ImageFailed>
}

const square: Script = {
  subscription: () => Effect.succeed(png(1024, 1024)),
  paid: (ask) => Effect.succeed(Array.from({ length: Option.getOrElse(ask.n, () => 1) }, (_, i) => png(1536, 1024, i))),
}

interface Ran {
  readonly result: Result.Result<Outcome, ImageFailed>
  readonly calls: ReadonlyArray<string>
  readonly saved: (path: string) => Option.Option<Uint8Array>
}

/** Runs `generate(req)` over the stand-ins and a disk holding `/refs/a.png`, `/refs/b.jpg` and `/refs/mask.png`, `/locked` read-only. */
const run = (req: Request, script: Script) =>
    Effect.gen(function* () {
      const calls = yield* backends.log
      const world = yield* disk(
        [
          ["/refs/a.png", REF],
          ["/refs/b.jpg", REF],
          ["/refs/mask.png", MASK],
        ],
        "/locked",
      )
      const externals = Layer.mergeAll(backends.subscription(calls, script.subscription), backends.paid(calls, script.paid), filesLayer(world))
      const images = yield* Layer.build(layer.pipe(Layer.provide(externals))).pipe(Effect.map((built) => Context.get(built, Images)))
      const result = yield* Effect.result(images.generate(req))
      const files = yield* Effect.forEach(["/out/cube.png", "/out/cube-1.png", "/out/cube-2.png", "/out/cube-3.png", "/locked/x.png"], (path) =>
        Effect.map(file(world, path), (found) => [path, found] as const),
      )
      const saved = new Map(files)
      return { result, calls: yield* Ref.get(calls), saved: (path: string) => Option.flatten(Option.fromNullishOr(saved.get(path))) } satisfies Ran
    })

const outcome = (ran: Ran) => Result.match(ran.result, { onFailure: (failed): Outcome | string => `${failed.code} ${failed.message}`, onSuccess: (done) => done })

/** The outcome of a run that must have succeeded; a failure's words fail the case. */
const succeeded = (ran: Ran) =>
  Result.match(ran.result, {
    onFailure: (failed) => Effect.die(`expected an outcome, got ${failed.code} ${failed.message}`),
    onSuccess: Effect.succeed,
  })

const story = <A>(body: Effect.Effect<A, never, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("the subscription route", () => {
  test("saves the one image at the request's path and names the route and dimensions", () =>
    story(Effect.gen(function* () {
    const ran = yield* run(request({}), square)
    expect(outcome(ran)).toEqual({ route: "subscription", saved: [{ path: "/out/cube.png", width: Option.some(1024), height: Option.some(1024) }], note: Option.none() })
    expect(ran.calls).toEqual(["subscription gpt-6.1-sol"])
    expect(Option.isSome(ran.saved("/out/cube.png"))).toBe(true)
  })))

  test("sends the request's images as references, in order, with their media types", () =>
    story(Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    yield* run(request({ images: ["/refs/a.png", "/refs/b.jpg"], size: "1536x1024", format: "webp" }), {
      ...square,
      subscription: (ask) =>
        Ref.set(seen, [ask.size, ask.format, ...ask.references.map((part) => `${part.media}:${part.data.at(-1)}`)]).pipe(Effect.as(png(1536, 1024))),
    })
    expect(yield* Ref.get(seen)).toEqual(["1536x1024", "webp", "image/png:1", "image/jpeg:1"])
  })))

  test("moves to the next main model only when the backend refuses one", () =>
    story(Effect.gen(function* () {
    const refusing: Script = {
      ...square,
      subscription: (ask) => {
        if (ask.model === "gpt-6.1-sol") return Effect.fail(fail("GENERATION_FAILED", `The 'gpt-6.1-sol' ${MODEL_REFUSED} with a ChatGPT account.`))
        return Effect.succeed(png(1024, 1024))
      },
    }
    const ran = yield* run(request({}), refusing)
    expect(ran.calls).toEqual(["subscription gpt-6.1-sol", "subscription gpt-6-sol"])
    expect(Option.isSome(ran.saved("/out/cube.png"))).toBe(true)

    const limited = yield* run(request({}), { ...square, subscription: () => Effect.fail(fail("GENERATION_FAILED", "Image generation failed: Rate limit exceeded")) })
    expect(limited.calls).toEqual(["subscription gpt-6.1-sol"])
    expect(outcome(limited)).toBe("GENERATION_FAILED Image generation failed: Rate limit exceeded")

    const allRefused = yield* run(request({}), { ...square, subscription: (ask) => Effect.fail(fail("GENERATION_FAILED", `${ask.model}: ${MODEL_REFUSED}`)) })
    expect(outcome(allRefused)).toBe(`GENERATION_FAILED gpt-6-sol: ${MODEL_REFUSED}`)
  })))

  test("notes a size the backend changed", () =>
    story(Effect.gen(function* () {
    const ran = yield* run(request({ size: "1024x1536" }), { ...square, subscription: () => Effect.succeed(png(1254, 1254)) })
    expect(Option.getOrNull((yield* succeeded(ran)).note)).toBe(
      "Note: the subscription backend returned 1254x1254 for 1024x1536; it chooses the final size. The paid route gives an exact size.",
    )
  })))
})

describe("the paid route", () => {
  test("is taken only with paid, saves each image numbered, and names the model", () =>
    story(Effect.gen(function* () {
    const ran = yield* run(request({ paid: Option.some(flare({ n: Option.some(3), quality: Option.some("high") })) }), square)
    expect(ran.calls).toEqual(["paid gpt-image-2.5-flare"])
    const result = yield* succeeded(ran)
    expect(result.route).toBe("paid: gpt-image-2.5-flare, quality high, n 3")
    expect(result.saved.map((saved) => saved.path)).toEqual(["/out/cube-1.png", "/out/cube-2.png", "/out/cube-3.png"])
    expect(Option.isNone(ran.saved("/out/cube.png"))).toBe(true)
  })))

  test("edits the request's images under the mask", () =>
    story(Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    yield* run(request({ images: ["/refs/a.png"], paid: Option.some(flare({ model: "sunburst", mask: Option.some("/refs/mask.png") })) }), {
      ...square,
      paid: (ask) =>
        Ref.set(seen, [ask.model, `${ask.sources.length}`, Option.match(ask.mask, { onNone: () => "none", onSome: (mask) => `${mask.media}:${mask.data.at(-1)}` })]).pipe(
          Effect.as([png(10, 10)]),
        ),
    })
    expect(yield* Ref.get(seen)).toEqual(["gpt-image-2.5-sunburst", "1", "image/png:2"])
  })))
})

describe("the cost rule", () => {
  test.each([
    request({}),
    request({ images: ["/refs/a.png", "/refs/b.jpg"] }),
    request({ size: "1536x1024", format: "jpeg" }),
    request({ size: "1024x1536", format: "webp", models: ["gpt-6-sol"] }),
  ])("a request without paid never reaches the paid backend: %#", (req) =>
    story(Effect.gen(function* () {
    const ran = yield* run(req, square)
    expect(ran.calls.every((call) => call.startsWith("subscription "))).toBe(true)
    expect(ran.calls.length).toBeGreaterThan(0)
  })))
})

describe("failures", () => {
  test("a broken option fails before any backend is asked", () =>
    story(Effect.gen(function* () {
    const ran = yield* run(request({ size: "huge" }), square)
    expect(outcome(ran)).toBe("INVALID_INPUT Invalid size: huge (use auto or WIDTHxHEIGHT, e.g. 1536x1024).")
    expect(ran.calls).toEqual([])
  })))

  test("a missing image fails before any backend is asked", () =>
    story(Effect.gen(function* () {
    const ran = yield* run(request({ images: ["/refs/gone.png"] }), square)
    expect(outcome(ran)).toBe("INVALID_INPUT Cannot read /refs/gone.png: not found")
    expect(ran.calls).toEqual([])
  })))

  test("a path that cannot be written is WRITE_FAILED", () =>
    story(Effect.gen(function* () {
    const ran = yield* run(request({ path: "/locked/x.png" }), square)
    expect(outcome(ran)).toBe("WRITE_FAILED Cannot write /locked/x.png: read-only")
  })))

  test("the backend's failure comes back with its code", () =>
    story(Effect.gen(function* () {
    const ran = yield* run(request({}), { ...square, subscription: () => Effect.fail(fail("AUTH_EXPIRED", "Codex token rejected (expired or invalid). Run `codex login`.")) })
    expect(outcome(ran)).toBe("AUTH_EXPIRED Codex token rejected (expired or invalid). Run `codex login`.")
  })))
})
