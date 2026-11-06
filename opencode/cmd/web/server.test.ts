// The plugin seam: the composition root on a stand-in host that runs the
// websearch and tool transforms the plugin registers over stand-ins of the
// built-in webfetch and websearch tools, with pages, PDFs and providers in
// memory. It checks what OpenCode sees: the provider and the default it
// sets, what a failed webfetch call answers, and the options.
// tests/web.test.ts runs it in OpenCode.
import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode/plugin/effect"
import { Effect, Exit, Layer, type Scope } from "effect"
import * as MemoryPages from "@dotfiles/opencode-web/memory/pages"
import * as MemoryPdfText from "@dotfiles/opencode-web/memory/pdf-text"
import * as MemoryProviders from "@dotfiles/opencode-web/memory/providers"
import Web, { make } from "./server.ts"

type Host = Parameters<(typeof Web)["effect"]>[0]

interface Provider {
  readonly id: string
  readonly name: string
  readonly execute: (input: { readonly query: string }) => Effect.Effect<ReadonlyArray<{ readonly url: string }>, unknown>
}
interface WebSearchEditor {
  add(provider: Provider): void
  readonly default: { get(): string | false | undefined; set(selection: string | false): void }
}
interface StandInTool {
  execute: (input: unknown, context: unknown) => Effect.Effect<unknown, Tool.Error>
}
interface ToolEditor {
  update(id: string, update: (tool: StandInTool) => void): void
}

interface World {
  readonly pages?: MemoryPages.World
  readonly providers?: Readonly<Record<string, MemoryProviders.Answer>>
  /** The selection the config (or an earlier transform) made before the plugin's. */
  readonly selection?: string | false
  /** How the built-in webfetch fails, by URL; a URL not here answers "built-in body". */
  readonly fetchFailures?: Readonly<Record<string, Tool.Error>>
}

