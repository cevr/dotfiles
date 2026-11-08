// The plugin seam: the composition root on a stand-in host whose tool
// registry runs the `execute.before` hooks the plugin registers, with the
// sessions and repositories in memory. It checks what OpenCode sees: which
// calls are refused, the words of a refusal, and the options.
// tests/guard.test.ts runs it in OpenCode, with direct and kernel-cell calls.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, type Scope } from "effect"
import * as MemoryLaunchers from "@dotfiles/opencode-guard/memory/launchers"
import * as MemoryProcesses from "@dotfiles/opencode-guard/memory/processes"
import * as MemoryRepoRoots from "@dotfiles/opencode-guard/memory/repo-roots"
import * as MemorySessionDirectories from "@dotfiles/opencode-guard/memory/session-directories"
import * as MemorySubagents from "@dotfiles/opencode-guard/memory/subagents"
import Guard, { make } from "./server.ts"

type Host = Parameters<(typeof Guard)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void, { readonly _tag: string; readonly message: string }>
/** What the shell's `create.before` hook receives, as `@opencode/plugin/effect/shell` declares it. */
interface Invocation {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

const HOME = "/Users/owner"
/** The machine: this test process stands for the server the plugin runs in (it reads `process.pid`), beside a dev server. */
const PROCESSES: MemoryProcesses.World = [
  { pid: process.pid, name: "opencode", args: "opencode serve --service" },
  { pid: process.pid + 1, name: "vite", args: "node vite --port 5173" },
]

/** The outside systems' state for one test. */
interface World {
  readonly sessions?: Readonly<Record<string, string>>
  readonly repos?: MemoryRepoRoots.World
  /** Each session's parent; default `ses_1` a root and `ses_child` its subagent. */
  readonly parents?: Readonly<Record<string, string | undefined>>
  readonly processes?: MemoryProcesses.World
  readonly launchers?: Omit<MemoryLaunchers.World, "written">
}

/** The plugin started on a stand-in host, and a call through the hooks it registered. */
const start = (options: Record<string, unknown> = { home: HOME }, world: World = {}) =>
  Effect.gen(function* () {
    const hooks: Record<string, Array<Hook>> = {}
    const shellHooks: Record<string, Array<(invocation: Invocation) => Effect.Effect<void>>> = {}
    const register =
      <C>(into: Record<string, Array<C>>) =>
      (name: string, callback: C) =>
        Effect.sync(() => {
          ;(into[name] ??= []).push(callback)
          return { dispose: Effect.void }
        })
    const host = { options, tool: { hook: register(hooks) }, shell: { hook: register(shellHooks) } } as unknown as Host
    const written = new Map<string, string>()
    yield* make(() =>
      Layer.mergeAll(
        MemorySessionDirectories.layer(world.sessions ?? { ses_1: "/work/app", ses_child: "/work/app" }),
        MemoryRepoRoots.layer(world.repos ?? { repos: ["/work/app"] }),
        MemorySubagents.layer(world.parents ?? { ses_1: undefined, ses_child: "ses_1" }),
        MemoryProcesses.layer(world.processes ?? PROCESSES),
        MemoryLaunchers.layer({ scope: false, ...world.launchers, written }),
      ),
    ).effect(host)

    /** One spawn through the shell's `create.before` hooks, as OpenCode resolves it: what it spawns afterwards. */
    const spawn = Effect.fn(function* (command: string, shell = "/bin/zsh") {
      const invocation: Invocation = { command, cwd: "/work/app", timeout: 0, shell, env: { PATH: "/usr/bin" } }
      for (const hook of shellHooks["create.before"] ?? []) yield* hook(invocation)
      return invocation
    })

    /** One tool call through the `execute.before` hooks: the refusal's message, or undefined when it may run. */
    const call = Effect.fn(function* (tool: string, input: unknown, sessionID = "ses_1") {
      const event: Record<string, unknown> = { tool, sessionID, agent: "build", messageID: "msg", id: "call", input }
      for (const hook of hooks["execute.before"] ?? []) {
        const exit = yield* Effect.exit(hook(event))
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
          return reason?._tag === "Fail" ? `${reason.error._tag}: ${reason.error.message}` : "defect"
        }
      }
      return undefined
    })
    return { call, hooks, spawn, written }
  })

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

