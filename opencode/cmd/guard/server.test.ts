// The plugin seam: the composition root on a stand-in host whose tool
// registry runs the `execute.before` hooks the plugin registers, with the
// sessions and repositories in memory. It checks what OpenCode sees: which
// calls are refused, the words of a refusal, and the options.
// tests/guard.test.ts runs it in OpenCode, with direct and kernel-cell calls.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, type Scope } from "effect"
import { MAX_CODE_DEPTH } from "@dotfiles/opencode-guard/executable"
import * as MemoryCheckouts from "@dotfiles/opencode-guard/memory/checkouts"
import * as MemoryLaunchers from "@dotfiles/opencode-guard/memory/launchers"
import * as MemoryProcesses from "@dotfiles/opencode-guard/memory/processes"
import * as MemoryRepoRoots from "@dotfiles/opencode-guard/memory/repo-roots"
import * as MemoryReservations from "@dotfiles/opencode-guard/memory/reservations"
import * as MemoryScriptFiles from "@dotfiles/opencode-guard/memory/script-files"
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
  readonly reservations?: MemoryReservations.World
  readonly scripts?: MemoryScriptFiles.World
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
        MemoryCheckouts.layer({ checkouts: [] }),
        MemoryReservations.layer(world.reservations ?? { bases: {} }),
        MemoryScriptFiles.layer(world.scripts),
        MemorySubagents.layer(world.parents ?? { ses_1: undefined, ses_child: "ses_1" }),
        MemoryProcesses.layer(world.processes ?? PROCESSES),
        MemoryLaunchers.layer({ scope: false, ...world.launchers, written }),
      ),
    ).effect(host)

    /** One spawn through the shell's `create.before` hooks, as OpenCode resolves it: what it spawns afterwards. */
    const spawn = Effect.fn("GuardServerTest.spawn")(function* (command: string, shell = "/bin/zsh") {
      const invocation: Invocation = { command, cwd: "/work/app", timeout: 0, shell, env: { PATH: "/usr/bin" } }
      for (const hook of shellHooks["create.before"] ?? []) yield* hook(invocation)
      return invocation
    })

    /** One tool call through the `execute.before` hooks: the refusal's message, or undefined when it may run. */
    const call = Effect.fn("GuardServerTest.call")(function* (tool: string, input: unknown, sessionID = "ses_1") {
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

  test("refuses `work gc` while its base has a workspace whose record still says creating, naming it; lets it run when none is, and refuses when the registry cannot be read", () =>
    scenario(
      Effect.gen(function* () {
        const making = { name: "hy-drums-fade", path: "/work/.work/app/hy-drums-fade" }
        const { call } = yield* start({ home: HOME }, { reservations: { bases: { "/work/app": [making] }, unreadable: ["/work/locked"] } })
        const refused = yield* call("shell", { command: "cd /work/app && work gc -older 0s | tail -1" })
        expect(refused).toStartWith("Tool.Error: guard-destructive: `work gc -older 0s` would delete, outright and not to the trash, a workspace whose record still says creating: hy-drums-fade (/work/.work/app/hy-drums-fade).")
        expect(refused).toContain("`work rm <name>`")
        expect(yield* call("bash", { command: "work --json gc", workdir: "/work/app/src" })).toContain("guard-destructive:")
        expect(yield* call("shell", { command: "sh -c 'work gc'" })).toContain("would delete, outright")
        // Another base, and the other work commands, run.
        expect(yield* call("shell", { command: "work gc", workdir: "/work/lib" })).toBeUndefined()
        expect(yield* call("shell", { command: "work list && work rm gc" })).toBeUndefined()
        expect(yield* call("shell", { command: "work gc", workdir: "/work/locked" })).toContain("cannot tell which workspaces `work gc` would delete")
      }),
    ))

  test("refuses a Chrome started for DevTools without the keychain flags, by hand or by a script, and names the testing tools", () =>
    scenario(
      Effect.gen(function* () {
        const probe = 'const CHROME = "/opt/chrome-linux64/chrome"\nBun.spawn([CHROME, "--headless", `--user-data-dir=${dir}`, "--remote-debugging-port=0"])'
        const safe = 'Bun.spawn([chromePath(), "--headless=new", "--use-mock-keychain", "--password-store=basic"])'
        const { call } = yield* start({ home: HOME }, { scripts: { "/tmp/run/probe.ts": probe, "/tmp/run/safe.ts": safe } })
        const refused = yield* call("shell", { command: "chrome-headless-shell --headless --remote-debugging-port=0" })
        expect(refused).toStartWith(
          "Tool.Error: guard-keychain: `chrome-headless-shell --headless --remote-debugging-port=0` starts Chrome with a DevTools port or headless and without --use-mock-keychain --password-store=basic",
        )
        expect(refused).toContain("Use Playwright for tests or the browse tool")
        expect(yield* call("bash", { command: "cd /tmp/run && bun probe.ts" })).toStartWith("Tool.Error: guard-keychain: `bun probe.ts` runs /tmp/run/probe.ts, which starts Chrome")
        expect(yield* call("shell", { command: "D=/tmp/run; nice bun $D/probe.ts --port 1" })).toContain("runs /tmp/run/probe.ts")
        expect(yield* call("shell", { command: "bun -e 'Bun.spawn([\"chromium\", \"--headless\"])'" })).toContain("runs its inline script")
        // Both flags, a script that passes them, a script the disk does not hold, and the owner's own Chrome run.
        expect(yield* call("shell", { command: "chrome-headless-shell --headless --use-mock-keychain --password-store=basic" })).toBeUndefined()
        expect(yield* call("shell", { command: "bun safe.ts", workdir: "/tmp/run" })).toBeUndefined()
        expect(yield* call("shell", { command: "bun /tmp/run/missing.ts" })).toBeUndefined()
        expect(yield* call("shell", { command: 'open -a "Google Chrome" https://example.com' })).toBeUndefined()
        // A bisect runs old commits' launchers: refused naming the shim prefix, and run with it.
        const shim = "$HOME/Developer/personal/dotfiles/claude/bin/chrome-mock-keychain"
        const bisect = yield* call("shell", { command: "git bisect run bun tools/drive-web.ts web measure" })
        expect(bisect).toStartWith("Tool.Error: guard-keychain: `git bisect run bun tools/drive-web.ts web measure` runs a bisect")
        expect(bisect).toContain(`CHROME="${shim}" git bisect run bun tools/drive-web.ts web measure`)
        expect(yield* call("shell", { command: `CHROME="${shim}" git bisect run bun tools/drive-web.ts web measure` })).toBeUndefined()
      }),
    ))

  test("a syntax check of a receipt and a profile does not run their old-commit commands", () =>
    scenario(
      Effect.gen(function* () {
        const unit = "/home/exedev/.cache/baton/wf10/go-backend/PROC-RUN-BYTES"
        const scripts = {
          [`${unit}/receipt.sh`]: '#!/bin/sh\nfor side in before after; do\n    git switch --detach "$commit"\n    go build -o "$s/ergo-$side" ./cmd/ergo\ndone',
          [`${unit}/profile.sh`]: '#!/bin/sh\ngit switch --detach "$source"\ngo build -o "$s/ergo" ./cmd/ergo',
        }
        const { call } = yield* start({ home: HOME }, { scripts })
        expect(yield* call("shell", { command: `sh -n ${unit}/receipt.sh ${unit}/profile.sh` })).toBeUndefined()
        expect(yield* call("shell", { command: `sh ${unit}/profile.sh` })).toContain("a bisect or a run over other commits")
      }),
    ))

  test("follows a named child only when its body supplies evidence, within the depth bound", () =>
    scenario(
      Effect.gen(function* () {
        const dir = "/nonexistent/loop-probe-child"
        const parents = {
          [`${dir}/parent.sh`]: `#!/bin/sh\nsh ${dir}/child.sh`,
          [`${dir}/dynamic.sh`]: '#!/bin/sh\nsh "$TARGET"',
          [`${dir}/syntax.sh`]: `#!/bin/sh\nsh -n ${dir}/child.sh`,
          [`${dir}/vendor.sh`]: `#!/bin/sh\n${dir}/vendor-launcher`,
        }
        const child = 'git switch --detach "$commit"'
        const files = Object.fromEntries(Array.from({ length: MAX_CODE_DEPTH + 2 }, (_, index) => [`${dir}/depth-${index}.sh`, `sh ${dir}/depth-${index + 1}.sh`]))
        const { call } = yield* start({ home: HOME }, { scripts: { ...parents, ...files, [`${dir}/depth-${MAX_CODE_DEPTH + 1}.sh`]: child, [`${dir}/child.sh`]: child, [`${dir}/$TARGET`]: child, [`${dir}/vendor-launcher`]: `#!/bin/sh\n${child}` } })
        expect(yield* call("shell", { command: `sh ${dir}/parent.sh` })).toContain(`runs ${dir}/child.sh`)
        expect(yield* call("shell", { command: `sh ${dir}/vendor.sh` })).toContain(`runs ${dir}/vendor-launcher`)
        expect(yield* call("shell", { command: `sh ${dir}/dynamic.sh` })).toBeUndefined()
        expect(yield* call("shell", { command: `sh ${dir}/syntax.sh` })).toBeUndefined()
        expect(yield* call("shell", { command: `sh ${dir}/depth-0.sh` })).toBeUndefined()
        expect(yield* call("shell", { command: `sh ${dir}/depth-1.sh` })).toContain(`depth-${MAX_CODE_DEPTH + 1}.sh`)

        const missing = yield* start({ home: HOME }, { scripts: parents })
        expect(yield* missing.call("shell", { command: `sh ${dir}/parent.sh` })).toBeUndefined()
        const inert = yield* start({ home: HOME }, { scripts: { ...parents, [`${dir}/child.sh`]: "git log --oneline" } })
        expect(yield* inert.call("shell", { command: `sh ${dir}/parent.sh` })).toBeUndefined()
      }),
    ))

  test("wrappers, startup modules, and entry points share one evidence rule", () =>
    scenario(
      Effect.gen(function* () {
        const dir = "/nonexistent/loop-probe-execution"
        const source = (name: string) => `${dir}/${name}`
        const revision = `require('node:child_process').spawnSync('git', ['switch', '--detach', 'fixture-old'])`
        const inert = "const value = 'git switch --detach fixture-old'"
        const variants = [
          `node --title ${source("inert.js")} --require ${source("first.cjs")} --import=${source("second.mjs")} ${source("app.js")}`,
          `node -r${source("first.cjs")} --conditions=fixture --loader ${source("second.mjs")} ${source("app.js")}`,
          `env NODE_OPTIONS='--require ${source("first.cjs")} --import ${source("second.mjs")}' node ${source("app.js")}`,
          `NODE_OPTIONS='--loader=${source("first.cjs")}' node --require ${source("second.mjs")} ${source("app.js")}`,
          `bun --cwd ${dir} --preload ${source("first.cjs")} --preload=${source("second.mjs")} run ${source("app.js")}`,
          `node --unknown-module ${source("first.cjs")} --import ${source("second.mjs")} ${source("app.js")}`,
        ]
        const wrapperChains = ["", "nice -n 19 ", "command -p env A=B ", "time exec nice -n 19 ", "cat /nonexistent/loop-probe-input | xargs -r "]
        const quiet = { [source("first.cjs")]: inert, [source("second.mjs")]: inert, [source("app.js")]: inert, [source("inert.js")]: revision }
        const allowed = yield* start({ home: HOME }, { scripts: quiet })
        for (const filename of ["first.cjs", "second.mjs", "app.js"]) {
          const { call } = yield* start({ home: HOME }, { scripts: { ...quiet, [source(filename)]: revision } })
          for (const wrapper of wrapperChains) {
            for (const runtime of variants) {
              const line = `${wrapper}${runtime}`
              expect([line, yield* call("shell", { command: line })]).toEqual([line, expect.stringContaining(`runs ${source(filename)}`)])
              expect(yield* allowed.call("shell", { command: line })).toBeUndefined()
              if (!wrapper.includes("|")) {
                const shim = "$HOME/Developer/personal/dotfiles/claude/bin/chrome-mock-keychain"
                expect(yield* call("shell", { command: `export CHROME="${shim}"; ${line}` })).toBeUndefined()
              }
            }
          }
        }
        const paths = yield* start({ home: HOME }, { scripts: { [source("walk.sh")]: "git switch --detach fixture-old", [source("fixture.py")]: "import subprocess\nsubprocess.run(['git', 'switch', '--detach', 'fixture-old'])" } })
        expect(yield* paths.call("shell", { command: `printf '%s\\n' '${source("walk.sh")}' | xargs sh` })).toContain(source("walk.sh"))
        expect(yield* paths.call("shell", { command: `printf '%s\\n' '${source("walk.sh")}' | xargs -I '{}' sh '{}'` })).toContain(source("walk.sh"))
        expect(yield* paths.call("shell", { command: `cat /nonexistent/loop-probe-input | xargs -I '{}' sh ${source("walk.sh")} '{}'` })).toContain(source("walk.sh"))
        expect(yield* paths.call("shell", { command: "cat /nonexistent/loop-probe-input | xargs -I '{}' sh '{}'" })).toBeUndefined()
        expect(yield* paths.call("shell", { command: `cd ${dir} && python3 -m fixture` })).toContain(source("fixture.py"))
        expect(yield* paths.call("shell", { command: `python -c "import os; os.system('git switch --detach fixture-old')"` })).toContain("its inline script")
        expect(yield* paths.call("shell", { command: `python -c "print('git switch --detach fixture-old')"` })).toBeUndefined()
        expect(yield* paths.call("shell", { command: `sh -c 'git switch --detach fixture-old'` })).toContain("guard-keychain:")
        const nodeCheck = yield* start({ home: HOME }, { scripts: { ...quiet, [source("first.cjs")]: revision, [source("app.js")]: revision } })
        expect(yield* nodeCheck.call("shell", { command: `node --check ${source("app.js")}` })).toBeUndefined()
        expect(yield* nodeCheck.call("shell", { command: `node --check --require ${source("first.cjs")} ${source("app.js")}` })).toContain(source("first.cjs"))
        expect(yield* nodeCheck.call("shell", { command: `NODE_OPTIONS='-r ${source("first.cjs")}' node -c ${source("app.js")}` })).toContain(source("first.cjs"))
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
        expect([...defaults.written.values()][0]).toContain("systemd-run --user --scope --quiet --collect -p MemoryMax=12G -p CPUWeight=20 -- '/bin/zsh'")
        const tuned = yield* start({ home: HOME, heavy: ["make check"], nice: 5, memoryMax: "8G", cpuWeight: 50 }, { launchers: { scope: true } })
        expect((yield* tuned.spawn("bun test")).shell).toBe("/bin/zsh")
        expect((yield* tuned.spawn("make check")).shell).toBe("/launchers/0/zsh")
        expect([...tuned.written.values()][0]).toContain("exec nice -n 5 systemd-run --user --scope --quiet --collect -p MemoryMax=8G -p CPUWeight=50 --")
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
