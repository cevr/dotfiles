// accept: deep (boots real OpenCode and a TUI on a pty, as tests/update-badge.test.ts does)
// The TUI says when its service is not ready for a prompt.
//
// The owner (2026-11-17, workbox): after an update's restart the TUI could not send a message for minutes and
// showed nothing. The service answered 503 while it started (`service_starting`), then each location's providers
// and models answered 503 until its plugins were active ("Location plugins did not finish activating"), ~3.5 min
// there; a prompt sent meanwhile waited on the server with nothing on screen. Prime now draws
// `server starting · 42s · a prompt sent now waits for it`, then `plugins starting · …`, on the line above the
// composer (mods/prime/starting.ts, opencode/build.ts) from the moment the TUI's event stream connects again.
//
// The fork runs from source in a scratch HOME, the TUI on a real pty through a proxy that plays the restart: while
// `starting` it answers `/api/info` and the event stream as a starting service does; while `activating` it answers
// the location's providers with the server's own 503 and holds a prompt's POST, as the service holds one until the
// location's plugins are active.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve, type ServedHost } from "../testbeds/gamut/pty-host.ts"
import { freePort, ready, type Service } from "./service.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/starting-notice.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = join(import.meta.dir, "..")
const TIMEOUT_MS = 180_000

interface ClientModule {
  readonly OpenCode: {
    readonly make: (options: { baseUrl: string; headers: Record<string, string> }) => {
      readonly session: { readonly create: (input: { location: { directory: string }; title: string }) => Promise<{ readonly id: string }> }
    }
  }
}

const starting = () => Response.json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })
/** The service's own answer while a location's plugins activate (packages/server/src/location.ts). */
const activating = () => Response.json({ _tag: "ServiceUnavailableError", message: "Location plugins did not finish activating" }, { status: 503 })

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