describe("the guard plugin", () => {
  test("refuses a shell call that loses work for good, in the Claude Code hook's words, under either tool name", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start()
        const reset = "Tool.Error: guard-destructive: `git reset --hard` discards uncommitted work; stash it (`git stash -u`) or commit first."
        expect(yield* call("shell", { command: "git reset --hard" })).toBe(reset)
        expect(yield* call("bash", { command: "git reset --hard" })).toBe(reset)
        expect(yield* call("shell", { command: "cd /tmp && rm -rf ~" })).toBe(
          "Tool.Error: guard-destructive: `rm -rf ~` would delete your home; name a narrower path.",
        )
      }),
    ))

  test("lets a harmless shell call and every other tool run", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start()
        expect(yield* call("shell", { command: "rm -rf build && git push --force" })).toBeUndefined()
        expect(yield* call("read", { command: "git reset --hard", path: "/" })).toBeUndefined()
        expect(yield* call("kernel", { code: "await tools.shell({ command: 'git reset --hard' })" })).toBeUndefined()
        // An input that is no shell call's is the tool's to refuse.
        expect(yield* call("shell", { cmd: "git reset --hard" })).toBeUndefined()
      }),
    ))

  test("reads a call from its session's directory and its workdir, and an input sent as JSON text", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start({ home: HOME }, { sessions: { ses_1: "/work/app/src" }, repos: { repos: ["/work/app", "/work/lib"] } })
        expect(yield* call("shell", { command: "rm -rf ../../lib" })).toContain("would delete the repository at /work/lib")
        expect(yield* call("shell", { command: "rm -rf .." })).toContain("the directory it runs in")
        expect(yield* call("shell", { command: "rm -rf src", workdir: ".." })).toBeUndefined()
        expect(yield* call("shell", { command: "rm -rf app", workdir: "/work" })).toContain("would delete the repository at /work/app")
        expect(yield* call("shell", JSON.stringify({ command: "git clean -fdx" }))).toContain("deletes untracked files for good")
      }),
    ))

  test("refuses a kill by pattern that would reach the server it runs in, and lets one that misses it run", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start()
        expect(yield* call("shell", { command: "pkill -f 'serve --service'" })).toBe(
          `Tool.Error: guard-destructive: \`pkill -f serve --service\` would also kill the OpenCode server this session runs on, pid ${process.pid} (\`opencode serve --service\`); find the PID you mean (\`pgrep -fl <pattern>\`, \`ps\`) and \`kill <pid>\`.`,
        )
        expect(yield* call("bash", { command: "killall opencode" })).toContain("would also kill the OpenCode server")
        expect(yield* call("shell", { command: "pkill -f vite" })).toBeUndefined()
        const { call: blind } = yield* start({ home: HOME }, { processes: "unreadable" })
        expect(yield* blind("shell", { command: "pkill -f vite" })).toContain("cannot list the processes")
      }),
    ))

  test("refuses a subagent's foreground sleep of 30 s or more in the guard's words, under either tool name, and lets the root's run", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start()
        const refused = yield* call("shell", { command: "sleep 60 && tail -5 build.log" }, "ses_child")
        expect(refused).toStartWith("Tool.Error: guard-sleep: `sleep 60` would hold this subagent's turn for 60 s doing nothing")
        expect(refused).toContain('shell({ action: "wait", id, ms })')
        expect(refused).toEndWith("wake and monitor are the root session's, not a subagent's.")
        expect(yield* call("bash", { command: "sleep 45; gh run view" }, "ses_child")).toStartWith("Tool.Error: guard-sleep: `sleep 45`")
        expect(yield* call("shell", JSON.stringify({ command: "sleep 90" }), "ses_child")).toStartWith("Tool.Error: guard-sleep:")
        expect(yield* call("shell", { command: "sleep 60 && tail -5 build.log" })).toBeUndefined()
        expect(yield* call("shell", { command: "sleep 60", background: true }, "ses_child")).toBeUndefined()
        expect(yield* call("shell", { command: "sleep 10 && ls" }, "ses_child")).toBeUndefined()
        // A malformed `background` is no background, and never hides a destructive call.
        expect(yield* call("shell", { command: "sleep 60", background: "yes" }, "ses_child")).toStartWith("Tool.Error: guard-sleep:")
        expect(yield* call("shell", { command: "git reset --hard", background: "yes" })).toContain("guard-destructive:")
      }),
    ))

  test("refuses rather than guess when the host cannot say where the call runs", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start()
        expect(yield* call("shell", { command: "ls" }, "ses_gone")).toBe(
          "Tool.Error: guard-destructive: cannot tell where `ls` runs (no session ses_gone); the guard refuses rather than guess.",
        )
      }),
    ))

  test("takes the user's home when `home` is absent, and stops on a malformed option", () =>
    scenario(
      Effect.gen(function* () {
        const { hooks } = yield* start({ home: undefined })
        expect(hooks["execute.before"]).toHaveLength(1)
        const exit = yield* Effect.exit(start({ home: 3 }))
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("dotfiles-opencode.guard: invalid options")
      }),
    ))
})

