// The TUI says when it runs an older build than its service.
//
// The owner (2026-11-11): an install restarts the service onto the new build
// while a TUI already open keeps the one it started with (five workbox TUIs on
// prime.d22f11a9, the service on prime.cd6d8ecd), and nothing said so. Prime
// now draws `update available · restart to update` in the dock's model line
// (the home footer on the home screen) while the service's `/api/info`
// version differs from the TUI's own, reading it again on each reconnect.
//
// The fork runs from source in a scratch HOME, as tests/dock-reconnect.test.ts
// runs it: the service starts and restarts through the CLI, and the TUI runs
// on a real pty. Both are built from one checkout, so both say `local`; the
// TUI reaches the service through a proxy that, once `served` is set, answers
// `/api/info` with that version, as a service on a newer build would. A TUI
// on the service's own build shows nothing; after a restart onto a "newer"
// build the same TUI shows the notice without being restarted; a TUI started
// against the newer build shows it on the home screen at once.
//
// The owner, the same day: "Maybe when the upstream has updates as well."
// Daily writes how far upstream/dev is past the build it installs
// (`~/.local/state/opencode-daily/upstream.json`, scripts/upstream.ts
// `upstreamReading`); the test writes that file in the scratch HOME as daily
// would, and the corner adds `upstream +12 · merge blocked`, or nothing at 0.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { upstreamFile } from "../mods/prime/update.ts"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { hostCall, serve, type ServedHost } from "../testbeds/gamut/pty-host.ts"
import { freePort, ready, type Service } from "./service.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/update-badge.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = join(import.meta.dir, "..")
const TIMEOUT_MS = 180_000
const NOTICE = "update available · restart to update"
const NEWER = "9.9.9-prime.newbuild"
/** How long a TUI on the service's own build is watched for a notice it must not draw, once it has read `/api/info`. */
const QUIET_MS = 3_000

interface ClientModule {
  readonly OpenCode: {
    readonly make: (options: { baseUrl: string; headers: Record<string, string> }) => {
      readonly session: { readonly create: (input: { location: { directory: string }; title: string }) => Promise<{ readonly id: string }> }
    }
  }
}

const unavailable = () => Response.json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })

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

