// The OS job's run over a stand-in world: a service file, a server that
// answers or not, and an `opencode service start` that brings one up.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Descriptor } from "../backstop.ts"
import { type Answer, environmentOf, fire, type Reach, serviceFile } from "./fire.ts"

const descriptor: Descriptor = {
  id: "w00abcd",
  title: "opencode-wake-w00abcd",
  directory: "/work/my app",
  opencode: "/home/me/.local/bin/opencode",
  env: { HOME: "/home/me", XDG_STATE_HOME: "/state" },
}

const FILE = "/state/opencode/service.json"
const SERVICE = JSON.stringify({ url: "http://127.0.0.1:4096", pid: 1, password: "pw" })
const timing = { startMs: 20, callMs: 20, pollMs: 1 }

interface World {
  /** Whether the service file is there and the server answers. */
  running: boolean
  /** Whether `service start` brings it up. */
  starts: boolean
  /** How many due calls answer nothing before one answers (an instance still booting). */
  booting: number
  outcome: string
  readonly requests: Array<{ readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body?: string }>
  readonly execs: Array<{ readonly argv: ReadonlyArray<string>; readonly env: Record<string, string> }>
}

const world = (overrides: Partial<World> = {}): World => ({ running: true, starts: true, booting: 0, outcome: "fired", requests: [], execs: [], ...overrides })

const reachOf = (state: World): Reach => ({
  readText: (file) => Effect.sync(() => (file === FILE && state.running ? SERVICE : undefined)),
  request: (url, init) =>
    Effect.sync((): Answer | undefined => {
      state.requests.push({ url, ...init })
      if (!state.running) return undefined
      if (url.endsWith("/api/info")) return { status: 200, body: { version: "x" } }
      if (state.booting > 0) {
        state.booting -= 1
        return undefined
      }
      return { status: 200, body: { output: { outcome: state.outcome } } }
    }),
  exec: (argv, env) =>
    Effect.sync(() => {
      state.execs.push({ argv, env })
      if (state.starts) state.running = true
      return { exitCode: state.starts ? 0 : 1, output: state.starts ? "" : "launchctl: refused" }
    }),
})

describe("an OS job's run", () => {
  test("reaches the running service and asks the entry's server to fire it, starting nothing", async () => {
    const state = world()
    const report = await Effect.runPromise(fire(descriptor, reachOf(state), timing))
    expect(report).toEqual({ started: false, url: "http://127.0.0.1:4096", outcome: "fired" })
    expect(state.execs).toEqual([])
    const [probe, call] = state.requests
    expect(probe?.url).toBe("http://127.0.0.1:4096/api/info")
    expect(probe?.headers.authorization).toBe(`Basic ${btoa("opencode:pw")}`)
    expect(call?.method).toBe("POST")
    const url = new URL(call?.url ?? "")
    expect(url.pathname).toBe("/api/rpc/dotfiles-opencode.wake/due")
    expect(url.searchParams.get("location[directory]")).toBe("/work/my app")
    expect(call?.headers.authorization).toBe(`Basic ${btoa("opencode:pw")}`)
    expect(JSON.parse(call?.body ?? "")).toEqual({ input: { id: "w00abcd" } })
  })

  test("starts the service with the launcher by path when nothing answers, then calls", async () => {
    const state = world({ running: false })
    const report = await Effect.runPromise(fire(descriptor, reachOf(state), timing))
    expect(report).toEqual({ started: true, url: "http://127.0.0.1:4096", outcome: "fired" })
    expect(state.execs.map((run) => run.argv)).toEqual([["/home/me/.local/bin/opencode", "service", "start"]])
    const env = state.execs[0]?.env ?? {}
    expect(env.XDG_STATE_HOME).toBe("/state")
    expect(env.PATH?.split(":").slice(0, 2)).toEqual(["/home/me/.local/bin", "/home/me/.bun/bin"])
  })

  test("waits for a booting instance to answer the call", async () => {
    const state = world({ booting: 3, outcome: "gone" })
    expect((await Effect.runPromise(fire(descriptor, reachOf(state), timing))).outcome).toBe("gone")
  })

  test("fails as BackstopUnreached, saying how start went, when no service comes up", async () => {
    const state = world({ running: false, starts: false })
    const failure = await Effect.runPromise(Effect.flip(fire(descriptor, reachOf(state), timing)))
    expect(failure._tag).toBe("BackstopUnreached")
    expect(failure.message).toContain("exited 1: launchctl: refused")
  })

  test("fails as BackstopUnreached when the server never answers the call", async () => {
    const state = world({ booting: 10_000 })
    const failure = await Effect.runPromise(Effect.flip(fire(descriptor, reachOf(state), timing)))
    expect(failure.message).toContain("did not answer the wakes' due call for w00abcd")
  })

  test("the service file follows XDG_STATE_HOME, else HOME", () => {
    expect(serviceFile({ XDG_STATE_HOME: "/state" })).toBe(FILE)
    expect(serviceFile({ HOME: "/home/me" })).toBe("/home/me/.local/state/opencode/service.json")
    expect(environmentOf(descriptor).HOME).toBe("/home/me")
  })
})
