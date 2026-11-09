// A TUI attached to the background service keeps its session across a
// service restart. The owner's TUIs are `opencode -s <id>` on the service
// `daily` restarts on every install; the TUI reconnects by itself and must
// come back to the session it showed, not OpenCode's home page.
//
// The fork runs from source in a scratch HOME on a scripted model: the
// service starts and restarts through the CLI as daily does (`service start`,
// `service restart`), the TUI runs on a real pty (gamut's terminal host), and
// the test reads its screen. Each case is a root, a subagent, a root whose
// turn the restart cuts, and a worker whose Rift is gone; after the restart
// the TUI shows the same session and follows a turn sent on the new service.
//
// Green on prime-look d22f11a95e: the owner's report (a TUI back on the home
// page after an install's restart) is not reproduced here yet, neither with an
// old-version TUI on a new-version service, a service down 8 s, tabs off
// (HERDR_ENV) nor the TUI started outside the session's directory.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve, type ServedHost } from "../testbeds/gamut/pty-host.ts"
import { ready, type Service } from "./service.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/reconnect-session.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = join(import.meta.dir, "..")
const TUI_PLUGINS = ["prime", "status", "git", "cache", "questions", "btw", "skills", "recover", "orchestrate", "escape"]
const TIMEOUT_MS = 180_000
const SERVER_PLUGINS = ["orchestrate", "guard", "kernel", "status", "queue", "git", "idle-compact", "questions", "skills", "rift", "tool-names", "cache", "web", "memory"]
/** How long the TUI has, after the restarted service can serve, to show its session again. */
const BACK_WITHIN_MS = 20_000

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

const sim = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await request.json()) as { readonly messages?: ReadonlyArray<ChatMessage> }
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

  /**
   * The fork's CLI in the scratch HOME, run to its end. Not `owned`: the
   * service `service start` and `service restart` leave running is the point;
   * `service stop` ends it, and accept's leak check stops it if that fails.
   */
  const opencode = async (...args: ReadonlyArray<string>) => {
    const child = Bun.spawn([...launch.base, ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe" })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, out, err }
  }

  afterAll(async () => {
    for (const host of hosts) await host.stop()
    if (existsSync(serviceFile)) await opencode("service", "stop")
    sim.stop(true)
    rmSync(root, { recursive: true, force: true })
  })

  const pid = (service: Service) => fetch(new URL("/api/info", service.url), { headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}` } }).then((response) => response.json() as Promise<{ pid?: number }>)

  test(
    "after `service restart` the TUI shows the session it showed, root or subagent, within seconds",
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
      const started = await opencode("service", "start")
      expect(started.code).toBe(0)
      const service = await ready(serviceFile, () => `the service (${started.err.slice(-500)})`)
      const { OpenCode } = (await import(join(fork ?? "", "packages/client/src/promise/index.ts"))) as ClientModule
      const client = OpenCode.make({ baseUrl: service.url, headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}` } })
      const parent = await client.session.create({ location: { directory: work }, title: "Reconnect parent" })
      await client.session.prompt({ sessionID: parent.id, text: "say parent-transcript-marker" })
      await client.experimental.session.wait({ sessionID: parent.id })
      const child = await client.session.create({ parentID: parent.id, title: "Reconnect child" })
      await client.session.prompt({ sessionID: child.id, text: "say child-transcript-marker" })
      await client.experimental.session.wait({ sessionID: child.id })

      const run = async (name: string, sessionID: string, marker: string, busy = false, gone?: string) => {
        const socket = join(root, `${name}.sock`)
        // A herdr pane's directory need not be the session's: the TUI starts in the HOME.
        const host = serve({ socket, cwd: home, command: [...launch.base, "-s", sessionID], env, cols: 120, rows: 40 })
        hosts.push(host)
        await until(() => existsSync(socket), Boolean, () => `${name}: the terminal host`, 10_000)
        const screen = async () => (await hostCall(socket, { op: "read", scope: "screen" }).catch(() => ({ rows: [] as ReadonlyArray<string> }))).rows.join("\n")
        const showing = (text: string) => text.includes(marker)
        await until(screen, showing, (last) => `${name}: the TUI never showed ${marker}:\n${last}`, 60_000)
        if (busy) {
          await client.session.prompt({ sessionID, text: "hold" })
          await until(screen, (text) => text.includes("holding"), (last) => `${name}: the turn never started:\n${last}`, 30_000)
        }
        if (gone !== undefined) rmSync(gone, { recursive: true, force: true })

        const before = await pid(await ready(serviceFile, () => "the service"))
        const restarted = await opencode("service", "restart")
        expect(restarted.code).toBe(0)
        const after = await ready(serviceFile, () => `the restarted service (${restarted.err.slice(-500)})`)
        // A new service process, not the old one answering.
        expect((await pid(after)).pid).not.toBe(before.pid)
        await until(screen, showing, (last) => `${name}: ${BACK_WITHIN_MS / 1000}s after the restart the TUI does not show ${marker}:\n${last}`, BACK_WITHIN_MS)
        // And it is live on the new service: a turn sent there shows up, so the screen is not a stale frame.
        const live = OpenCode.make({ baseUrl: after.url, headers: { authorization: `Basic ${btoa(`opencode:${after.password}`)}` } })
        if (gone !== undefined) {
          // Nothing can run there now; the session stays on screen, and stays.
          await Bun.sleep(5_000)
          expect(showing(await screen())).toBe(true)
          await host.stop()
          return
        }
        if (busy) await live.session.interrupt({ sessionID }).catch(() => undefined)
        await live.session.prompt({ sessionID, text: `say ${name}-after-restart` })
        await until(screen, (text) => text.includes(`${name}-after-restart`) && showing(text), (last) => `${name}: the TUI does not follow the session on the new service:\n${last}`, BACK_WITHIN_MS)
        await host.stop()
      }

      await run("root", parent.id, "parent-transcript-marker")
      await run("child", child.id, "child-transcript-marker")
      await run("busy", parent.id, "parent-transcript-marker", true)
      // A worker's session in a Rift the run has since removed.
      const rift = join(root, "rift")
      mkdirSync(rift, { recursive: true })
      const worker = await client.session.create({ location: { directory: rift }, title: "Reconnect worker" })
      await client.session.prompt({ sessionID: worker.id, text: "say worker-transcript-marker" })
      await client.experimental.session.wait({ sessionID: worker.id })
      await run("gone", worker.id, "worker-transcript-marker", false, rift)
    },
    TIMEOUT_MS,
  )
})
