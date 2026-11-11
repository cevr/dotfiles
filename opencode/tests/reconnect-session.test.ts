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
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve, type ServedHost } from "../testbeds/gamut/pty-host.ts"
import { freePort, ready, type Service } from "./service.ts"

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

describe.skipIf(!fork)("a TUI on the background service across a service restart", () => {
  const root = mkdtempSync(join(tmpdir(), "reconnect-session-"))
  const home = join(root, "home")
  const work = join(root, "work")
  const launch = forkLaunch(fork ?? "", process.execPath)
  // Run an installed old TUI without replacing its binary or the owner's
  // service. The scratch service and typed fixture client stay on OPENCODE_DEV.
  const binary = process.env.OPENCODE_RECONNECT_TUI_BINARY
  const scratchBinary = join(root, "opencode-old")
  if (binary) cpSync(binary, scratchBinary)
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
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * A stand-in for a service still booting: it passes every request to the
   * service the service file names now, except a GET of a refused session,
   * which it answers 503 `service_starting` until its time.
   */
  const refused = new Map<string, number>()
  let unavailableUntil = 0
  const refusedRequests: string[] = []
  const proxyServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const sessionID = /^\/api\/session\/([^/]+)$/.exec(url.pathname)?.[1]
      if (Date.now() < unavailableUntil || (request.method === "GET" && sessionID !== undefined && Date.now() < (refused.get(sessionID) ?? 0))) {
        refusedRequests.push(`${request.method} ${url.pathname}`)
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
    },
  })
  const proxy = { url: proxyServer.url.toString().replace(/\/$/, ""), refuse: (sessionID: string, until: number) => refused.set(sessionID, until) }

  const pid = (service: Service) => fetch(new URL("/api/info", service.url), { headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}` } }).then((response) => response.json() as Promise<{ pid?: number }>)

  let service: Service
  let OpenCode: ClientModule["OpenCode"]
  let client: Client
  let parent: { readonly id: string }
  let child: { readonly id: string }
  beforeAll(
    async () => {
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
    },
    60_000,
  )

  test(
    "after `service restart` the TUI keeps its root/subagent session without an error toast in any frame",
    async () => {
      type Case = { readonly busy?: boolean; readonly gone?: string; readonly booting?: boolean; readonly bootingAll?: boolean; readonly draft?: boolean; readonly starting?: boolean }
      const run = async (name: string, sessionID: string, marker: string, { busy = false, gone, booting = false, bootingAll = false, draft = false, starting = false }: Case = {}) => {
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
        if (starting) unavailableUntil = Date.now() + BOOTING_MS
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
        await until(screen, showing, (last) => `${name}: the TUI never showed ${marker}:\n${last}`, 60_000)
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
        // The new service still refuses the session for a while, as one still loading its plugins does.
        if (booting) proxy.refuse(sessionID, Date.now() + BOOTING_MS)
        // Or every request, its event stream and info too, as the service does until its routes are built.
        if (bootingAll) unavailableUntil = Date.now() + BOOTING_MS
        const after = await ready(serviceFile, () => `the restarted service (${restarted.err.slice(-500)})`)
        // A new service process, not the old one answering.
        expect((await pid(after)).pid).not.toBe(before.pid)
        await until(screen, showing, (last) => `${name}: ${BACK_WITHIN_MS / 1000}s after the restart the TUI does not show ${marker}:\n${last}`, BACK_WITHIN_MS)
        // Back on the session with the draft still in the composer, once the service serves again.
        if (draft) {
          await until(() => Date.now(), (now) => now >= unavailableUntil, () => "the booting window", BOOTING_MS + 1_000)
          await until(screen, (text) => text.includes(draftText) && showing(text), (last) => `${name}: the draft is gone after the restart:\n${last}`, BACK_WITHIN_MS)
        }
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
        expect(frames.filter((frame) => /Fix a TODO in the codebase|What is the tech stack of this project\?|Fix broken tests/.test(frame)), `${name}: went home during restart`).toEqual([])
        expect(badFrames, `${name}: error toast during restart`).toEqual([])
      }

      await run("root", parent.id, "parent-transcript-marker")
      await run("child", child.id, "child-transcript-marker")
      await run("busy", parent.id, "parent-transcript-marker", { busy: true })
      await run("booting", parent.id, "parent-transcript-marker", { booting: true })
      // The owner's panes: a draft in the composer, and a service that refuses everything while it boots.
      // A session of their own, so the parent's growing transcript does not scroll the marker away.
      const drafted = await client.session.create({ location: { directory: work }, title: "Reconnect draft" })
      await client.session.prompt({ sessionID: drafted.id, text: "say draft-transcript-marker" })
      await client.experimental.session.wait({ sessionID: drafted.id })
      await run("draft", drafted.id, "draft-transcript-marker", { draft: true, starting: true })
      await run("booting-all", drafted.id, "draft-transcript-marker", { bootingAll: true, draft: true })
      unavailableUntil = 0

      // A worker's session in a Rift the run has since removed.
      const rift = join(root, "rift")
      mkdirSync(rift, { recursive: true })
      const worker = await client.session.create({ location: { directory: rift }, title: "Reconnect worker" })
      await client.session.prompt({ sessionID: worker.id, text: "say worker-transcript-marker" })
      await client.experimental.session.wait({ sessionID: worker.id })
      await run("gone", worker.id, "worker-transcript-marker", { gone: rift })
    },
    TIMEOUT_MS,
  )

  test.each(["cached", "uncached"])(
    "selecting a %s session from home during service boot and submitting waits without an error toast",
    async (cache) => {
      // Release any targeted refusal left by a failed preceding case.
      refused.clear()
      unavailableUntil = 0
      // A second pane sits at home with its session picker already populated.
      // Select from that cached list while *every* HTTP request returns the
      // same 503 as the service's actual plugin-loading readiness window.
      const socket = join(root, `open-booting-${cache}.sock`)
      const badFrames: string[] = []
      const host = serve({ socket, cwd: work, command: [...tui, "--server", proxy.url, ...(cache === "cached" ? ["-s", parent.id] : [])] as [string, ...string[]], env: { ...env, ...(binary ? { BUN_OPTIONS: "" } : {}), OPENCODE_PASSWORD: service.password }, cols: 120, rows: 40 }, (rows) => {
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
      if (cache === "cached") {
        await until(screen, (text) => text.includes("Reconnect parent") && text.includes("sim-model"), (last) => `session did not load before going home:\n${last}`, 60_000)
        await hostCall(socket, { op: "keys", names: ["ctrl+x"] })
        await hostCall(socket, { op: "type", text: "n" })
      }
      await until(screen, (text) => /Fix a TODO in the codebase|What is the tech stack of this project\?|Fix broken tests/.test(text), (last) => `home did not load:\n${last}`, 20_000)
      await hostCall(socket, { op: "keys", names: ["ctrl+x"] })
      await hostCall(socket, { op: "type", text: "l" })
      await until(screen, (text) => /\bSessions\b/.test(text), (last) => `session picker did not open:\n${last}`, 20_000)
      if (/all projects\s+ctrl\+a/.test(await screen())) await hostCall(socket, { op: "keys", names: ["ctrl+a"] })
      await until(screen, (text) => text.includes("Reconnect parent"), (last) => `session picker has no parent row:\n${last}`, 20_000)
      await hostCall(socket, { op: "type", text: "Reconnect parent" })
      await until(screen, (text) => text.split("Reconnect parent").length >= 3, (last) => `filtered session picker has no parent row:\n${last}`, 20_000)
      unavailableUntil = Number.POSITIVE_INFINITY
      expect(await opencode("service", "restart")).toMatchObject({ code: 0 })
      await ready(serviceFile, () => "service behind booting proxy")
      unavailableUntil = Date.now() + BOOTING_MS
      const beforeRefusals = refusedRequests.length
      expect(Date.now(), "selection happens while the service still answers 503").toBeLessThan(unavailableUntil)
      await hostCall(socket, { op: "keys", names: ["enter"] })
      await until(screen, (text) => /Connection lost|Reconnecting to the server/.test(text) || (!/\bSessions\b/.test(text) && /sim-model/.test(text)), (last) => `selection did not leave the picker or wait for reconnection:\n${last}`, 5_000)
      if (cache === "cached") expect(Date.now(), "cached composer accepts input while the service still answers 503").toBeLessThan(unavailableUntil)
      else await until(screen, (text) => text.includes("Reconnect parent") && text.includes("sim-model") && !/\bSessions\b|Connection lost|Reconnecting to the server/.test(text), (last) => `uncached selection did not wait for its session:\n${last}`, BACK_WITHIN_MS)
      const marker = `opened-during-boot-${cache}-marker`
      await hostCall(socket, { op: "type", text: `say ${marker}` })
      await hostCall(socket, { op: "keys", names: ["enter"] })
      // Earlier transcript text can scroll off screen as turns accumulate.
      // The stable header and the session-specific admission prove identity.
      await until(screen, (text) => text.includes(marker) && text.includes("Reconnect parent"), (last) => `opening/submitting during boot did not recover:\n${last}`, BACK_WITHIN_MS)
      await until(async () => ({ requests: submissions, screen: await screen() }), ({ requests }) => requests.some((request) => request.path === `/api/session/${parent.id}/prompt` && request.body.includes(marker)), (last) => `the boot-time prompt never reached ${parent.id}:\n${JSON.stringify(last.requests)}\n${last.screen}`, BACK_WITHIN_MS)
      await until(() => modelPrompts, (prompts) => prompts.some((prompt) => prompt.includes(marker)), () => "the session never sent the boot-time prompt to its model", BACK_WITHIN_MS)
      expect(refusedRequests.slice(beforeRefusals).length, "selection really crossed the 503 window").toBeGreaterThan(0)
      await host.stop()
      expect(badFrames, "error toast opening/submitting during boot").toEqual([])
    },
    90_000,
  )
})
