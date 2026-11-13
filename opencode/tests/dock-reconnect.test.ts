// accept: one at a time (it bounds how soon the dock settles after the TUI's first read).
// A subagent row leaves "running" once a service restart ends its turn.
//
// The owner's report (2026-11-10): an install restarted the service while two
// implementors ran. The TUIs' event streams dropped (00:09:35.82), the old
// service failed both turns as it shut down (36.03, 36.11), and the TUIs
// reconnected to the new service while it still booted (36.46, its routes
// answering 503 `service_starting`). The ends went out on a bus no TUI heard,
// the TUI's one read of what runs after the reconnect failed, and nothing read
// it again: the dock kept both rows working for hours ("· 1h 54m · updated 1h
// 37m ago") and counted them. The fork's client data now retries that read and
// reads it again while anything runs (packages/client/src/solid/data.ts).
//
// The fork runs from source in a scratch HOME on a scripted model, as
// tests/reconnect-session.test.ts runs it: the service starts and restarts
// through the CLI, and the TUI runs on a real pty showing a parent whose dock
// lists two working children. The TUI reaches the service through a proxy
// that, as in the owner's timeline, drops the event stream, holds it until the
// new service serves, and may refuse or fail the TUI's read of what runs.
// Before the restart the children's turns end unheard. After it the dock must
// agree with the new service: no live row (no time in its state) for a child
// it does not run, and no subagent count, within SETTLE_MS.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve, type ServedHost } from "../testbeds/gamut/pty-host.ts"
import { freePort, ready, type Service } from "./service.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/dock-reconnect.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = join(import.meta.dir, "..")
const TUI_PLUGINS = ["prime", "status", "git", "cache", "questions", "btw", "skills", "recover", "orchestrate", "escape"]
const SERVER_PLUGINS = ["orchestrate", "status", "queue", "git", "idle-compact", "questions", "skills", "rift", "tool-names", "cache", "memory"]
const TIMEOUT_MS = 180_000
/** How long the dock has, once the TUI can read what runs on the new service, to drop the rows whose turns ended. */
const SETTLE_MS = 20_000
/** How long a TUI on a loaded host has to reconnect and make its first read. */
const START_MS = 60_000
const CHILDREN = ["Streaming child one", "Streaming child two"]

interface Client {
  readonly session: {
    readonly create: (input: { location?: { directory: string }; parentID?: string; title?: string }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
}
interface ClientModule {
  readonly OpenCode: { readonly make: (options: { baseUrl: string; headers: Record<string, string> }) => Client }
}

interface ChatMessage {
  readonly role: string
  readonly content?: unknown
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")).join("")
      : ""

const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id: "sim", object: "chat.completion.chunk", created: 0, model: "sim", choices: [{ index: 0, delta, finish_reason: finish }] })
const SSE = { "content-type": "text/event-stream", "cache-control": "no-cache" }
const unavailable = () => Response.json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })

/** The answers `hold` streams, open until `endHolds` ends them. */
const holds = new Set<ReadableStreamDefaultController<Uint8Array>>()
/** Finish held turns while the TUI cannot hear them. A truncated provider
 * response is retryable, so EOF alone no longer means the turn has ended. */
