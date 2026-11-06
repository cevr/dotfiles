/**
 * One web run in real OpenCode (the fork, embedded through its SDK), on the
 * scripted model, with a stand-in search plugin (`flaky`, which always fails,
 * and `steady`, which always answers) loaded from config. The test starts it
 * in a child process whose HOME and XDG dirs are a scratch dir:
 * `bun tests/web/run.ts <spec.json>`.
 *
 * Two OpenCode instances run one after the other on the same data dir. The
 * first, without the web plugin, asks the consent form on a root session's
 * websearch call; the run answers it, choosing `flaky`, which OpenCode saves.
 * The second loads the web plugin (order: flaky, steady) and runs the task
 * `web check`: a subagent's websearch, then webfetch calls of a loopback
 * site's PDF, a body over 5 MB and a missing page. Any form the second
 * instance asks is recorded and never answered. It writes both sessions'
 * messages, the subagent's, and the forms to `<base>/result.json`.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { samplePdf } from "../../mods/web/process/sample-pdf.ts"
import { BIG_BYTES, BIG_PATH, CHECK_TASK, PDF_PATH, PDF_TEXT, PICK_TASK, serve, STEADY_URL } from "./sim.ts"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly web: string
}

/** A form the run saw: the instance, its field keys, and the answer given (none in the second instance). */
export interface SeenForm {
  readonly instance: "before" | "with-web"
  readonly keys: ReadonlyArray<string>
  readonly answer?: Readonly<Record<string, string>>
}

export interface Result {
  readonly before: unknown
  readonly messages: unknown
  /** Each subagent session the second run's session started, to its messages. */
  readonly children: Readonly<Record<string, unknown>>
  readonly forms: ReadonlyArray<SeenForm>
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(spec.base, "work")
const config = join(spec.base, "config")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })

const pdf = samplePdf(PDF_TEXT)
const big = "line of a large body\n".repeat(Math.ceil(BIG_BYTES / 21)).slice(0, BIG_BYTES)
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const path = new URL(request.url).pathname
    if (path === PDF_PATH) return new Response(pdf, { headers: { "content-type": "application/pdf" } })
    if (path === BIG_PATH) return new Response(big, { headers: { "content-type": "text/plain; charset=utf-8" } })
    return new Response("not found", { status: 404 })
  },
})
const sim = serve(`http://127.0.0.1:${site.port}`)

// The stand-in providers, in the promise plugin form.
const providers = join(spec.base, "providers")
mkdirSync(providers, { recursive: true })
writeFileSync(join(providers, "package.json"), JSON.stringify({ type: "module", exports: { "./server": "./server.js" } }))
writeFileSync(
  join(providers, "server.js"),
  `export default { id: "fixture.search", async setup(ctx) {
  await ctx.websearch.transform((editor) => {
    editor.add({ id: "flaky", name: "Flaky", execute: async () => { throw new Error("flaky is down (stand-in)") } })
    editor.add({ id: "steady", name: "Steady", execute: async (input) => [{ url: ${JSON.stringify(STEADY_URL)}, title: "Steady result", content: "steady answered " + input.query, time: {} }] })
  })
} }\n`,
)

const content = (plugins: ReadonlyArray<unknown>) => ({
  model: "sim/sim-model",
  providers: {
    sim: {
      name: "Sim",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${sim.server.port}/v1`, apiKey: "sim-key" },
      models: {
        "sim-model": {
          name: "Sim",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  },
  plugins: [{ package: providers }, ...plugins],
})

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface FormInfo {
  readonly id: string
  readonly fields: ReadonlyArray<{ readonly key: string }>
}
interface Embedded {
  readonly sessions: {
    readonly create: (input: { location: { directory: string } }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    readonly context: (input: { sessionID: string }) => Promise<unknown>
    readonly form: {
      readonly list: (input: { sessionID: string }) => Promise<ReadonlyArray<FormInfo>>
      readonly reply: (input: { sessionID: string; formID: string; answer: Record<string, string> }) => Promise<void>
    }
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: Record<string, unknown>) => Promise<Embedded> }
}
const { OpenCode } = (await import(join(spec.fork, "packages/sdk/src/index.ts"))) as Sdk

const forms: SeenForm[] = []
// One database file for both instances, so the choice the first saves is there for the second (the SDK's default is in memory).
const database = { path: join(spec.base, "opencode.db") }

/** Runs `task` in a new root session until it is idle, answering each form the session asks by `answer` (undefined: left unanswered). */
const runTask = async (
  opencode: Embedded,
  task: string,
  instance: SeenForm["instance"],
  answer: (keys: ReadonlyArray<string>) => Record<string, string> | undefined,
) => {
  const session = await opencode.sessions.create({ location: { directory: work } })
  const seen = new Set<string>()
  let done = false
  const poll = (async () => {
    while (!done) {
      const pending = await opencode.sessions.form.list({ sessionID: session.id }).catch(() => [] as ReadonlyArray<FormInfo>)
      for (const form of pending) {
        if (seen.has(form.id)) continue
        seen.add(form.id)
        const keys = form.fields.map((field) => field.key)
        const reply = answer(keys)
        forms.push({ instance, keys, ...(reply === undefined ? {} : { answer: reply }) })
        if (reply !== undefined) await opencode.sessions.form.reply({ sessionID: session.id, formID: form.id, answer: reply })
      }
      await Bun.sleep(100)
    }
  })()
  await opencode.sessions.prompt({ sessionID: session.id, text: task })
  await opencode.experimental.session.wait({ sessionID: session.id })
  done = true
  await poll
  return { id: session.id, messages: await opencode.sessions.context({ sessionID: session.id }) }
}

try {
  // Before the plugin: answer the consent form with `choose`, then `flaky`, as an owner once did.
  const first = await OpenCode.create({ events: { persist: true }, database, config: { directory: config, project: false, content: JSON.stringify(content([])) } })
  const before = await runTask(first, PICK_TASK, "before", (keys): Record<string, string> | undefined =>
    keys.includes("choice") ? { choice: "choose" } : keys.includes("provider") ? { provider: "flaky" } : undefined,
  ).finally(() => first.close())

  // With the plugin: nobody answers a form.
  const second = await OpenCode.create({
    events: { persist: true }, database,
    config: { directory: config, project: false, content: JSON.stringify(content([{ package: spec.web, options: { order: ["flaky", "steady"] } }])) },
  })
  try {
    const check = await runTask(second, CHECK_TASK, "with-web", () => undefined)
    const ids = new Set([...JSON.stringify(check.messages).matchAll(/ses_[A-Za-z0-9]+/g)].map((match) => match[0]).filter((id) => id !== check.id))
    const children: Record<string, unknown> = {}
    for (const id of ids) children[id] = await second.sessions.context({ sessionID: id }).catch(() => undefined)
    const result: Result = { before: before.messages, messages: check.messages, children, forms }
    writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
  } finally {
    await second.close()
  }
} finally {
  sim.server.stop(true)
  site.stop(true)
}
process.exit(0)