describe.skipIf(!fork)("the update notice", () => {
  const root = mkdtempSync(join(tmpdir(), "update-badge-"))
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
   * the service file names now, `/api/info` answering `served` as its version
   * once that is set (each such read counted in `infoReads`), and the event
   * stream answering 503 while `held`. `drop` ends every open event stream
   * and holds new ones, as a restart does.
   */
  let served: string | undefined
  let infoReads = 0
  let held = false
  const streams = new Set<AbortController>()
  const proxyServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const event = url.pathname === "/api/event"
      if (event && held) return unavailable()
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
      if (url.pathname === "/api/info" && upstream.ok) {
        infoReads++
        const info = (await upstream.json()) as Record<string, unknown>
        return Response.json(served === undefined ? info : { ...info, version: served })
      }
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
    proxyServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  })

  /** What `bun run daily` writes for the TUI's corner: `commits` of upstream/dev past the build, the merge `blocked` or not. */
  const writeUpstream = (commits: number, blocked: boolean) => {
    const file = upstreamFile(home)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ commits, blocked, upstream: "72616be4dbe772dc645640b5623cb3d6f4453bd3", build: "314c9607bf6ca4254f1a7b478a8d5deb15c3b910", at: new Date().toISOString() }))
  }

  const auth = (service: Service) => ({ authorization: `Basic ${btoa(`opencode:${service.password}`)}` })
  const info = (service: Service) =>
    fetch(new URL("/api/info", service.url), { headers: auth(service) }).then((response) => response.json() as Promise<{ pid?: number; version?: string }>)

  let booted: Promise<void> | undefined
  /** The service, started once for every case, with Prime as the TUI's look. */
  const boot = () =>
    (booted ??= (async () => {
      for (const dir of [work, join(home, ".config/opencode")]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify({}))
      writeFileSync(
        join(home, ".config/opencode/cli.json"),
        JSON.stringify({ plugins: [join(ROOT, "cmd", "prime")], session: { sidebar: "hide" }, theme: { name: "prime" } }),
      )
      // A port of its own: the other test files' scratch services would share the channel's fixed one (tests/service.ts).
      expect(await opencode("service", "set", "port", String(freePort()))).toMatchObject({ code: 0 })
      const started = await opencode("service", "start")
      expect(started).toMatchObject({ code: 0 })
      await ready(serviceFile, () => `the service (${started.err.slice(-500)})`)
    })())

  /** A TUI on the pty through the proxy, `args` added; its screen's rows as one string. */
  const tui = async (name: string, password: string, ...args: ReadonlyArray<string>) => {
    const socket = join(root, `${name}.sock`)
    const command = [...launch.base, "--server", proxyURL, ...args] as [string, ...string[]]
    const host = serve({ socket, cwd: work, command, env: { ...env, OPENCODE_PASSWORD: password }, cols: 140, rows: 40 })
    hosts.push(host)
    await until(() => existsSync(socket), Boolean, () => `${name}: the terminal host`, 10_000)
    const screen = async () => (await hostCall(socket, { op: "read", scope: "screen" }).catch(() => ({ rows: [] as ReadonlyArray<string> }))).rows.join("\n")
    return { host, screen }
  }

  test(
    "a TUI on its service's build shows nothing, and the notice once the service restarts onto a newer build",
    async () => {
      await boot()
      const service = await ready(serviceFile, () => "the service")
      const title = "Update badge session"
      const { OpenCode } = (await import(join(fork ?? "", "packages/client/src/promise/index.ts"))) as ClientModule
      const session = await OpenCode.make({ baseUrl: service.url, headers: auth(service) }).session.create({ location: { directory: work }, title })

      const { host, screen } = await tui("same", service.password, "-s", session.id)
      try {
        await until(screen, (text) => text.includes(title), (last) => `the TUI never showed the session:\n${last}`, 60_000)
        // The TUI has read the service's build, and it is its own, and upstream has nothing past it: no notice.
        await until(() => infoReads, (reads) => reads > 0, () => "the TUI never read /api/info", 30_000)
        await Bun.sleep(QUIET_MS)
        expect(await screen()).not.toContain("update available")
        expect(await screen()).not.toContain("upstream")

        // An install: daily counts upstream past the new build (its merge blocked), then the service restarts onto that build while the TUI stays open.
        drop()
        const before = await info(service)
        served = NEWER
        writeUpstream(12, true)
        const restarted = await opencode("service", "restart")
        expect(restarted).toMatchObject({ code: 0 })
        const after = await ready(serviceFile, () => `the restarted service (${restarted.err.slice(-500)})`)
        expect((await info(after)).pid).not.toBe(before.pid)
        held = false
        const full = `${NOTICE}  ·  upstream +12 · merge blocked`
        const shown = await until(screen, (text) => text.includes(full), (last) => `the notice never showed after the restart:\n${last}`, 30_000)
        // The dock's model line holds it, under the composer: one row, at its left end.
        const rows = shown.split("\n").filter((line) => line.includes(full))
        expect(rows).toHaveLength(1)
        expect(rows[0]?.trimStart().startsWith(NOTICE)).toBe(true)
        expect(shown).toContain(title)
      } finally {
        await host.stop()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "a TUI started against a newer service shows the notice on the home screen",
    async () => {
      await boot()
      const service = await ready(serviceFile, () => "the service")
      served = NEWER
      writeUpstream(0, false)
      const { host, screen } = await tui("home", service.password)
      try {
        const shown = await until(screen, (text) => text.includes(NOTICE), (last) => `the home screen never showed the notice:\n${last}`, 60_000)
        // Upstream has nothing past the build: no upstream part.
        expect(shown).not.toContain("upstream")
      } finally {
        await host.stop()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "a TUI on its service's build shows only how far upstream is ahead, once it is",
    async () => {
      await boot()
      const service = await ready(serviceFile, () => "the service")
      served = undefined
      writeUpstream(5, false)
      const { host, screen } = await tui("upstream", service.password)
      try {
        const shown = await until(screen, (text) => text.includes("upstream +5"), (last) => `the home screen never showed upstream:\n${last}`, 60_000)
        expect(shown).not.toContain("update available")
        expect(shown).not.toContain("merge blocked")
      } finally {
        await host.stop()
      }
    },
    TIMEOUT_MS,
  )
})