const endHolds = () => {
  for (const controller of holds) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`))
    controller.close()
  }
  holds.clear()
}

/** The scripted model: a title request gets a title; `hold` streams an answer that never ends on its own; anything else answers `ok`. */
const sim = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: async (request) => {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await request.json()) as { readonly messages?: ReadonlyArray<ChatMessage> }
    const messages = body.messages ?? []
    const titling = messages.some((message) => message.role === "system" && textOf(message.content).includes("You name conversations"))
    const last = messages.at(-1)
    if (!titling && last?.role === "user" && textOf(last.content).includes("hold")) {
      const head = new TextEncoder().encode(`data: ${JSON.stringify(chunk({ role: "assistant", content: "holding" }, null))}\n\n`)
      let held: ReadableStreamDefaultController<Uint8Array> | undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(head)
            held = controller
            holds.add(controller)
          },
          // A request OpenCode gave up on (a cancelled or retried turn) has no answer left to end.
          cancel: () => {
            if (held !== undefined) holds.delete(held)
          },
        }),
        { headers: SSE },
      )
    }
    const events = [
      chunk({ role: "assistant", content: "" }, null),
      chunk({ content: titling ? "Dock" : "ok" }, null),
      chunk({}, "stop"),
      { id: "sim", object: "chat.completion.chunk", created: 0, model: "sim", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    ]
    return new Response([...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join(""), { headers: SSE })
  },
})

const until = async <A>(read: () => Promise<A> | A, done: (value: A) => boolean, label: (last: A) => string, ms: number): Promise<A> => {
  const deadline = Date.now() + ms
  let last = await read()
  while (!done(last)) {
    if (Date.now() > deadline) return expect.unreachable(label(last))
    await Bun.sleep(250)
    last = await read()
  }
  return last
}

/** A dock row of `title` that is live: it ends in its time in its state (`· 12s`, `· 1m 05s`, `· 1h 08m`), maybe with its last update's age. */
const liveRow = (screen: string, title: string) =>
  screen.split("\n").some((line) => line.includes(title) && /· (\d+h \d+m|\d+m( \d+s)?|\d+s)( · updated .*)?\s*$/.test(line))

describe.skipIf(!fork)("the dock after a service restart ends a subagent's turn", () => {
  const kept = keptScratch(Boolean(fork), "dock-reconnect-", true)
  const root = kept.path
  const home = join(root, "home")
  const work = join(root, "work")
  const launch = forkLaunch(fork ?? "", process.execPath)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TERM: "xterm-256color",
    HERDR_ENV: "1",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    ...launch.env,
  }
  const serviceFile = join(home, ".local/state/opencode/service-local.json")
  const hosts: Array<ServedHost> = []

  /** The fork's CLI in the scratch HOME, run to its end; `service stop` in afterAll ends the service it leaves. */
  const opencode = async (...args: ReadonlyArray<string>) => {
    const child = Bun.spawn([...launch.base, ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe" })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, out, err }
  }

  /**
   * The service as the TUI reaches it: every request passes to the service
   * the service file names now, except the event stream while `held` (503, as
   * a service between processes answers) and the TUI's next reads of what runs
   * while `refuseActive` (503 `service_starting`, as a service still booting
   * answers) or `failActive` (500) counts down. Counted in the TUI's own reads,
   * never on a clock it may not reach in time. `drop` ends every open event
   * stream and holds new ones.
   */
  let held = false
  let refuseActive = 0
  let failActive = 0
  /** The TUI's reads of what runs turned away, and when the service first answered one: SETTLE_MS runs from then. */
  let activeTurnedAway = 0
  let activeServedAt = 0
  const streams = new Set<AbortController>()
  const proxyServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const event = url.pathname === "/api/event"
      if (event && held) return unavailable()
      const reading = url.pathname === "/api/session/active"
      if (reading && refuseActive > 0) {
        refuseActive--
        activeTurnedAway++
        return unavailable()
      }
      if (reading && failActive > 0) {
        failActive--
        activeTurnedAway++
        return Response.json({ code: "internal" }, { status: 500 })
      }
      if (reading && activeServedAt === 0) activeServedAt = Date.now()
      const target = await ready(serviceFile, () => "the service behind the proxy")
      const headers = new Headers(request.headers)
      headers.delete("host")
      const abort = new AbortController()
      request.signal.addEventListener("abort", () => abort.abort(), { once: true })
      if (event) streams.add(abort)
      const forget = () => streams.delete(abort)
      const upstream = await fetch(new URL(url.pathname + url.search, target.url), {
        method: request.method,
        headers,
        body: request.body,
        signal: abort.signal,
        redirect: "manual",
      }).catch(unavailable)
      // fetch hands back the body decoded; its encoding headers no longer describe it.
      const back = new Headers(upstream.headers)
      back.delete("content-encoding")
      back.delete("content-length")
      // A body the restart or `drop` cuts ends, as the service's own would, rather than throwing in the test.
      const reader = upstream.body?.getReader()
      const body =
        reader &&
        new ReadableStream<Uint8Array>({
          pull: (controller) =>
            reader.read().then(
              (chunk) => {
                if (!chunk.done) return controller.enqueue(chunk.value)
                forget()
                controller.close()
              },
              () => {
                forget()
                controller.close()
              },
            ),
          cancel: () => {
            forget()
            return reader.cancel().catch(() => undefined)
          },
        })
      return new Response(body, { status: upstream.status, headers: back })
    },
  })
  const proxyURL = proxyServer.url.toString().replace(/\/$/, "")
  const drop = () => {
    held = true
    for (const stream of streams) stream.abort()
    streams.clear()
  }

  afterAll(async () => {
    for (const host of hosts) await host.stop()
    if (existsSync(serviceFile)) await opencode("service", "stop")
    sim.stop(true)
    proxyServer.stop(true)
    kept.done()
  })

  const auth = (service: Service) => ({ authorization: `Basic ${btoa(`opencode:${service.password}`)}` })
  const pid = (service: Service) => fetch(new URL("/api/info", service.url), { headers: auth(service) }).then((response) => response.json() as Promise<{ pid?: number }>)
  /** The sessions the service runs now, by id. */
  const active = (service: Service) =>
    fetch(new URL("/api/session/active", service.url), { headers: auth(service) })
      .then((response) => response.json() as Promise<{ data?: Record<string, unknown> }>)
      .then((body) => body.data ?? {})

  let booted: Promise<ClientModule["OpenCode"]> | undefined
  /** The service, started once for every case, and the fork's client. */
  const boot = () =>
    (booted ??= (async () => {
      for (const dir of [work, home, join(home, ".config"), join(home, ".config/opencode")]) mkdirSync(dir)
      writeFileSync(
        join(home, ".config/opencode/opencode.json"),
        JSON.stringify({
          model: "sim/sim-model",
          providers: {
            sim: {
              name: "Sim",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: `http://127.0.0.1:${sim.port}/v1`, apiKey: "sim-key" },
              models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
            },
          },
          // The owner's server plugins that need no login, network listener or OS job.
          plugins: SERVER_PLUGINS.map((name) => join(ROOT, "cmd", name)),
        }),
      )
      // The owner's TUI plugins, as daily writes them (herdr left out: it reports to a herdr socket).
      writeFileSync(
        join(home, ".config/opencode/cli.json"),
        JSON.stringify({ plugins: [...TUI_PLUGINS.map((name) => join(ROOT, "cmd", name)), "-opencode.btw"], session: { sidebar: "hide" }, theme: { name: "prime" } }),
      )
      // A port of its own: the other test files' scratch services would share the channel's fixed one (tests/service.ts).
      expect(await opencode("service", "set", "port", String(freePort()))).toMatchObject({ code: 0 })
      const started = await opencode("service", "start")
      expect(started).toMatchObject({ code: 0 })
      await ready(serviceFile, () => `the service (${started.err.slice(-500)})`)
      return ((await import(join(fork ?? "", "packages/client/src/promise/index.ts"))) as ClientModule).OpenCode
    })())

  /**
   * One restart under a TUI that shows a new parent with two working
   * children. After the new service serves, the proxy refuses the TUI's read
   * of what runs `refuseActiveReads` times and fails the next `failActiveReads`.
   */
  const scenario = async (name: string, { refuseActiveReads = 0, failActiveReads = 0 }: { readonly refuseActiveReads?: number; readonly failActiveReads?: number } = {}) => {
    const OpenCode = await boot()
    const service = await ready(serviceFile, () => "the service")
    const client = OpenCode.make({ baseUrl: service.url, headers: auth(service) })
    const title = `Dock parent ${name}`
    const parent = await client.session.create({ location: { directory: work }, title })
    await client.session.prompt({ sessionID: parent.id, text: "say parent-ready" })
    await client.experimental.session.wait({ sessionID: parent.id })

    const socket = join(root, `${name}.sock`)
    const command = [...launch.base, "--server", proxyURL, "-s", parent.id] as [string, ...string[]]
    const host = serve({ socket, cwd: home, command, env: { ...env, OPENCODE_PASSWORD: service.password }, cols: 160, rows: 45 })
    hosts.push(host)
    try {
      await until(() => existsSync(socket), Boolean, () => `${name}: the terminal host`, 10_000)
      const screen = async () => (await hostCall(socket, { op: "read", scope: "screen" }).catch(() => ({ rows: [] as ReadonlyArray<string> }))).rows.join("\n")
      await until(screen, (text) => text.includes(title), (last) => `${name}: the TUI never showed the parent:\n${last}`, 60_000)

      const children = await Promise.all(CHILDREN.map((child) => client.session.create({ parentID: parent.id, title: child })))
      for (const child of children) await client.session.prompt({ sessionID: child.id, text: "hold" })
      await until(
        screen,
        (text) => CHILDREN.every((child) => liveRow(text, child)) && text.includes(`◆ ${CHILDREN.length} subagents`),
        (last) => `${name}: the dock never listed the children working:\n${last}`,
        30_000,
      )

      // The owner's timeline: the stream drops, the turns end unheard, the service restarts.
      drop()
      endHolds()
      await until(() => active(service), (running) => children.every((child) => !(child.id in running)), () => `${name}: the children still run`, 30_000)
      const before = await pid(service)
      const restarted = await opencode("service", "restart")
      expect(restarted).toMatchObject({ code: 0 })
      const after = await ready(serviceFile, () => `the restarted service (${restarted.err.slice(-500)})`)
      expect((await pid(after)).pid).not.toBe(before.pid)
      // Nothing resumes a turn that ended: the new service runs neither child.
      const running = await active(after)
      expect(children.filter((child) => child.id in running)).toEqual([])

      refuseActive = refuseActiveReads
      failActive = failActiveReads
      activeTurnedAway = 0
      activeServedAt = 0
      held = false
      const stale = (text: string) => CHILDREN.filter((child) => liveRow(text, child))
      // The TUI still draws the parent: an empty screen has no rows either.
      const settled = (text: string) => text.includes(title) && stale(text).length === 0 && !/◆ \d+ subagents?/.test(text)
      await until(
        screen,
        (text) => activeServedAt > 0 && settled(text),
        (last) => `${name}: the dock still shows ${stale(last).join(", ") || "a subagent count"} (the new service answered the TUI's read of what runs at ${activeServedAt}, 0 for never; ${activeTurnedAway} reads turned away):\n${last}`,
        START_MS + SETTLE_MS,
      )
      expect(Date.now() - activeServedAt, `${name}: ms from the TUI's first answered read of what runs until the dock settled`).toBeLessThan(SETTLE_MS)
      if (refuseActiveReads > 0 || failActiveReads > 0) expect(activeTurnedAway, `${name}: reads of what runs turned away`).toBeGreaterThan(0)
    } finally {
      held = false
      refuseActive = 0
      failActive = 0
      await host.stop()
    }
  }

  test("rows of turns that ended while the TUI was away leave the dock once it reconnects", kept.test(() => scenario("reconnect")), TIMEOUT_MS)

  test("they leave it when the new service still boots as the TUI reconnects, as the owner's did", kept.test(() => scenario("booting", { refuseActiveReads: 3 })), TIMEOUT_MS)

  test("they leave it when the TUI's first read of what runs after the reconnect fails", kept.test(() => scenario("failed-read", { failActiveReads: 1 })), TIMEOUT_MS)
})
