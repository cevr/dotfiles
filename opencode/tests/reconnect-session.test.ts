// A TUI attached to the background service keeps its session across a
// service restart. The owner's TUIs are `opencode -s <id>` on the service
// `daily` restarts on every install; the TUI reconnects by itself and must
// come back to the session it showed, not OpenCode's home page.
//
// The fork runs from source in a scratch HOME on a scripted model: the
// service starts and restarts through the CLI as daily does (`service start`,
// `service restart`), the TUI runs on a real pty (gamut's terminal host), and
// the test reads its screen. Each case is a root, a subagent, a root whose
// turn the restart cuts, a service still booting, and a worker whose Rift is
// gone; after the restart the TUI shows the same session and follows a turn
// sent on the new service.
//
// The booting case is the owner's report (a TUI back on the home page after
// an install's restart): a proxy in front of the service answers 503 for the
// session's GET for a few seconds after the restart, as a service still
// loading its plugins does. Before the fork's 0693cb3cd8 the TUI's reload
// failed once and it went home for good; now it keeps the session and tries
// again. Capture every terminal write, not just the recovered screen: a
// short-lived fetch/503 toast is a failure too. A pane selecting from home is
// tested both with cached metadata (submit during boot) and without it (wait
// for the composer, then submit). The scripted model must receive the prompt.
//
// The proxy can also go down (nothing listens on its port, so connections are
// refused, as in a restart's gap). A TUI opened with -s or --continue while
// the service is down or booting says it waits ("Waiting for the OpenCode
// server") and opens its session, where it used to exit with Bun's "Unable to
// connect. Is the computer able to access the url?" (the owner's 2026-11-11
// report); a picker selection and prompt sent into the gap arrive; a TUI opened
// on a stopped or restarting background service opens its session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve, type ServedHost } from "../testbeds/gamut/pty-host.ts"
import { freePort, ready, type Service } from "./service.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/reconnect-session.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = join(import.meta.dir, "..")
const TUI_PLUGINS = ["prime", "status", "git", "cache", "questions", "btw", "skills", "recover", "orchestrate", "escape"]
const TIMEOUT_MS = 180_000
const SERVER_PLUGINS = ["orchestrate", "guard", "kernel", "status", "queue", "git", "idle-compact", "questions", "skills", "rift", "tool-names", "cache", "web", "memory"]
/** How long the TUI has, after the restarted service can serve, to show its session again. */
const BACK_WITHIN_MS = 20_000
/** How long the booting case refuses the session after the restarted service can serve. */
const BOOTING_MS = 8_000
/**
 * How long a TUI has to start and draw: from source on a host the batch's
 * acceptance run fills, it took over 8 s. A window the TUI must see (a service
 * down or booting) opens once the TUI is up, never on the clock before it starts.
 */
const START_MS = 60_000
/**
 * How long a TUI opened on a ready service has to show its session, and one opened
 * on a down or booting service once the service serves: that service stays down or
 * booting until the TUI says it waits, then BOOTING_MS / 2 more.
 */
const SHOWS_WITHIN = { ready: START_MS, down: BACK_WITHIN_MS, booting: BACK_WITHIN_MS } as const
const WAITING = /Waiting for the OpenCode server/
/** OpenCode's home page: its prompt suggestions. */
const HOME = /Fix a TODO in the codebase|What is the tech stack of this project\?|Fix broken tests/
/** What a TUI that gives up on an unreachable or booting service shows. */
const GAVE_UP = /Could not reach|Unable to connect|did not provide|UnexpectedStatus|cli process failed/

// ToastSurface lives at top=1/right=2, at most 60 columns wide, with
// SplitBorder's vertical edges and an `x` close affordance. Match that UI,
// not words in the transcript (a user can legitimately discuss fetch errors).
const errorToast = (rows: ReadonlyArray<string>): string | undefined => {
  const corner = rows.slice(1, 13).map((row) => row.slice(56)).join("\n")
  return /[┃│▏▕]/u.test(corner) && /\bx\s*[┃│▏▕]/u.test(corner) && /fetch|failed|error|service_starting|unavailable|503|retrying/i.test(corner) ? corner : undefined
}

