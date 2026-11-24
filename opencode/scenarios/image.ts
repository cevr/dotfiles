// The image tool in real OpenCode, with a scripted model, the wakes and
// Prime, its backends local fakes. SCENARIO_MODE picks the run:
// - `direct` (default): the root lists OpenCode's image models through Code
//   Mode (a config provider offers one, so OpenCode's own image tool would be
//   offered), loads the `image` skill, then calls `image` for a subscription image at
//   `art/fox.png` and ends its turn; the job's end letter wakes it with the
//   saved path, and it answers.
// - `kernel`: with the kernel loaded (only `kernel` is offered then), a cell
//   calls `tools.image` with `paid`, saving `art/logo.png`; its letter wakes
//   the root the same way.
// With SCENARIO_LIVE=1 the direct run (only it: it never sets `paid`) gives
// the image plugin no options, so the runner asks the real Codex backend with
// the real `codex login`: one free subscription image, by hand only.
// Otherwise the image plugin's options point the runner at a fake Codex backend (an
// SSE stream with one image) under a fake Codex home, and at a fake Images
// API; OPENAI_API_KEY is the harness's fake. Nothing reaches chatgpt.com or
// api.openai.com.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out OPENAI_API_KEY=sk-fake [SCENARIO_MODE=kernel] bunx opencode-drive run scenarios/image.ts
//
// It writes, under SCENARIO_OUT, `image-<mode>-<name>.txt` for its kept frame
// (`done`), `image-<mode>-timeout.txt` when a wait times out, and
// `image-<mode>-requests.json`, `-transcripts.json`, `-backends.json` (each
// request the fakes saw: route, path, whether it carried the expected
// credential, the model asked), `-skills.json` and `-files.json` (the saved
// files' first bytes).
import { Effect, Option, Schedule, Schema, Stream } from "effect"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { stamp } from "../tests/hang-guard.ts"

const root = process.cwd()
const out = process.env.SCENARIO_OUT || "out"
/** `direct` unless SCENARIO_MODE says `kernel`. */
const modeOf = (kernel: boolean) => {
  if (kernel) return "kernel"
  return "direct"
}
const mode = modeOf(process.env.SCENARIO_MODE === "kernel")

const TOKEN = "fake-codex-access-token"
const ACCOUNT = "acct-fake"
/** A 1x1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

interface Seen {
  readonly route: "codex" | "paid"
  readonly path: string
  readonly authorized: boolean
  readonly model: string
}
const seen: Array<Seen> = []

const Body = Schema.fromJsonString(Schema.Struct({ model: Schema.String }))
const decodeBody = Schema.decodeUnknownOption(Body)
/** The model a request body asks for, or "" when it names none. */
const modelOf = (body: string) => Option.match(decodeBody(body), { onNone: () => "", onSome: (parsed) => parsed.model })

const sse = (...events: ReadonlyArray<object>) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

const codex = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = await request.text()
    seen.push({
      route: "codex",
      path: new URL(request.url).pathname,
      authorized: request.headers.get("authorization") === `Bearer ${TOKEN}` && request.headers.get("chatgpt-account-id") === ACCOUNT,
      model: modelOf(body),
    })
    return new Response(sse({ type: "response.created" }, { type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: PNG } }), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

const paid = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = await request.text()
    seen.push({ route: "paid", path: new URL(request.url).pathname, authorized: request.headers.get("authorization") === `Bearer ${process.env.OPENAI_API_KEY}`, model: modelOf(body) })
    return Response.json({ created: 1, data: [{ b64_json: PNG }] })
  },
})

const live = process.env.SCENARIO_LIVE === "1" && mode === "direct"

const codexHome = join(out, `codex-home-${mode}`)
mkdirSync(join(codexHome, ".codex"), { recursive: true })
writeFileSync(join(codexHome, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: TOKEN, account_id: ACCOUNT } }))

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

/** `yes` when `ok`, else `no`. */
const said = (ok: boolean, yes: string, no: string) => {
  if (ok) return say(yes)
  return say(no)
}

const KERNEL = 'const answer = await tools.image({ prompt: "A paid logo", path: "art/logo.png", paid: { model: "flare" } })\nconsole.log(answer)'