/** The plugin started on a stand-in host, the provider and default it set, and calls through the tools it changed. */
const start = (options: Record<string, unknown> = {}, world: World = {}) =>
  Effect.gen(function* () {
    const searchTransforms: Array<(editor: WebSearchEditor) => void> = []
    const toolTransforms: Array<(editor: ToolEditor) => void> = []
    const host = {
      options,
      websearch: {
        transform: (callback: (editor: WebSearchEditor) => void) =>
          Effect.sync(() => {
            searchTransforms.push(callback)
            return { dispose: Effect.void }
          }),
      },
      tool: {
        transform: (callback: (editor: ToolEditor) => void) =>
          Effect.sync(() => {
            toolTransforms.push(callback)
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    yield* make(() =>
      Layer.mergeAll(MemoryPages.layer(world.pages ?? {}), MemoryPdfText.layer, MemoryProviders.layer(world.providers ?? {})),
    ).effect(host)

    // The host's websearch state: the built-in providers come first, then the config, then the plugins.
    const providers = new Map<string, Provider>()
    let selection = world.selection
    for (const transform of searchTransforms)
      transform({
        add: (provider) => providers.set(provider.id, provider),
        default: { get: () => selection, set: (next) => (selection = next) },
      })

    // The host's tools as the built-ins register them, then the plugins' transforms over them.
    const tools: Record<string, StandInTool> = {
      webfetch: {
        execute: (input) => {
          const url = (input as { url: string }).url
          const failure = world.fetchFailures?.[url]
          return failure === undefined ? Effect.succeed({ content: "built-in body" }) : Effect.fail(failure)
        },
      },
      websearch: {
        execute: (input) =>
          (providers.get(typeof selection === "string" ? selection : "") ?? { execute: () => Effect.fail("no provider") })
            .execute(input as { query: string })
            .pipe(
              Effect.map((results) => ({ results })),
              Effect.mapError(
                (cause) =>
                  new Tool.Error({
                    message: `Unable to search the web for ${(input as { query: string }).query}`,
                    error: { _tag: "WebSearch.Request", providerID: selection, cause },
                  }),
              ),
            ),
      },
    }
    for (const transform of toolTransforms) transform({ update: (id, update) => tools[id] !== undefined && update(tools[id]) })

    /** A call of a tool: its result, or its failure's message. */
    const call = Effect.fn(function* (tool: "webfetch" | "websearch", input: Record<string, unknown>) {
      const exit = yield* Effect.exit(tools[tool]!.execute(input, {}))
      if (Exit.isSuccess(exit)) return exit.value as Record<string, unknown>
      const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
      return reason?._tag === "Fail" ? { failed: reason.error.message, error: reason.error.error } : { failed: "defect" }
    })
    return { providers, selection: () => selection, call }
  })

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

/** The built-in webfetch's failure: its own message over the error it wrapped. */
const builtInFailure = (url: string, inner: string) => new Tool.Error({ message: `Unable to fetch ${url}`, error: new Error(inner) })

describe("the web plugin's search", () => {
  test("registers `web` and makes it the default when nothing chose one", () =>
    scenario(
      Effect.gen(function* () {
        const web = yield* start()
        expect([...web.providers.keys()]).toEqual(["web"])
        expect(web.selection()).toBe("web")
      }),
    ))

  test("leaves the config's choice, or its disabling, alone", () =>
    scenario(
      Effect.gen(function* () {
        expect((yield* start({}, { selection: "tavily" })).selection()).toBe("tavily")
        expect((yield* start({}, { selection: false })).selection()).toBe(false)
      }),
    ))

  test("`web` answers with the first provider of the order that has results", () =>
    scenario(
      Effect.gen(function* () {
        const web = yield* start(
          { order: ["flaky", "steady"] },
          { providers: { steady: [{ url: "https://steady.dev", time: {} }], flaky: { fail: "rate limited", status: 429 } } },
        )
        expect(yield* web.call("websearch", { query: "bun test" })).toEqual({ results: [{ url: "https://steady.dev", time: {} }] })
      }),
    ))

  test("when every provider fails, the tool's failure names each one's error", () =>
    scenario(
      Effect.gen(function* () {
        const web = yield* start({ order: ["exa", "tavily"] }, { providers: { exa: { fail: "Unauthorized", status: 401 }, tavily: { fail: "timed out" } } })
        expect(yield* web.call("websearch", { query: "bun test" })).toEqual({
          failed: "Unable to search the web for bun test: every web search provider failed: exa: HTTP 401: Unauthorized; tavily: timed out",
          error: undefined,
        })
      }),
    ))
})

describe("the web plugin's webfetch", () => {
  test("a call the built-in answers is its answer, untouched", () =>
    scenario(
      Effect.gen(function* () {
        const web = yield* start()
        expect(yield* web.call("webfetch", { url: "https://a.dev" })).toEqual({ content: "built-in body" })
      }),
    ))

  test("a PDF the built-in refused is answered as its text", () =>
    scenario(
      Effect.gen(function* () {
        const url = "https://unh.edu/mayer.pdf"
        const web = yield* start(
          {},
          {
            pages: { [url]: { body: MemoryPdfText.pdf("Daniel 8:14"), contentType: "application/pdf" } },
            fetchFailures: { [url]: builtInFailure(url, "Unsupported fetched file content type: application/pdf") },
          },
        )
        expect(yield* web.call("webfetch", { url, format: "markdown" })).toEqual({
          output: { url, contentType: "application/pdf", format: "markdown", output: "Daniel 8:14" },
          content: "Daniel 8:14",
          metadata: { contentType: "application/pdf", recovered: "pdf" },
        })
      }),
    ))

  test("a body over the built-in's limit is answered cut to cutKB under a note", () =>
    scenario(
      Effect.gen(function* () {
        const url = "https://models.dev/api.json"
        const web = yield* start(
          { cutKB: 1 },
          {
            pages: { [url]: { body: "x".repeat(4096), contentType: "application/json" } },
            fetchFailures: { [url]: builtInFailure(url, "Response too large (exceeds 5242880 byte limit)") },
          },
        )
        const answer = yield* web.call("webfetch", { url })
        expect(answer.content).toBe(
          `[webfetch: the body cut to the first 1 KB of 4 KB. For the rest, download it (\`curl -sL '${url}' -o <file>\`) and read the file in parts.]\n\n${"x".repeat(1024)}`,
        )
      }),
    ))

  test("a 404 fails in the mod's words, with no error under it to replace them", () =>
    scenario(
      Effect.gen(function* () {
        const url = "https://raw.githubusercontent.com/anomalyco/rift/main/README.md"
        const web = yield* start({}, { fetchFailures: { [url]: builtInFailure(url, `StatusCode: non 2xx status code (404 GET ${url})`) } })
        const answer = yield* web.call("webfetch", { url })
        expect(answer.failed).toContain("Stop guessing raw URLs: run `okra repo fetch anomalyco/rift`")
        expect(answer.error).toBeUndefined()
      }),
    ))

  test("any other failure is the built-in's own", () =>
    scenario(
      Effect.gen(function* () {
        const url = "https://www.npr.org/x"
        const failure = builtInFailure(url, "Request timed out")
        const web = yield* start({}, { fetchFailures: { [url]: failure } })
        expect(yield* web.call("webfetch", { url })).toEqual({ failed: `Unable to fetch ${url}`, error: failure.error })
      }),
    ))
})

describe("the web plugin's options", () => {
  test("a malformed option stops the plugin, naming it", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(start({ cutKB: "big" })))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("dotfiles-opencode.web: invalid options")
  })
})