test("the frame guard recognizes a transient error toast, not transcript text", () => {
  const toast = ["", " ".repeat(60) + "┃  Failed to fetch             x ┃"]
  expect(errorToast(toast)).toContain("Failed to fetch")
  expect(errorToast(["Failed to fetch is text in the session"])).toBeUndefined()
})

/** As much of the fork's client as the test uses; the fork is found at run time, so it is typed here. */
interface Client {
  readonly session: {
    readonly create: (input: { location?: { directory: string }; parentID?: string; title?: string }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    readonly interrupt: (input: { sessionID: string }) => Promise<unknown>
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

/** The scripted model: a title request gets a title, `say <word>` answers `<word>`. */
const answer = (messages: ReadonlyArray<ChatMessage>): string => {
  const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n")
  if (system.includes("You name conversations")) return "Reconnect"
  return /say (\S+)/.exec(textOf(messages.at(-1)?.content))?.[1] ?? "ok"
}

const modelPrompts: string[] = []
const sim = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await request.json()) as { readonly messages?: ReadonlyArray<ChatMessage> }
    modelPrompts.push(textOf(body.messages?.at(-1)?.content))
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id: "sim", object: "chat.completion.chunk", created: 0, model: "sim", choices: [{ index: 0, delta, finish_reason: finish }] })
    // `hold` keeps the turn running: the answer starts and never ends, so the restart cuts a working session.
    if (textOf(body.messages?.at(-1)?.content).includes("hold")) {
      const head = `data: ${JSON.stringify(chunk({ role: "assistant", content: "holding" }, null))}\n\n`
      return new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode(head)),
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      )
    }
    const events = [
      chunk({ role: "assistant", content: "" }, null),
      chunk({ content: answer(body.messages ?? []) }, null),
      chunk({}, "stop"),
      { id: "sim", object: "chat.completion.chunk", created: 0, model: "sim", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    ]
    return new Response([...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join(""), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
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

/**
 * The leader, then `key`, until `opened` shows. A TUI on a loaded host can drop
 * the leader and take `key` as composer text: that text is erased and the chord
 * sent again, at most three times.
 */
const chord = async (socket: string, screen: () => Promise<string>, key: string, opened: RegExp, label: string) => {
  const typed = new RegExp(`┃ ${key}\\s*$`, "m")
  for (let attempt = 1; ; attempt++) {
    await hostCall(socket, { op: "keys", names: ["ctrl+x"] })
    await hostCall(socket, { op: "type", text: key })
    const seen = await until(screen, (text) => opened.test(text) || typed.test(text), (last) => `${label} did not open:\n${last}`, 20_000)
    if (opened.test(seen)) return
    expect(attempt, `${label}: the TUI took the chord's ${key} as text ${attempt} times:\n${seen}`).toBeLessThan(3)
    await hostCall(socket, { op: "keys", names: ["backspace"] })
  }
}

describe.skipIf(!fork)("a TUI on the background service across a service restart", () => {
  const kept = keptScratch(Boolean(fork), "reconnect-session-", true)
  const root = kept.path
  const home = join(root, "home")
  const work = join(root, "work")
  const launch = forkLaunch(fork ?? "", process.execPath)
  // Run an installed old TUI without replacing its binary or the owner's
  // service. The scratch service and typed fixture client stay on OPENCODE_DEV.
  const binary = process.env.OPENCODE_RECONNECT_TUI_BINARY
  const scratchBinary = join(root, "opencode-old")
  const tui = binary ? [scratchBinary] : launch.base
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TERM: "xterm-256color",
    // The owner's TUIs run in herdr panes, where OpenCode turns session tabs off.
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
  const submissions: Array<{ readonly path: string; readonly body: string }> = []

  /**
   * The fork's CLI in the scratch HOME, run to its end. Not `owned`: the
   * service `service start` and `service restart` leave running is the point;
   * `service stop` ends it, and accept's leak check stops it if that fails.
   */
  const opencode = async (...args: ReadonlyArray<string>) => {
    const child = Bun.spawn([...launch.base, ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe", detached: true })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, out, err }
  }

  afterAll(async () => {
    for (const host of hosts) await host.stop()
    if (existsSync(serviceFile)) await opencode("service", "stop")
    sim.stop(true)
    proxyServer.stop(true)
    kept.done()
  })

  /**
   * A stand-in for a service still booting: it passes every request to the
   * service the service file names now, except a GET of a refused session,
   * which it answers 503 `service_starting` until its time.
   */
  const refused = new Map<string, number>()
  let unavailableUntil = 0
  /** A TUI opened while the service boots: the booting window opens at its first request, not on the clock before it starts. */
  let bootingFromFirstRequest = false
  const refusedRequests: string[] = []
  const proxyFetch = async (request: Request) => {
      if (bootingFromFirstRequest) {
        bootingFromFirstRequest = false
        unavailableUntil = Date.now() + BOOTING_MS
      }
      const url = new URL(request.url)
      const sessionID = /^\/api\/session\/([^/]+)$/.exec(url.pathname)?.[1]
      if (Date.now() < unavailableUntil || (request.method === "GET" && sessionID !== undefined && Date.now() < (refused.get(sessionID) ?? 0))) {
        refusedRequests.push(`${request.method} ${url.pathname}`)
        // The service's own answers while it boots: its info (version, pid and the starting code) and every other route.
        if (request.method === "GET" && url.pathname === "/api/info") {
          const info = (await (await fetch(new URL("/api/info", (await ready(serviceFile, () => "the service")).url), { headers: request.headers })).json()) as Record<string, unknown>
          return Response.json({ ...info, code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })
        }
        return Response.json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })
      }
      if (request.method === "POST" && url.pathname.includes("/prompt")) submissions.push({ path: url.pathname, body: await request.clone().text() })
      const target = await ready(serviceFile, () => "the service behind the proxy")
      const headers = new Headers(request.headers)
      headers.delete("host")
      const upstream = await fetch(new URL(url.pathname + url.search, target.url), {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        redirect: "manual",
      }).catch(() => Response.json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } }))
      // fetch hands back the body decoded; its encoding headers no longer describe it.
      const back = new Headers(upstream.headers)
      back.delete("content-encoding")
      back.delete("content-length")
      // A body the restart cuts ends, as the service's own would, rather than throwing in the test.
      const reader = upstream.body?.getReader()
      const body =
        reader &&
        new ReadableStream<Uint8Array>({
          pull: (controller) =>
            reader.read().then(
              (chunk) => (chunk.done ? controller.close() : controller.enqueue(chunk.value)),
              () => controller.close(),
            ),
          cancel: () => reader.cancel().catch(() => undefined),
        })
      return new Response(body, { status: upstream.status, headers: back })
  }
  const listen = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: proxyFetch })
  let proxyServer = listen(0)
  let listening = true
  const proxyPort = proxyServer.port ?? 0
  const proxy = {
    url: proxyServer.url.toString().replace(/\/$/, ""),
    refuse: (sessionID: string, until: number) => refused.set(sessionID, until),
    /** Nothing listens on the proxy's port until `up`: a client's connection is refused, as in a restart's gap. */
    down: () => {
      listening = false
      proxyServer.stop(true)
    },
    up: () => {
      if (listening) return
      proxyServer = listen(proxyPort)
      listening = true
    },
  }

  const pid = (service: Service) => fetch(new URL("/api/info", service.url), { headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}` } }).then((response) => response.json() as Promise<{ pid?: number }>)

  let service: Service
  let OpenCode: ClientModule["OpenCode"]
  let client: Client
  let parent: { readonly id: string }
  let child: { readonly id: string }
  beforeAll(
    ...kept.setup(async () => {
      if (binary) cpSync(binary, scratchBinary)
      for (const dir of [work, join(home, ".config/opencode")]) mkdirSync(dir, { recursive: true })
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
      service = await ready(serviceFile, () => `the service (${started.err.slice(-500)})`)
      const module = (await import(join(fork ?? "", "packages/client/src/promise/index.ts"))) as ClientModule
      OpenCode = module.OpenCode
      client = OpenCode.make({ baseUrl: service.url, headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}` } })
      parent = await client.session.create({ location: { directory: work }, title: "Reconnect parent" })
      await client.session.prompt({ sessionID: parent.id, text: "say parent-transcript-marker" })
      await client.experimental.session.wait({ sessionID: parent.id })
      child = await client.session.create({ parentID: parent.id, title: "Reconnect child" })
      await client.session.prompt({ sessionID: child.id, text: "say child-transcript-marker" })
      await client.experimental.session.wait({ sessionID: child.id })
    }, 60_000),
  )

  /** A session of its own with `marker` in its transcript, so no other case's turns scroll it away. */
  const transcript = async (title: string, marker: string, directory = work) => {
    mkdirSync(directory, { recursive: true })
    const made = await client.session.create({ location: { directory }, title })
    await client.session.prompt({ sessionID: made.id, text: `say ${marker}` })
    await client.experimental.session.wait({ sessionID: made.id })
    return made.id
  }

  type Case = { readonly busy?: boolean; readonly gone?: string; readonly booting?: boolean; readonly bootingAll?: boolean; readonly draft?: boolean; readonly starting?: boolean }
  const run = async (name: string, session: () => Promise<string> | string, marker: string, { busy = false, gone, booting = false, bootingAll = false, draft = false, starting = false }: Case = {}) => {
    unavailableUntil = 0
    const sessionID = await session()
    const socket = join(root, `${name}.sock`)
    // A herdr pane's directory need not be the session's: the TUI starts in the HOME.
    // A booting service is the proxy in front of it: the TUI reaches the service through it.
    const explicit = booting || bootingAll || starting || Boolean(binary)
    const command = explicit ? [...tui, "--server", proxy.url, "-s", sessionID] : [...tui, "-s", sessionID]
    const password: Record<string, string> = explicit ? { OPENCODE_PASSWORD: service.password } : {}
    const frames: string[] = []
    const badFrames: string[] = []
    let recording = false
    // Opened while the service still boots (an install restarted it a moment before): the TUI waits for it.
    bootingFromFirstRequest = starting
    const host = serve({ socket, cwd: home, command: command as [string, ...string[]], env: { ...env, ...(binary ? { BUN_OPTIONS: "" } : {}), ...password }, cols: 120, rows: 40 }, (rows) => {
      if (!recording) return
      const frame = rows.join("\n")
      if (frames.at(-1) !== frame) frames.push(frame)
      const toast = errorToast(rows)
      if (toast && badFrames.length === 0) badFrames.push(toast)
    })
    hosts.push(host)
    await until(() => existsSync(socket), Boolean, () => `${name}: the terminal host`, 10_000)
    const screen = async () => {
      const rows = (await hostCall(socket, { op: "read", scope: "screen" })).rows
      expect(badFrames, `${name}: error toast during restart`).toEqual([])
      return rows.join("\n")
    }
    const showing = (text: string) => text.includes(marker)
    await until(screen, showing, (last) => `${name}: the TUI never showed ${marker}:\n${last}`, START_MS)
    if (busy) {
      await client.session.prompt({ sessionID, text: "hold" })
      await until(screen, (text) => text.includes("holding"), (last) => `${name}: the turn never started:\n${last}`, 30_000)
    }
    if (gone !== undefined) rmSync(gone, { recursive: true, force: true })
    // Text typed in the composer and not sent: the restart must not take it.
    const draftText = `${name}-unsent-draft-marker`
    if (draft) {
      await hostCall(socket, { op: "type", text: draftText })
      await until(screen, (text) => text.includes(draftText), (last) => `${name}: the draft never showed:\n${last}`, 10_000)
    }

    const before = await pid(await ready(serviceFile, () => "the service"))
    recording = true
    if (booting) proxy.refuse(sessionID, Number.POSITIVE_INFINITY)
    if (bootingAll) unavailableUntil = Number.POSITIVE_INFINITY
    const restarted = await opencode("service", "restart")
    expect(restarted).toMatchObject({ code: 0 })
    // The new service still refuses the session for a while, as one still loading its plugins does,
    // or every request, its event stream and info too, as the service does until its routes are built.
    const servesAt = Date.now() + BOOTING_MS * Number(booting || bootingAll)
    if (booting) proxy.refuse(sessionID, servesAt)
    if (bootingAll) unavailableUntil = servesAt
    const after = await ready(serviceFile, () => `the restarted service (${restarted.err.slice(-500)})`)
    // A new service process, not the old one answering.
    expect((await pid(after)).pid).not.toBe(before.pid)
    // Every deadline after this runs from when the TUI can be served again.
    await until(() => Date.now(), (now) => now >= servesAt, () => `${name}: the booting window`, BOOTING_MS + 1_000)
    await until(screen, showing, (last) => `${name}: ${BACK_WITHIN_MS / 1000}s after the restart the TUI does not show ${marker}:\n${last}`, BACK_WITHIN_MS)
    if (draft) await until(screen, (text) => text.includes(draftText) && showing(text), (last) => `${name}: the draft is gone after the restart:\n${last}`, BACK_WITHIN_MS)
    // And it is live on the new service: a turn sent there shows up, so the screen is not a stale frame.
    const live = OpenCode.make({ baseUrl: after.url, headers: { authorization: `Basic ${btoa(`opencode:${after.password}`)}` } })
    if (gone !== undefined) {
      // Nothing can run there now; the session stays on screen, and stays.
      await Bun.sleep(5_000)
      expect(showing(await screen())).toBe(true)
      await host.stop()
      expect(badFrames, `${name}: error toast during restart`).toEqual([])
      return
    }
    if (busy) await live.session.interrupt({ sessionID }).catch(() => undefined)
    await live.session.prompt({ sessionID, text: `say ${name}-after-restart` })
    await until(screen, (text) => text.includes(`${name}-after-restart`) && showing(text), (last) => `${name}: the TUI does not follow the session on the new service:\n${last}`, BACK_WITHIN_MS)
    await host.stop()
    expect(frames.length, `${name}: captured restart frames`).toBeGreaterThan(0)
    expect(frames.filter((frame) => HOME.test(frame)), `${name}: went home during restart`).toEqual([])
    expect(badFrames, `${name}: error toast during restart`).toEqual([])
  }

  // A case per test, each with its own timeout: seven restarts in one test outran one timeout on a loaded host.
  const rift = join(root, "rift")
  const restarts: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    ["a root session", () => run("root", () => parent.id, "parent-transcript-marker")],
    ["a subagent session", () => run("child", () => child.id, "child-transcript-marker")],
    ["a root whose turn the restart cuts", () => run("busy", () => parent.id, "parent-transcript-marker", { busy: true })],
    ["a session the booting service refuses", () => run("booting", () => parent.id, "parent-transcript-marker", { booting: true })],
    // The owner's panes: a draft in the composer, and a service that refuses everything while it boots.
    ["a draft in a TUI opened while the service boots", () => run("draft", () => transcript("Reconnect draft", "draft-transcript-marker"), "draft-transcript-marker", { draft: true, starting: true })],
    ["a draft while the service refuses everything", () => run("booting-all", () => transcript("Reconnect booting all", "booting-all-transcript-marker"), "booting-all-transcript-marker", { bootingAll: true, draft: true })],
    ["a worker whose Rift is gone", () => run("gone", () => transcript("Reconnect worker", "worker-transcript-marker", rift), "worker-transcript-marker", { gone: rift })],
  ]
  test.each(restarts)("after `service restart` the TUI keeps %s without an error toast in any frame", (_name, each) => kept.test(each)(), TIMEOUT_MS)

  test(
    "a TUI opened while the service is down or booting waits for it, says so, and opens its session",
    kept.test(async () => {
      refused.clear()
      unavailableUntil = 0
      proxy.up()
      // In the directory the TUI's process sees (macOS's /var is /private/var), so --continue finds it there.
      const opened = realpathSync(work)
      const target = await client.session.create({ location: { directory: opened }, title: "Reconnect opened" })
      await client.session.prompt({ sessionID: target.id, text: "say opened-transcript-marker" })
      await client.experimental.session.wait({ sessionID: target.id })
      // A directory with no session: --continue has none to open there.
      const empty = join(root, "empty")
      mkdirSync(empty, { recursive: true })
      type Open = { readonly name: string; readonly args: ReadonlyArray<string>; readonly mode: "down" | "booting" | "ready"; readonly cwd?: string; readonly shows?: RegExp }
      const open = async ({ name, args, mode, cwd = opened, shows = /opened-transcript-marker/ }: Open) => {
        if (mode === "down") proxy.down()
        if (mode === "booting") unavailableUntil = Number.POSITIVE_INFINITY
        const socket = join(root, `${name}.sock`)
        const badFrames: string[] = []
        const frames: string[] = []
        const host = serve({ socket, cwd, command: [...tui, "--server", proxy.url, ...args] as [string, ...string[]], env: { ...env, ...(binary ? { BUN_OPTIONS: "" } : {}), OPENCODE_PASSWORD: service.password }, cols: 120, rows: 40 }, (rows) => {
          const frame = rows.join("\n")
          if (frames.at(-1) !== frame) frames.push(frame)
          const toast = errorToast(rows)
          if (toast && badFrames.length === 0) badFrames.push(toast)
        })
        hosts.push(host)
        await until(() => existsSync(socket), Boolean, () => `${name}: the terminal host`, 10_000)
        const screen = async () => (await hostCall(socket, { op: "read", scope: "screen" })).rows.join("\n")
        // While the service cannot serve, the terminal says the TUI waits for it; a TUI that gives up says so at once.
        if (mode !== "ready") {
          const said = await until(screen, (text) => WAITING.test(text) || GAVE_UP.test(text), (last) => `${name}: no waiting line while the service cannot serve:\n${last}`, START_MS)
          expect(said, `${name}: no waiting line while the service cannot serve`).toMatch(WAITING)
          await Bun.sleep(BOOTING_MS / 2)
          proxy.up()
          unavailableUntil = 0
        }
        await until(screen, (text) => shows.test(text), (last) => `${name}: the TUI never showed ${shows}:\n${last}`, SHOWS_WITHIN[mode])
        await host.stop()
        unavailableUntil = 0
        expect(frames.filter((frame) => GAVE_UP.test(frame)), `${name}: a failure in any frame`).toEqual([])
        expect(badFrames, `${name}: error toast while the service could not serve`).toEqual([])
      }
      const cases: ReadonlyArray<Open> = [
        { name: "open-down", args: ["-s", target.id], mode: "down" },
        { name: "continue-down", args: ["--continue"], mode: "down" },
        { name: "open-booting", args: ["-s", target.id], mode: "booting" },
        { name: "continue-booting", args: ["--continue"], mode: "booting" },
        // Nothing to continue: home, not a blank session screen.
        { name: "continue-empty", args: ["--continue"], mode: "ready", cwd: empty, shows: HOME },
      ]
      // Every case runs, so one red names all that fail.
      const failures: string[] = []
      for (const each of cases)
        await open(each)
          .catch((error: unknown) => failures.push(String(error).replace(/\n\s*\n+/g, "\n").slice(0, 1_500)))
          .finally(() => {
            proxy.up()
            unavailableUntil = 0
          })
      expect(failures).toEqual([])
    }),
    TIMEOUT_MS,
  )

  test(
    "a TUI opened on the background service while it is stopped or restarting opens its session",
    kept.test(async () => {
      refused.clear()
      unavailableUntil = 0
      proxy.up()
      const target = await client.session.create({ location: { directory: work }, title: "Reconnect managed" })
      await client.session.prompt({ sessionID: target.id, text: "say managed-transcript-marker" })
      await client.experimental.session.wait({ sessionID: target.id })
      const open = async (name: string, before: () => Promise<unknown>) => {
        const pending = before()
        const socket = join(root, `${name}.sock`)
        const frames: string[] = []
        const badFrames: string[] = []
        // No --server: the TUI finds the service the way the owner's panes do, by its registration.
        const host = serve({ socket, cwd: home, command: [...tui, "-s", target.id] as [string, ...string[]], env: { ...env, ...(binary ? { BUN_OPTIONS: "" } : {}) }, cols: 120, rows: 40 }, (rows) => {
          const frame = rows.join("\n")
          if (frames.at(-1) !== frame) frames.push(frame)
          const toast = errorToast(rows)
          if (toast && badFrames.length === 0) badFrames.push(toast)
        })
        hosts.push(host)
        await until(() => existsSync(socket), Boolean, () => `${name}: the terminal host`, 10_000)
        const screen = async () => (await hostCall(socket, { op: "read", scope: "screen" })).rows.join("\n")
        await until(screen, (text) => text.includes("managed-transcript-marker"), (last) => `${name}: the TUI never opened its session:\n${last}`, 60_000)
        await pending
        await host.stop()
        expect(frames.filter((frame) => /Could not reach|Unable to connect|did not provide|UnexpectedStatus|cli process failed/.test(frame)), `${name}: a failure in any frame`).toEqual([])
        expect(badFrames, `${name}: error toast while the service could not serve`).toEqual([])
        return frames
      }
      // Stopped: the TUI starts the service and says so.
      expect(await opencode("service", "stop")).toMatchObject({ code: 0 })
      const stopped = await open("managed-stopped", async () => undefined)
      expect(stopped.some((frame) => /Starting background server|Waiting for the OpenCode server/.test(frame)), "managed-stopped: no line while the service started").toBe(true)
      service = await ready(serviceFile, () => "the service the TUI started")
      // Restarting: opened while `service restart` stops the service and starts the next one.
      await open("managed-restarting", async () => expect(await opencode("service", "restart")).toMatchObject({ code: 0 }))
      service = await ready(serviceFile, () => "the restarted service")
    }),
    TIMEOUT_MS,
  )

  test.each(["cached", "uncached", "down"])(
    "selecting a %s session from home during service boot and submitting waits without an error toast",
    (cache) => kept.test(async () => {
      // Release any targeted refusal or downtime left by a failed preceding case.
      refused.clear()
      unavailableUntil = 0
      proxy.up()
      // A second pane sits at home with its session picker already populated.
      // Select from that cached list while *every* HTTP request returns the
      // same 503 as the service's actual plugin-loading readiness window.
      const socket = join(root, `open-booting-${cache}.sock`)
      const badFrames: string[] = []
      const host = serve({ socket, cwd: work, command: [...tui, "--server", proxy.url, ...(cache !== "uncached" ? ["-s", parent.id] : [])] as [string, ...string[]], env: { ...env, ...(binary ? { BUN_OPTIONS: "" } : {}), OPENCODE_PASSWORD: service.password }, cols: 120, rows: 40 }, (rows) => {
        const toast = errorToast(rows)
        if (toast && badFrames.length === 0) badFrames.push(toast)
      })
      hosts.push(host)
      const screen = async () => {
        const rows = (await hostCall(socket, { op: "read", scope: "screen" })).rows
        expect(badFrames, "error toast opening/submitting during boot").toEqual([])
        return rows.join("\n")
      }
      // Visit first so a returning home pane has cached session metadata and
      // its composer can accept input before the boot-time reload completes.
      if (cache !== "uncached") {
        await until(screen, (text) => text.includes("Reconnect parent") && text.includes("sim-model"), (last) => `session did not load before going home:\n${last}`, START_MS)
        await chord(socket, screen, "n", HOME, "home")
      }
      await until(screen, (text) => HOME.test(text), (last) => `home did not load:\n${last}`, 20_000)
      await chord(socket, screen, "l", /\bSessions\b/, "session picker")
      if (/all projects\s+ctrl\+a/.test(await screen())) await hostCall(socket, { op: "keys", names: ["ctrl+a"] })
      await until(screen, (text) => text.includes("Reconnect parent"), (last) => `session picker has no parent row:\n${last}`, 20_000)
      await hostCall(socket, { op: "type", text: "Reconnect parent" })
      await until(screen, (text) => text.split("Reconnect parent").length >= 3, (last) => `filtered session picker has no parent row:\n${last}`, 20_000)
      // The service boots (503 to every request) until the TUI has made its selection, and submitted from the cached composer.
      unavailableUntil = Number.POSITIVE_INFINITY
      expect(await opencode("service", "restart")).toMatchObject({ code: 0 })
      await ready(serviceFile, () => "service behind booting proxy")
      const beforeRefusals = refusedRequests.length
      // Down: nothing listens when the selection is made; the service comes back after a while, still booting.
      if (cache === "down") proxy.down()
      await hostCall(socket, { op: "keys", names: ["enter"] })
      await until(screen, (text) => /Connection lost|Reconnecting to the server/.test(text) || (!/\bSessions\b/.test(text) && /sim-model/.test(text)), (last) => `selection did not leave the picker or wait for reconnection:\n${last}`, BACK_WITHIN_MS)
      const marker = `opened-during-boot-${cache}-marker`
      const submit = async () => {
        await hostCall(socket, { op: "type", text: `say ${marker}` })
        await hostCall(socket, { op: "keys", names: ["enter"] })
      }
      if (cache !== "uncached") await submit()
      const servesAt = Date.now() + BOOTING_MS
      unavailableUntil = servesAt
      setTimeout(proxy.up, BOOTING_MS / 2)
      await until(() => Date.now(), (now) => now >= servesAt, () => "the booting window", BOOTING_MS + 1_000)
      if (cache === "uncached") {
        await until(screen, (text) => text.includes("Reconnect parent") && text.includes("sim-model") && !/\bSessions\b|Connection lost|Reconnecting to the server/.test(text), (last) => `uncached selection did not wait for its session:\n${last}`, BACK_WITHIN_MS)
        await submit()
      }
      // Earlier transcript text can scroll off screen as turns accumulate.
      // The stable header and the session-specific admission prove identity.
      await until(screen, (text) => text.includes(marker) && text.includes("Reconnect parent"), (last) => `opening/submitting during boot did not recover:\n${last}`, BACK_WITHIN_MS)
      await until(async () => ({ requests: submissions, screen: await screen() }), ({ requests }) => requests.some((request) => request.path === `/api/session/${parent.id}/prompt` && request.body.includes(marker)), (last) => `the boot-time prompt never reached ${parent.id}:\n${JSON.stringify(last.requests)}\n${last.screen}`, BACK_WITHIN_MS)
      await until(() => modelPrompts, (prompts) => prompts.some((prompt) => prompt.includes(marker)), () => "the session never sent the boot-time prompt to its model", BACK_WITHIN_MS)
      expect(refusedRequests.slice(beforeRefusals).length, "selection really crossed the 503 window").toBeGreaterThan(0)
      await host.stop()
      expect(badFrames, "error toast opening/submitting during boot").toEqual([])
    })(),
    TIMEOUT_MS,
  )
})