const rules: ReadonlyArray<readonly [string, (request: string) => Stream.Stream<Llm.Output>]> = [
  ["step-image", () => call("call_image_models", "execute", { code: "return await tools.opencode.models({ type: \"image\" })" })],
  ["call_image_models", () => call("call_skill_image", "skill", { id: "image" })],
  ["call_skill_image", () => call("call_image_fox", "image", { prompt: "A red fox", size: "1536x1024", path: "art/fox.png" })],
  ["call_image_fox", (s) => said(/Image job j[0-9a-z]{6} started via subscription/.test(s), "Fox started.", "Fox refused.")],
  ['Image (subscription): \\"A red fox', () => say("Woke on fox.")],
  ["step-kernel", () => call("call_kernel_logo", "kernel", { code: KERNEL, description: "Paid logo" })],
  ["call_kernel_logo", (s) => said(/Image job j[0-9a-z]{6} started via paid/.test(s), "Logo started.", "Logo refused.")],
  ['Image (paid: gpt-image-2.5-flare, quality auto, n 1): \\"A paid logo', () => say("Woke on logo.")],
]
/** The answer of the rule whose marker comes last in the request; none found, nothing to do. */
const reply = (s: string) => {
  const marked = rules.flatMap(([marker, respond]) => Option.toArray(Option.liftPredicate({ at: s.lastIndexOf(marker), respond }, (rule) => rule.at >= 0)))
  const last = marked.toSorted((left, right) => right.at - left.at)
  return Option.match(Option.fromUndefinedOr(last[0]), { onNone: () => say("Nothing to do."), onSome: (rule) => rule.respond(s) })
}

/** The plugins: the wakes, the kernel in the kernel run, and the image tool on the fakes. */
type ImagePlugin = {
  readonly package: string
  readonly options: { readonly codexOrigin?: string; readonly codexHome?: string; readonly openaiOrigin?: string }
}

/** The image plugin's options: none live, else the fakes. */
const imageOptions = (): ImagePlugin["options"] => {
  if (live) return {}
  return { codexOrigin: `${codex.url.origin}/backend-api/codex`, codexHome, openaiOrigin: `${paid.url.origin}/v1` }
}
const plugins = (kernel: string, image: ImagePlugin) => {
  const wake = { package: `${root}/cmd/wake`, options: { backstop: "off" } }
  if (mode === "kernel") return [wake, kernel, image]
  return [wake, image]
}

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV || "" },
    config: {
      autoupdate: false,
      username: "Demo",
      plugins: plugins(`${root}/cmd/kernel`, { package: `${root}/cmd/image`, options: imageOptions() }),
      // An image model OpenCode offers, so its own image tool would be registered but for the plugin's removal.
      providers: {
        painter: { package: "aisdk:@ai-sdk/openai-compatible", options: { baseURL: `${paid.url.origin}/v1`, apiKey: "sk-painter" }, models: { painter: { type: "image" } } },
      },
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm, opencode, directory }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly session: "root" | "title"; readonly at: number; readonly request: string }> = []
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) {
          requests.push({ session: "title", at: stamp(), request: s })
          return say("Image fixture")
        }
        requests.push({ session: "root", at: stamp(), request: s })
        return reply(s)
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const firstBytes = (file: string) => {
        const path = join(directory, file)
        if (!existsSync(path)) return "missing"
        return readFileSync(path).subarray(0, 8).toString("hex")
      }
      const dump = Effect.gen(function* () {
        writeFileSync(`${out}/image-${mode}-requests.json`, JSON.stringify(requests))
        writeFileSync(`${out}/image-${mode}-backends.json`, JSON.stringify(seen))
        writeFileSync(`${out}/image-${mode}-files.json`, JSON.stringify({ fox: firstBytes("art/fox.png"), logo: firstBytes("art/logo.png") }))
        if (live && existsSync(join(directory, "art/fox.png"))) copyFileSync(join(directory, "art/fox.png"), `${out}/image-live-fox.png`)
        const skills = yield* opencode.skill.list().pipe(
          Effect.map((answer) => answer.data.map((skill) => ({ id: skill.id, path: skill.path }))),
          Effect.orElseSucceed(() => "unreadable"),
        )
        writeFileSync(`${out}/image-${mode}-skills.json`, JSON.stringify(skills))
        const page = yield* opencode.session.list()
        const transcripts = yield* Effect.forEach(page.data, (session) =>
          opencode.session.context({ sessionID: session.id }).pipe(Effect.map((messages) => ({ id: session.id, parentID: session.parentID, title: session.title, messages }))),
        )
        writeFileSync(`${out}/image-${mode}-transcripts.json`, JSON.stringify(transcripts))
      })
      const until = (ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.map(text),
          Effect.filterOrFail(ready, () => "pending"),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/image-${mode}-timeout.txt`, text(frame))), Effect.andThen(dump))),
        )
      const keep = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/image-${mode}-${name}.txt`, text(frame))
        })

      if (mode === "direct") {
        // A subscription image, called directly; its job's end wakes the idle session.
        yield* ui.submit("step-image")
        yield* until((frame) => frame.includes("Fox started.") || frame.includes("Fox refused."))
        // A live image takes up to two minutes.
        yield* until((frame) => frame.includes("Woke on fox."), 1500)
      } else {
        // A paid image, called from a kernel cell, against the fake Images API.
        yield* ui.submit("step-kernel")
        yield* until((frame) => frame.includes("Logo started.") || frame.includes("Logo refused."))
        yield* until((frame) => frame.includes("Woke on logo."), 400)
      }
      yield* keep("done")
      yield* dump
      codex.stop(true)
      paid.stop(true)
    }),
)