describe.skipIf(!fork)("the starting notice", () => {
  const kept = keptScratch(Boolean(fork), "starting-notice-", true)
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

  const opencode = async (...args: ReadonlyArray<string>) => {
    const child = Bun.spawn([...launch.base, ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe" })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, out, err }
  }

  // The restart as the proxy plays it; `held` are the prompts it keeps until the plugins are active.
  let phase: "ready" | "starting" | "activating" = "ready"
  const held: Array<() => void> = []
  let prompts = 0
  const streams = new Set<AbortController>()
  const proxyServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const event = url.pathname === "/api/event"
      if (phase === "starting" && (event || url.pathname === "/api/info")) return starting()
      if (phase === "activating" && (url.pathname === "/api/provider" || url.pathname === "/api/model")) return activating()
      if (request.method === "POST" && /^\/api\/session\/[^/]+\/(message|prompt)/.test(url.pathname)) {
        prompts++
        if (phase !== "ready") await new Promise<void>((resolve) => held.push(resolve))
      }
      const target = await ready(serviceFile, () => "the service behind the proxy")
      const headers = new Headers(request.headers)
      headers.delete("host")
      const abort = new AbortController()
      request.signal.addEventListener("abort", () => abort.abort(), { once: true })
      if (event) streams.add(abort)
      const upstream = await fetch(new URL(url.pathname + url.search, target.url), {
        method: request.method,
        headers,
        body: request.body,
        signal: abort.signal,
        redirect: "manual",
      }).catch(starting)
      const back = new Headers(upstream.headers)
      back.delete("content-encoding")
      back.delete("content-length")
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
  const proxyURL = proxyServer.url.toString().replace(/\/$/, "")
  /** A restart as the TUI sees it: every event stream ends, and the service starts. */
  const restart = () => {
    phase = "starting"
    for (const stream of streams) stream.abort()
    streams.clear()
  }
  const settle = (next: typeof phase) => {
    phase = next
    if (next === "ready") for (const release of held.splice(0)) release()
  }

  afterAll(async () => {
    settle("ready")
    for (const host of hosts) await host.stop()
    if (existsSync(serviceFile)) await opencode("service", "stop")
    proxyServer.stop(true)
    kept.done()
  })

  const auth = (service: Service) => ({ authorization: `Basic ${btoa(`opencode:${service.password}`)}` })

  test(
    "after a restart, `plugins starting` shows while the location's plugins activate, a prompt sent then waits, and both clear once they are active",
    kept.test(async () => {
      for (const dir of [work, home, join(home, ".config"), join(home, ".config/opencode")]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify({}))
      writeFileSync(join(home, ".config/opencode/cli.json"), JSON.stringify({ plugins: [join(ROOT, "cmd", "prime")], session: { sidebar: "hide" }, theme: { name: "prime" } }))
      expect(await opencode("service", "set", "port", String(freePort()))).toMatchObject({ code: 0 })
      const started = await opencode("service", "start")
      expect(started).toMatchObject({ code: 0 })
      const service = await ready(serviceFile, () => `the service (${started.err.slice(-500)})`)
      const title = "Starting notice session"
      const { OpenCode } = (await import(join(fork ?? "", "packages/client/src/promise/index.ts"))) as ClientModule
      const session = await OpenCode.make({ baseUrl: service.url, headers: auth(service) }).session.create({ location: { directory: work }, title })

      const socket = join(root, "tui.sock")
      const host = serve({ socket, cwd: work, command: [...launch.base, "--server", proxyURL, "-s", session.id], env: { ...env, OPENCODE_PASSWORD: service.password }, cols: 140, rows: 40 })
      hosts.push(host)
      await until(() => existsSync(socket), Boolean, () => "the terminal host", 10_000)
      const screen = async () => (await hostCall(socket, { op: "read", scope: "screen" }).catch(() => ({ rows: [] as ReadonlyArray<string> }))).rows.join("\n")
      try {
        await until(screen, (text) => text.includes(title), (last) => `the TUI never showed the session:\n${last}`, 60_000)
        // A ready service: a reconnect draws nothing.
        await Bun.sleep(3_000)
        expect(await screen()).not.toContain("starting ·")

        // While the service starts its event stream is down, and the host itself says so over the session.
        restart()
        await until(screen, (text) => text.includes("Reconnecting to the server"), (last) => `the host never said it reconnects:\n${last}`, 30_000)

        // The stream is back, the location's plugins are not: nothing of the host's says so, the line does.
        settle("activating")
        const shown = await until(screen, (text) => /plugins starting · \d+s · a prompt sent now waits for it/.test(text), (last) => `no plugins starting line:\n${last}`, 30_000)
        expect(shown).not.toContain("Reconnecting to the server")
        // On the line above the composer's rail.
        const lines = shown.split("\n")
        const at = lines.findIndex((line) => line.includes("plugins starting ·"))
        expect(lines[at + 1]).toMatch(/^ ┃/)
        // The time ticks.
        const first = (await screen()).match(/plugins starting · (\d+)s/)?.[1]
        await Bun.sleep(2_500)
        expect(Number((await screen()).match(/plugins starting · (\d+)s/)?.[1])).toBeGreaterThan(Number(first))

        // A prompt sent now waits: the proxy holds it as the service would, and the line stays.
        await hostCall(socket, { op: "type", text: "sent while starting" })
        await hostCall(socket, { op: "keys", names: ["enter"] })
        await until(() => prompts, (count) => count > 0, () => "the prompt never reached the service", 15_000)
        expect(await screen()).toMatch(/plugins starting · \d+s/)

        settle("ready")
        const after = await until(screen, (text) => !text.includes("plugins starting") && text.includes("sent while starting"), (last) => `the line never cleared, or the prompt never showed:\n${last}`, 30_000)
        expect(after).not.toContain("server starting")
      } finally {
        await host.stop()
      }
    }),
    TIMEOUT_MS,
  )
})