describe("the shell policy", () => {
  test("spawns a heavy command through a launcher of its shell, the command as written, and any other through its shell", () =>
    scenario(
      Effect.gen(function* () {
        const { spawn, written } = yield* start()
        const heavy = yield* spawn("cd opencode && bun run gate")
        expect(heavy.command).toBe("cd opencode && bun run gate")
        expect(heavy.shell).toBe("/launchers/0/zsh")
        expect(written.get("/launchers/0/zsh")).toContain("exec nice -n 10 '/bin/zsh' \"$@\"")
        expect((yield* spawn("bun test", "/bin/bash")).shell).toBe("/launchers/1/bash")
        expect((yield* spawn("bun test")).shell).toBe("/launchers/0/zsh")
        const light = yield* spawn("ls -la")
        expect(light).toEqual({ command: "ls -la", cwd: "/work/app", timeout: 0, shell: "/bin/zsh", env: { PATH: "/usr/bin" } })
      }),
    ))

  test("on systemd it caps memory at 12G with CPU weight 20 by default, and takes the options' limits and patterns", () =>
    scenario(
      Effect.gen(function* () {
        const defaults = yield* start({ home: HOME }, { launchers: { scope: true } })
        yield* defaults.spawn("vitest run")
        expect([...defaults.written.values()].find((file) => !file.includes("a heavy command's systemd-run"))).toContain("systemd-run --user --scope --quiet --collect -p MemoryMax=12G -p CPUWeight=20 -- '/bin/zsh'")
        const tuned = yield* start({ home: HOME, heavy: ["make check"], nice: 5, memoryMax: "8G", cpuWeight: 50 }, { launchers: { scope: true } })
        expect((yield* tuned.spawn("bun test")).shell).toBe("/bin/zsh")
        expect((yield* tuned.spawn("make check")).shell).toMatch(/^\/launchers\/\d+\/zsh$/)
        expect([...tuned.written.values()].find((file) => !file.includes("a heavy command's systemd-run"))).toContain("exec nice -n 5 systemd-run --user --scope --quiet --collect -p MemoryMax=8G -p CPUWeight=50 --")
        const off = yield* start({ home: HOME, heavy: [] })
        expect((yield* off.spawn("bun test")).shell).toBe("/bin/zsh")
      }),
    ))

  test("runs a heavy command as it would have when no launcher can be written", () =>
    scenario(
      Effect.gen(function* () {
        const { spawn } = yield* start({ home: HOME }, { launchers: { scope: false, unwritable: true } })
        expect((yield* spawn("bun test")).shell).toBe("/bin/zsh")
      }),
    ))

  test("stops on a malformed limit", () =>
    scenario(
      Effect.gen(function* () {
        for (const options of [{ nice: 20 }, { nice: 1.5 }, { memoryMax: "lots" }, { cpuWeight: 0 }, { heavy: "bun test" }]) {
          const exit = yield* Effect.exit(start({ home: HOME, ...options }))
          expect([options, Exit.isFailure(exit) && String(exit.cause).includes("dotfiles-opencode.guard: invalid options")]).toEqual([options, true])
        }
      }),
    ))
})
