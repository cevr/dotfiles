// accept: one at a time (it bounds a retry time against the clock).
// The fleet across two real OpenCode servers on this machine, standing in for
// the Mac and the workbox. Each is the fork's own `serve --service`, in its
// own scratch HOME, publishing its service file as the live one does.
//
// Host A runs orchestrate and the pool; its root session admits a wave of two
// subagents on the scripted model. Host B runs the pool on two login store Claude
// accounts read from the fake Anthropic usage endpoint, with A as a peer (read
// by the real report.ts on stdin, against A's real service file, where SSH
// would run it on the other host) and a third peer that cannot be reached.
// B's pace must hold a new agent for A's wave, before any reading shows it,
// name the unreachable peer, and carry no token across.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { anthropicAuthPlugin, poolPlugin } from "../testbeds/anthropic-auth.ts"
import { ROOT } from "../scripts/agents.ts"
import { fleetRows, type PaneFleet } from "../mods/status/pane.ts"
import { fakeAccount, startFakeAnthropic } from "./fake-anthropic.ts"
import { openSlotStore } from "./store/store.ts"
import { ROOT_TASK, serve } from "./orchestrate/sim.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
const ready = Boolean(fork)
if (!ready) {
  console.warn("tests/pool-fleet.test.ts: skipped. Set OPENCODE_DEV to the fork.")
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const TIMEOUT_MS = 150_000

interface Service {
  readonly url: string
  readonly password: string
}

interface Host {
  readonly base: string
  readonly service: Service
  readonly serviceFile: string
  readonly stderr: () => string
  readonly stop: () => Promise<void>
}

/** As much of the fork's client as the test uses; the fork is found at run time, so it is typed here. */
interface SessionInfo {
  readonly id: string
}
interface Client {
  readonly session: {
    readonly create: (input: { location: { directory: string } }) => Promise<SessionInfo>
    readonly list: (input: { parentID: string; directory: string }) => Promise<{ data: ReadonlyArray<SessionInfo> }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
}
interface ClientModule {
  readonly OpenCode: { readonly make: (options: { baseUrl: string; headers: Record<string, string> }) => Client }
}

const authorization = (service: Service) => `Basic ${btoa(`opencode:${service.password}`)}`

/** One of the pool's RPC methods on a host, as report.ts and the pane ask it. */
const rpc = async (host: Host, method: string, input: unknown = {}): Promise<unknown> => {
  const response = await fetch(new URL(`/api/rpc/dotfiles-opencode.pool/${method}`, host.service.url), {
    method: "POST",
    headers: { authorization: authorization(host.service), "content-type": "application/json" },
    body: JSON.stringify({ input }),
  })
  const body = (await response.json()) as { output?: unknown }
  return body.output
}

const until = async <A>(read: () => Promise<A>, done: (value: A) => boolean, label: () => string, ms = 60_000): Promise<A> => {
  const deadline = Date.now() + ms
  let last = await read()
  while (!done(last)) {
    if (Date.now() > deadline) return expect.unreachable(`${label()}: still ${JSON.stringify(last)}`)
    await Bun.sleep(250)
    last = await read()
  }
  return last
}

describe.skipIf(!ready)("the fleet across two real OpenCode servers (real report.ts, fake Anthropic, scripted model)", () => {
  const kept = keptScratch(ready, "pool-fleet-", true)
  const root = kept.path
  const hosts: Array<Host> = []
  afterAll(async () => {
    await Promise.all(hosts.map((host) => host.stop()))
    kept.done()
  })

  /** Start the fork's service in a scratch HOME with `config` as its global config, and wait for its service file. */
  const start = async (name: string, config: unknown, extra: Record<string, string> = {}): Promise<Host> => {
    const base = kept.dir(`${name}-`)
    const home = join(base, "home")
    for (const dir of ["work", "home", "home/.config", "home/.config/opencode", "home/.local", "home/.local/state"]) mkdirSync(join(base, dir))
    writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify(config))
    const launch = forkLaunch(fork ?? "", process.execPath)
    const child = owned([...launch.base, "serve", "--service", "--port", "0"], {
      cwd: join(base, "work"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        OPENCODE_DB: join(base, "opencode.db"),
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        ...launch.env,
        ...extra,
      },
      stdout: "ignore",
      stderr: "pipe",
    })
    let stderr = ""
    void (async () => {
      for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk)
    })()
    // A build from source is the "local" channel: its service file is service-local.json (an installed one writes service.json).
    const serviceFile = join(home, ".local/state/opencode/service-local.json")
    const service = await until(
      async () => {
        try {
          return JSON.parse(readFileSync(serviceFile, "utf8")) as Service
        } catch {
          return undefined
        }
      },
      (value) => value !== undefined && typeof value.url === "string" && typeof value.password === "string",
      () => `${name}'s service file (${stderr.slice(-500)})`,
    )
    const host: Host = {
      base,
      service: service ?? { url: "", password: "" },
      serviceFile,
      stderr: () => stderr,
      stop: async () => {
        child.kill()
        await child.exited
      },
    }
    hosts.push(host)
    // The pool answers once its plugin is up.
    await until(
      () => rpc(host, "fleet").catch(() => undefined),
      (value) => typeof value === "object" && value !== null && "host" in value,
      () => `${name}'s pool (${stderr.slice(-500)})`,
    )
    return host
  }

  test(
    "a wave admitted on one host holds the other's pace before any reading shows it, and a down peer is named",
    kept.test(async () => {
      const sim = serve()
      const now = Date.now()
      // Two accounts at half a week's use with half the week left: within the pace on their own.
      const sevenDay = { utilization: 0.5, resetAt: now + 3.5 * DAY }
      const accounts = { alpha: fakeAccount(), beta: fakeAccount() }
      const fake = startFakeAnthropic({
        accounts,
        quota: () => ({ fiveHour: { utilization: 0.1, resetAt: now + 2 * HOUR }, sevenDay }),
        script: () => ({ kind: "ok", text: "unused" }),
      })
      try {
        const store = kept.dir("store-auth-")
        const logins = openSlotStore(store)
        await logins.signIn("alpha", { ...accounts.alpha, expires: now + 8 * HOUR })
        await logins.signIn("beta", { ...accounts.beta, expires: now + 8 * HOUR })

        const a = await start("host-a", {
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
          plugins: [
            {
              package: join(ROOT, "cmd/orchestrate"),
              options: { log: join(root, "agents.jsonl"), now: "2026-11-04T15:00:00Z", codex: false },
            },
            { package: poolPlugin, options: { sweepMinutes: 0, fleet: { host: "host-a" } } },
          ],
        })

        // Host A admits a wave: the root's task starts two subagents.
        const { OpenCode } = (await import(join(fork ?? "", "packages/client/src/promise/index.ts"))) as ClientModule
        const client = OpenCode.make({ baseUrl: a.service.url, headers: { authorization: authorization(a.service) } })
        const location = { directory: join(a.base, "work") }
        const session = await client.session.create({ location })
        await client.session.prompt({ sessionID: session.id, text: ROOT_TASK })
        await client.experimental.session.wait({ sessionID: session.id })
        const children = await client.session.list({ parentID: session.id, directory: location.directory })
        expect(children.data).toHaveLength(2)
        // The subagents started in the work directory's instance of the plugin; the
        // home instance, which a peer's report.ts asks, counts them too.
        expect(await rpc(a, "fleet")).toMatchObject({ host: "host-a", starts: 2, peers: [] })

        const b = await start(
          "host-b",
          {
            plugins: [
              anthropicAuthPlugin,
              {
                package: poolPlugin,
                options: {
                  sweepMinutes: 1,
                  sources: [{ kind: "store", dir: store, tokenURL: `${fake.url}/v1/oauth/token` }],
                  // A's scripted provider spends the same accounts as B's Claude agents.
                  paced: { sim: "anthropic" },
                  fleet: {
                    host: "host-b",
                    pollSeconds: 1,
                    startCost: 0.05,
                    peers: [
                      {
                        name: "host-a",
                        ssh: "host-a.invalid",
                        // What SSH runs on the other host: report.ts on stdin, against that host's service file.
                        command: ["env", `OPENCODE_SERVICE_FILE=${a.serviceFile}`, process.execPath, "run", "-"],
                      },
                      {
                        name: "host-c",
                        ssh: "host-c.invalid",
                        command: [process.execPath, "-e", "console.error('ssh: connect to host host-c.invalid port 22: Connection refused'); process.exit(255)"],
                      },
                    ],
                  },
                },
              },
            ],
          },
          { ANTHROPIC_BASE_URL: fake.url },
        )

        const fleet = (await until(
          () => rpc(b, "fleet"),
          (value) => {
            const peers = (value as PaneFleet | undefined)?.peers ?? []
            return peers.some((peer) => peer.name === "host-a" && peer.starts === 2) && peers.some((peer) => peer.missed !== undefined)
          },
          () => "B's fleet",
        )) as PaneFleet
        expect(fleet).toMatchObject({
          host: "host-b",
          starts: 0,
          settleMinutes: 10,
          peers: [
            { name: "host-a", host: "host-a", starts: 2 },
            { name: "host-c", starts: 0, missed: { message: "ssh: connect to host host-c.invalid port 22: Connection refused" } },
          ],
        })
        const rows = fleetRows(fleet)
        expect(rows.map((row) => row.down)).toEqual([false, false, true])
        expect(rows[0]?.text).toBe("host-b (this host) · 0 new agents counting for 10 min")
        expect(rows[2]?.text).toContain("host-c · unreachable since ")
        expect(rows[2]?.text).toContain("Connection refused; the pace goes on without it")

        // The readings say B is within its pace; A's two starts at 5% each put it over.
        const pace = (await until(
          () => rpc(b, "pace", { providerID: "anthropic" }),
          (value) => typeof value === "object" && value !== null && "measured" in value && value.measured === true,
          () => "B's pace",
        )) as { ok: boolean; reason: string; retryAt?: number }
        expect(pace.ok).toBe(false)
        expect(pace.reason).toBe(
          "the pool's weekly pace is over (100.0% spent across 2 accounts, +10.0% for 2 agents started in the last 10 min)",
        )
        expect(pace.retryAt).toBeGreaterThan(Date.now())
        expect(pace.retryAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1)

        // A's report carried its starts and no token; nothing B shows or logs has one either.
        const report = JSON.stringify(await rpc(a, "report"))
        const shown = JSON.stringify(fleet) + JSON.stringify(pace) + JSON.stringify(await rpc(b, "status")) + b.stderr() + a.stderr()
        for (const account of Object.values(accounts)) {
          for (const token of [account.access, account.refresh]) {
            expect(report).not.toContain(token)
            expect(shown).not.toContain(token)
          }
        }
        expect(report).not.toContain(a.service.password)
        expect(shown).not.toContain(a.service.password)
      } finally {
        await fake.stop()
        sim.server.stop(true)
      }
    }),
    TIMEOUT_MS,
  )
})
