// The plugin seam: the composition root on a stand-in host whose tool
// registry runs the `execute.before` hooks the plugin registers, with the
// sessions and repositories in memory. It checks what OpenCode sees: which
// calls are refused, the words of a refusal, and the options.
// tests/guard.test.ts runs it in OpenCode, with direct and kernel-cell calls.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, type Scope } from "effect"
import * as MemoryRepoRoots from "@dotfiles/opencode-guard/memory/repo-roots"
import * as MemorySessionDirectories from "@dotfiles/opencode-guard/memory/session-directories"
import Guard, { make } from "./server.ts"

type Host = Parameters<(typeof Guard)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void, { readonly _tag: string; readonly message: string }>

const HOME = "/Users/owner"

/** The outside systems' state for one test. */
interface World {
  readonly sessions?: Readonly<Record<string, string>>
  readonly repos?: MemoryRepoRoots.World
}

/** The plugin started on a stand-in host, and a call through the hooks it registered. */
const start = (options: Record<string, unknown> = { home: HOME }, world: World = {}) =>
  Effect.gen(function* () {
    const hooks: Record<string, Array<Hook>> = {}
    const host = {
      options,
      tool: {
        hook: (name: string, callback: Hook) =>
          Effect.sync(() => {
            ;(hooks[name] ??= []).push(callback)
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    yield* make(() =>
      Layer.mergeAll(MemorySessionDirectories.layer(world.sessions ?? { ses_1: "/work/app" }), MemoryRepoRoots.layer(world.repos ?? { repos: ["/work/app"] })),
    ).effect(host)

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
    return { call, hooks }
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
