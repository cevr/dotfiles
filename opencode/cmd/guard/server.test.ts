// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The plugin seam: the composition root on a stand-in host whose tool
// registry runs the `execute.before` hooks the plugin registers, with the
// sessions and repositories in memory. It checks what OpenCode sees: which
// calls are refused, the words of a refusal, and the options.
// tests/guard.test.ts runs it in OpenCode, with direct and kernel-cell calls.
import { describe, expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, Exit, FileSystem, Layer, Option, Path, type Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { keychainLaunch } from "@dotfiles/opencode-guard/chrome"
import { MAX_CODE_DEPTH, MAX_PATH_STATES } from "@dotfiles/opencode-guard/executable"
import * as MemoryCheckouts from "@dotfiles/opencode-guard/memory/checkouts"
import * as MemoryProcesses from "@dotfiles/opencode-guard/memory/processes"
import * as MemoryRepoRoots from "@dotfiles/opencode-guard/memory/repo-roots"
import * as MemoryReservations from "@dotfiles/opencode-guard/memory/reservations"
import * as MemoryScriptFiles from "@dotfiles/opencode-guard/memory/script-files"
import * as MemorySessionDirectories from "@dotfiles/opencode-guard/memory/session-directories"
import * as MemorySubagents from "@dotfiles/opencode-guard/memory/subagents"
import { hangGuard } from "../../tests/hang-guard.ts"
import Guard, { make } from "./server.ts"

type Host = Parameters<(typeof Guard)["effect"]>[0]
type Hook = (event: Record<string, unknown>) => Effect.Effect<void, { readonly _tag: string; readonly message: string }>

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
}

/** The plugin started on a stand-in host, and a call through the hooks it registered. */
const start = (options: Record<string, unknown> = { home: HOME }, world: World = {}) =>
  Effect.gen(function* () {
    const hooks: Record<string, Array<Hook>> = {}
    const shellHooks: Record<string, Array<unknown>> = {}
    const register =
      <C>(into: Record<string, Array<C>>) =>
      (name: string, callback: C) =>
        Effect.sync(() => {
          ;(into[name] ??= []).push(callback)
          return { dispose: Effect.void }
        })
    const host = { options, tool: { hook: register(hooks) }, shell: { hook: register(shellHooks) } } as unknown as Host
    yield* make(() =>
      Layer.mergeAll(
        MemorySessionDirectories.layer(world.sessions ?? { ses_1: "/work/app", ses_child: "/work/app" }),
        MemoryRepoRoots.layer(world.repos ?? { repos: ["/work/app"] }),
        MemoryCheckouts.layer({ checkouts: [] }),
        MemoryReservations.layer(world.reservations ?? { bases: {} }),
        MemoryScriptFiles.layer(world.scripts),
        MemorySubagents.layer(world.parents ?? { ses_1: undefined, ses_child: "ses_1" }),
        MemoryProcesses.layer(world.processes ?? PROCESSES),
      ),
    ).effect(host)

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
    return { call, hooks, shellHooks }
  })

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))
const rangesFrom = (from: number, to: number): ReadonlyArray<{ readonly from: number; readonly to: number }> => {
  if (to <= from) return []
  return [{ from, to }]
}

describe("the guard plugin", () => {
  test("refuses a shell call that loses work for good, in the Claude Code hook's words, under either tool name", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start()
        const reset = "Tool.Error: Refused by guard-destructive: `git reset --hard` discards uncommitted work; stash it (`git stash -u`) or commit first."
        expect(yield* call("shell", { command: "git reset --hard" })).toBe(reset)
        expect(yield* call("bash", { command: "git reset --hard" })).toBe(reset)
        expect(yield* call("shell", { command: "cd /tmp && rm -rf ~" })).toBe(
          "Tool.Error: Refused by guard-destructive: `rm -rf ~` would delete your home; name a narrower path.",
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
          `Tool.Error: Refused by guard-destructive: \`pkill -f serve --service\` would also kill the OpenCode server this session runs on, pid ${process.pid} (\`opencode serve --service\`); find the PID you mean (\`pgrep -fl <pattern>\`, \`ps\`) and \`kill <pid>\`.`,
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
        expect(refused).toStartWith("Tool.Error: Refused by guard-sleep: `sleep 60` would hold this subagent's turn for 60 s doing nothing")
        expect(refused).toContain('shell({ action: "wait", id, ms })')
        expect(refused).toEndWith("wake and monitor are the root session's, not a subagent's.")
        expect(yield* call("bash", { command: "sleep 45; gh run view" }, "ses_child")).toStartWith("Tool.Error: Refused by guard-sleep: `sleep 45`")
        expect(yield* call("shell", JSON.stringify({ command: "sleep 90" }), "ses_child")).toStartWith("Tool.Error: Refused by guard-sleep:")
        expect(yield* call("shell", { command: "sleep 60 && tail -5 build.log" })).toBeUndefined()
        expect(yield* call("shell", { command: "sleep 60", background: true }, "ses_child")).toBeUndefined()
        expect(yield* call("shell", { command: "sleep 10 && ls" }, "ses_child")).toBeUndefined()
        // A malformed `background` is no background, and never hides a destructive call.
        expect(yield* call("shell", { command: "sleep 60", background: "yes" }, "ses_child")).toStartWith("Tool.Error: Refused by guard-sleep:")
        expect(yield* call("shell", { command: "git reset --hard", background: "yes" })).toContain("Refused by guard-destructive:")
      }),
    ))

  test("refuses `work gc` while its base has a workspace whose record still says creating, naming it; lets it run when none is, and refuses when the registry cannot be read", () =>
    scenario(
      Effect.gen(function* () {
        const making = { name: "hy-drums-fade", path: "/work/.work/app/hy-drums-fade" }
        const { call } = yield* start({ home: HOME }, { reservations: { bases: { "/work/app": [making] }, unreadable: ["/work/locked"] } })
        const refused = yield* call("shell", { command: "cd /work/app && work gc -older 0s | tail -1" })
        expect(refused).toStartWith("Tool.Error: Refused by guard-destructive: `work gc -older 0s` would delete, outright and not to the trash, a workspace whose record still says creating: hy-drums-fade (/work/.work/app/hy-drums-fade).")
        expect(refused).toContain("`work rm <name>`")
        expect(yield* call("bash", { command: "work --json gc", workdir: "/work/app/src" })).toContain("Refused by guard-destructive:")
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
          "Tool.Error: Refused by guard-keychain: `chrome-headless-shell --headless --remote-debugging-port=0` starts Chrome with a DevTools port or headless and without --use-mock-keychain --password-store=basic",
        )
        expect(refused).toContain("Use Playwright for tests or the browse tool")
        expect(yield* call("bash", { command: "cd /tmp/run && bun probe.ts" })).toStartWith("Tool.Error: Refused by guard-keychain: `bun probe.ts` runs /tmp/run/probe.ts, which starts Chrome")
        expect(yield* call("shell", { command: "D=/tmp/run; nice bun $D/probe.ts --port 1" })).toContain("runs /tmp/run/probe.ts")
        expect(yield* call("shell", { command: "bun -e 'Bun.spawn([\"chromium\", \"--headless\"])'" })).toContain("runs its inline script")
        // Both flags, a script that passes them, a script the disk does not hold, and the owner's own Chrome run.
        expect(yield* call("shell", { command: "chrome-headless-shell --headless --use-mock-keychain --password-store=basic" })).toBeUndefined()
        expect(yield* call("shell", { command: "bun safe.ts", workdir: "/tmp/run" })).toBeUndefined()
        expect(yield* call("shell", { command: "bun /tmp/run/missing.ts" })).toBeUndefined()
        expect(yield* call("shell", { command: 'open -a "Google Chrome" https://example.com' })).toBeUndefined()
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
        expect(yield* call("shell", { command: `sh ${unit}/profile.sh` })).toContain("Cannot tell whether the Git operation selects another revision")
        const selectorOnly = yield* start({ home: HOME }, { scripts: { [`${unit}/profile.sh`]: 'git switch --detach "$source"' } })
        expect(yield* selectorOnly.call("shell", { command: `sh ${unit}/profile.sh` })).toBeUndefined()
      }),
    ))

  test("every advertised keychain form preserves the command and passes the same hook", () =>
    scenario(
      Effect.gen(function* () {
        const dir = "/nonexistent/loop-probe-message"
        const scripts = {
          [`${dir}/probe-bisect.sh`]: "npm test",
          [`${dir}/select.js`]: "require('node:child_process').execSync('git checkout HEAD~1')",
          [`${dir}/select.sh`]: "git checkout HEAD~1\nnpm test",
        }
        const { call } = yield* start({ home: HOME }, { scripts, sessions: { ses_1: dir } })
        const heading = "Tool.Error: Not a refusal: a command-shape rule. Run it this way and continue:"
        const prefix = 'CHROME="$HOME/Developer/personal/dotfiles/claude/bin/chrome-mock-keychain"'
        const bisect = "git bisect run bun tools/drive-web.ts web measure"
        const lines = [
          "git checkout HEAD~1; npm test",
          'git checkout HEAD~1\nnpm test -- "two words"',
          'git checkout "$REV~1"; npm test',
          "git checkout --future-option fixture-old; npm test",
          "git rebase --exec 'npm test' HEAD~2",
          "sh ./probe-bisect.sh",
          "sh ./select.sh",
          "node ./select.js",
          "git -C . bisect run npm test",
          "env git bisect run npm test",
        ]
        const examples = [[bisect, `${prefix} ${bisect}`], ...lines.map((line) => [line, `export ${prefix}; ${line}`] as const)] as const
        for (const tool of ["shell", "bash"]) for (const [command, wanted] of examples) {
          const refusal = yield* call(tool, { command, workdir: dir })
          const [first, ...rest] = (refusal || "").split("\n")
          const form = rest.slice(0, -1).join("\n")
          expect([command, first, form]).toEqual([command, heading, wanted])
          expect(rest.at(-1)).toBeTruthy()
          expect(yield* call(tool, { command: form, workdir: dir })).toBeUndefined()
        }
        const mixed = yield* call("shell", { command: "git bisect run npm test; chromium --headless" })
        expect(mixed).toStartWith("Tool.Error: Refused by guard-keychain: `chromium --headless` starts Chrome")
        const stripsShim = yield* call("shell", { command: "env -i git bisect run npm test" })
        expect(stripsShim).toStartWith("Tool.Error: Refused by guard-keychain:")
        expect(stripsShim).not.toContain(prefix)
      }),
    ))

  test("a path limit instructs the caller to split instead of claiming a rule refused the command", () =>
    scenario(
      Effect.gen(function* () {
        const { call } = yield* start({ home: HOME })
        const branches = Array.from({ length: Math.log2(MAX_PATH_STATES) + 1 }, (_, id) =>
          `if test -n "$CI"; then BRANCH_${id}=one; else BRANCH_${id}=two; fi;`)
        const target = branches.map((_, id) => `\${BRANCH_${id}}`).join("-")
        const command = `${branches.join(" ")} git checkout "${target}"; npm test`
        expect(yield* call("shell", { command })).toBe(
          `Tool.Error: Cannot tell: the shell produces more than ${MAX_PATH_STATES} possible path states.\nSplit the compound command so each part can be checked, and run the parts.`,
        )
      }),
    ))

  test("does not offer a shim that an unset or replacement prevents the launcher inheriting", () =>
    scenario(
      Effect.gen(function* () {
        const dir = "/nonexistent/loop-probe-shim"
        const { call } = yield* start({ home: HOME }, {
          scripts: { [`${dir}/select.sh`]: "unset CHROME\ngit checkout HEAD~1\nnpm test" },
          sessions: { ses_1: dir },
        })
        const shim = 'CHROME="$HOME/Developer/personal/dotfiles/claude/bin/chrome-mock-keychain"'
        const run = "git checkout HEAD~1; npm test"
        const forms = [`unset CHROME; ${run}`, `unset -v -- CHROME; ${run}`, `CHROME=/usr/bin/chromium; ${run}`, "sh ./select.sh"]
        for (const command of forms) {
          const rejected = yield* call("shell", { command, workdir: dir })
          expect([command, rejected]).toEqual([command, expect.stringMatching(/^Tool\.Error: Refused by guard-keychain: /)])
          expect(rejected).toContain("The shim does not reach every affected launcher.")
          expect(rejected).not.toContain(shim)
          expect(yield* call("shell", { command: `export ${shim}; ${command}`, workdir: dir })).toStartWith("Tool.Error: Refused by guard-keychain:")
        }
        // Unsets in a subshell or of a function do not clear the parent's variable.
        for (const safe of ["(unset CHROME)", "unset -f CHROME", "unset OTHER"])
          expect(yield* call("shell", { command: `export ${shim}; ${safe}; ${run}`, workdir: dir })).toBeUndefined()
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
        const childWithRun = `${child}\nfixture-build`
        const withRun = { ...parents, ...files, [`${dir}/depth-${MAX_CODE_DEPTH + 1}.sh`]: childWithRun, [`${dir}/child.sh`]: childWithRun, [`${dir}/$TARGET`]: childWithRun, [`${dir}/vendor-launcher`]: `#!/bin/sh\n${childWithRun}` }
        const { call } = yield* start({ home: HOME }, { scripts: withRun })
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
        const selectorOnly = yield* start({ home: HOME }, { scripts: { ...parents, [`${dir}/child.sh`]: child } })
        expect(yield* selectorOnly.call("shell", { command: `sh ${dir}/parent.sh` })).toBeUndefined()
        expect(yield* selectorOnly.call("shell", { command: `sh ${dir}/parent.sh; fixture-build` })).toContain("Cannot tell whether the Git operation selects another revision")
        const launchInParent = yield* start({ home: HOME }, { scripts: { ...parents, [`${dir}/child.sh`]: child, [`${dir}/parent.sh`]: `${parents[`${dir}/parent.sh`]}\nfixture-build` } })
        expect(yield* launchInParent.call("shell", { command: `sh ${dir}/parent.sh` })).toContain(`runs ${dir}/parent.sh`)
      }),
    ))

  test("the checkout boundary relates sibling directories of one tree without merging two repositories", () =>
    scenario(
      Effect.gen(function* () {
        const tree = "/nonexistent/loop-probe-tree"
        const nested = `${tree}/nested`
        const sibling = "/nonexistent/loop-probe-other"
        const session = `${tree}/src`
        const { call } = yield* start({ home: HOME }, { sessions: { ses_1: session }, repos: { repos: [tree, nested, sibling] } })
        expect(yield* call("shell", { command: "git -C ../tools switch --detach fixture-old; npm test" })).toContain("after selecting another Git revision")
        expect(yield* call("shell", { command: `git -C ${sibling} switch --detach fixture-old; npm test` })).toBeUndefined()
        expect(yield* call("shell", { command: `git -C ${tree} switch --detach fixture-old; cd ${nested} && npm test` })).toBeUndefined()
        expect(yield* call("shell", { command: `git clone --branch fixture-old ${sibling} ../new; cd ../new/subdir; npm test` })).toBeUndefined()
      }),
    ))

  test("parent and readable driver share revision history in both directions, not cwd", () =>
    scenario(
      Effect.gen(function* () {
        const top = "/nonexistent/loop-probe-shared"
        const alpha = `${top}/alpha`
        const beta = `${top}/beta`
        const gamma = `${top}/gamma`
        const scripts = {
          [`${alpha}/check.sh`]: "#!/bin/sh\ncd ../beta && npm test",
          [`${alpha}/check-local.sh`]: "#!/bin/sh\ncd ../gamma && npm test",
          [`${alpha}/change.sh`]: "#!/bin/sh\ncd ../beta && git switch --detach fixture-old",
          [`${alpha}/no-checkout.sh`]: "git bisect start --no-checkout HEAD fixture-old",
        }
        const { call } = yield* start({ home: HOME }, { sessions: { ses_1: alpha }, repos: { repos: [alpha, beta, gamma] }, scripts })
        const select = "git -C ../beta switch --detach fixture-old"
        expect(yield* call("shell", { command: `${select}; sh ./check.sh` })).toContain("after selecting another Git revision")
        expect(yield* call("shell", { command: `${select}; sh ./check-local.sh` })).toBeUndefined()
        expect(yield* call("shell", { command: "sh ./change.sh; cd ../beta && npm test" })).toContain("after selecting another Git revision")
        expect(yield* call("shell", { command: "sh ./change.sh; npm test" })).toBeUndefined()
        expect(yield* call("shell", { command: "sh ./no-checkout.sh; git bisect good; npm test" })).toBeUndefined()
        expect(yield* call("shell", { command: "git pull --no-rebase --no-ff --no-commit origin main && npm test" })).toBeUndefined()
        expect(yield* call("shell", { command: "git checkout -b review-branch @ && npm test" })).toBeUndefined()
      }),
    ))

  test("later cwd, runner options and executed files use the same checkout relation", () =>
    scenario(
      Effect.gen(function* () {
        const parent = "/nonexistent/loop-probe-runner"
        const trees = ["alpha", "beta", "gamma"]
        const path = (name: string) => `${parent}/${name}`
        const where = { cwd: path("alpha"), home: HOME }
        const root = (directory: string) => Effect.succeed(Option.fromUndefinedOr(trees.map(path).find((tree) => directory === tree || directory.startsWith(`${tree}/`))))
        const load = (file: string) => Effect.succeed(Option.liftPredicate(`#!/bin/sh\ncd ${file.slice(0, file.lastIndexOf("/"))}; fixture-tool`, () => file.endsWith("/runner.sh")))
        const spellings = [
          (name: string) => `(cd ../${name}; npm test)`,
          (name: string) => `npm --prefix=../${name} test`,
          (name: string) => `pnpm -C ../${name} test`,
          (name: string) => `yarn --cwd ../${name} test`,
          (name: string) => `bun --cwd ../${name} test`,
          (name: string) => `make -C../${name} test`,
          (name: string) => `cargo test --manifest-path ../${name}/Cargo.toml`,
          (name: string) => `../${name}/runner.sh`,
          (name: string) => `sh ../${name}/runner.sh`,
          (name: string) => `node ../${name}/runner.js`,
        ]
        const cases = trees.flatMap((selected) => trees.flatMap((launched) => spellings.map((launch) => ({ selected, launched, line: launch(launched) }))))
        for (const { selected, launched, line } of cases) {
          const change = `git -C ../${selected} checkout deadbee`
          const before = yield* keychainLaunch(`${line}; ${change}`, where, load, root)
          const after = yield* keychainLaunch(`${change}; ${line}`, where, load, root)
          expect([line, selected, Option.isSome(before), Option.isSome(after)]).toEqual([line, selected, false, selected === launched])
        }
        const unrecognized = "npm --not-a-location ../beta test"
        expect(Option.isNone(yield* keychainLaunch(`git -C ../beta checkout deadbee; ${unrecognized}`, where, load, root))).toBe(true)
        expect(Option.isNone(yield* keychainLaunch("npm --prefix ../beta test; git -C ../beta checkout deadbee; npm test", where, load, root))).toBe(true)
        expect(Option.isNone(yield* keychainLaunch("git -C ../beta checkout deadbee; sh -n ../beta/runner.sh", where, load, root))).toBe(true)
        const inert = () => Effect.succeed(Option.some("#!/bin/sh\ntrue"))
        const unchanged = yield* keychainLaunch("git checkout deadbee; ../beta/runner.sh", where, inert, root)
        const changed = yield* keychainLaunch("git -C ../beta checkout deadbee; ../beta/runner.sh", where, inert, root)
        expect(Option.isNone(unchanged)).toBe(true)
        expect(Option.map(changed, (finding) => finding.remedy)).toEqual(Option.some("shim"))
      }),
    ))

  test("a loaded child keeps selections on its own paths at the caller's continuation", () =>
    scenario(
      Effect.gen(function* () {
        const alpha = "/nonexistent/join-probe/alpha"
        const beta = "/nonexistent/join-probe/beta"
        const where = { cwd: alpha, home: HOME }
        const root = (cwd: string) => Effect.succeed(Option.liftPredicate(cwd, (path) => path === alpha || path === beta))
        const child = 'if test -n "$CI"; then cd ../beta; fi; git checkout HEAD~1'
        const load = (name: string) => Effect.succeed(Option.liftPredicate(child, () => name === `${alpha}/select.sh`))
        const picked = yield* keychainLaunch("sh ./select.sh; npm test", where, load, root)
        expect(Option.map(picked, ({ remedy }) => remedy)).toEqual(Option.some("shim"))
        const cross = 'if test -n "$CI"; then cd ../beta; git checkout HEAD~1; else npm test; fi'
        const safe = yield* keychainLaunch("sh ./select.sh; npm test", where, () => Effect.succeed(Option.some(cross)), root)
        expect(safe).toEqual(Option.none())
      }),
    ))

  test("walks shell commands and requires positive selection evidence in unwalkable programs", () =>
    scenario(
      Effect.gen(function* () {
        const dir = "/nonexistent/loop-probe-walkable"
        const select = "git switch --detach fixture-old"
        const scripts = {
          [`${dir}/select.sh`]: `#!/bin/sh\n${select}`,
          [`${dir}/select.js`]: `require('node:child_process').execSync('${select}')`,
          [`${dir}/ordinary.js`]: "console.log('ordinary')",
          [`${dir}/opaque.sh`]: "#!/bin/sh\nnode ./select.js",
          [`${dir}/ordinary.sh`]: "#!/bin/sh\nnode ./ordinary.js",
          [`${dir}/inert.sh`]: "#!/bin/sh\nls; echo fixture; git status; true",
        }
        const { call } = yield* start({ home: HOME }, { sessions: { ses_1: dir }, scripts })
        expect(yield* call("shell", { command: select })).toBeUndefined()
        expect(yield* call("shell", { command: `sh -c '${select}'` })).toBeUndefined()
        expect(yield* call("shell", { command: "sh ./select.sh" })).toBeUndefined()
        expect(yield* call("shell", { command: `${select}; sh ./inert.sh; sh -n ./ordinary.sh` })).toBeUndefined()
        expect(yield* call("shell", { command: `${select}; fixture-tool` })).toContain("after selecting another Git revision")
        expect(yield* call("shell", { command: "node ./select.js" })).toContain("Cannot tell what the program runs next in the affected working tree")
        expect(yield* call("shell", { command: "sh ./opaque.sh" })).toContain(`runs ${dir}/select.js. Cannot tell what the program runs next`)
        expect(yield* call("shell", { command: "node ./ordinary.js; sh ./ordinary.sh" })).toBeUndefined()
        expect(yield* call("shell", { command: `${select}; sh ./ordinary.sh` })).toContain("after selecting another Git revision")
      }),
    ))

  test("moving any contiguous block into a readable child preserves the verdict", () =>
    scenario(
      Effect.gen(function* () {
        const trees = ["alpha", "beta", "gamma"]
        const tree = (name: string) => `/nonexistent/loop-probe-inline/${name}`
        const where = { cwd: tree("alpha"), home: HOME }
        const path = `${where.cwd}/driver.sh`
        const orderings = [[0, 1, 2, 3], [2, 0, 3, 1], [1, 3, 2, 0]]
        const ranges = [0, 1, 2, 3].flatMap((from) => [1, 2, 3, 4].flatMap((to) => rangesFrom(from, to)))
        const cases = trees.flatMap((selected) => trees.flatMap((tested) => orderings.map((order) => ({ selected, tested, order }))))
        for (const { selected, tested, order } of cases) {
          const commands = [`(cd ../${selected}; git switch --detach fixture-old)`, "git status -sb", `(cd ../${tested}; npm test)`, "printf '%s\\n' fixture"]
          const ordered = order.map((index) => commands[index])
          const mustRefuse = selected === tested && order.indexOf(0) < order.indexOf(2)
          for (const { from, to } of ranges) {
            const block = ordered.slice(from, to).join("; ")
            const render = (call: string) => [...ordered.slice(0, from), call, ...ordered.slice(to)].join("; ")
            const load = (name: string) => Effect.succeed(Option.liftPredicate(`#!/bin/sh\n${block}`, () => name === path))
            const inline = Option.isSome(yield* keychainLaunch(render(`(${block})`), where, load))
            expect([ordered, from, to, inline]).toEqual([ordered, from, to, mustRefuse])
            for (const invocation of [`sh ${path}`, `bash ${path}`, path]) {
              const moved = Option.isSome(yield* keychainLaunch(render(invocation), where, load))
              expect([ordered, invocation, from, to, moved]).toEqual([ordered, invocation, from, to, inline])
            }
          }
        }
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
        const selected = "git switch --detach fixture-old"
        const paths = yield* start({ home: HOME }, { scripts: { [source("walk.sh")]: `${selected}\nfixture-tool`, [source("only.sh")]: selected, [source("fixture.py")]: "import subprocess\nsubprocess.run(['git', 'switch', '--detach', 'fixture-old'])" } })
        expect(yield* paths.call("shell", { command: `printf '%s\\n' '${source("walk.sh")}' | xargs sh` })).toContain(source("walk.sh"))
        expect(yield* paths.call("shell", { command: `printf '%s\\n' '${source("walk.sh")}' | xargs -I '{}' sh '{}'` })).toContain(source("walk.sh"))
        expect(yield* paths.call("shell", { command: `cat /nonexistent/loop-probe-input | xargs -I '{}' sh ${source("walk.sh")} '{}'` })).toContain(source("walk.sh"))
        expect(yield* paths.call("shell", { command: "cat /nonexistent/loop-probe-input | xargs -I '{}' sh '{}'" })).toBeUndefined()
        expect(yield* paths.call("shell", { command: `cd ${dir} && python3 -m fixture` })).toContain(source("fixture.py"))
        expect(yield* paths.call("shell", { command: `python -c "import os; os.system('git switch --detach fixture-old')"` })).toContain("its inline script")
        expect(yield* paths.call("shell", { command: `python -c "print('git switch --detach fixture-old')"` })).toBeUndefined()
        expect(yield* paths.call("shell", { command: `printf '%s\\n' '${source("only.sh")}' | xargs sh` })).toBeUndefined()
        expect(yield* paths.call("shell", { command: `sh -c '${selected}'` })).toBeUndefined()
        expect(yield* paths.call("shell", { command: `sh -c '${selected}; fixture-tool'` })).toContain("Not a refusal: a command-shape rule.")
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
          "Tool.Error: Refused by guard-destructive: cannot tell where `ls` runs (no session ses_gone); the guard refuses rather than guess.",
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

// guard-no-admission's law: a command OpenCode spawns runs as written. For
// every line of a generated set (plain, heavy-looking, with and without a
// host-admit prefix, nested), no hook of the guard's stands between the call
// and its process, and the process starts in the class of one the test
// spawns untouched: the same niceness and cgroup (no nice launcher, no
// systemd scope), with other commands running beside it.
const WORK = [
  "bun test /nonexistent/loop-probe-x",
  "bun run gate --nonexistent-loop-probe-x",
  "tsc -p /nonexistent/loop-probe-x",
  "go build /nonexistent/loop-probe-x",
  "cargo build --manifest-path /nonexistent/loop-probe-x",
  "vitest run /nonexistent/loop-probe-x",
  "limactl start /nonexistent/loop-probe-x",
  "ls /nonexistent/loop-probe-x",
  "git -C /nonexistent/loop-probe-x status",
]
const FORMS = [
  (line: string) => line,
  (line: string) => `cd -- "$PWD" && ${line}`,
  (line: string) => `host-admit check run --class check --width 4 -- ${line}`,
  (line: string) => `host-admit check run -- sh -c '${line}'`,
  (line: string) => `timeout 30 env A=1 ${line}`,
  (line: string) => `sh -c 'host-admit check run --width 2 -- ${line}'`,
]
const LINES = WORK.flatMap((line) => FORMS.map((form) => form(line)))
// What the started process reports of itself: its niceness and its cgroup.
const REPORT = "ps -o ni= -p $$; cat /proc/self/cgroup 2>/dev/null; true"

describe("the shell", () => {
  test("registers no shell hook: every command OpenCode spawns runs as written, and an older config's limits are ignored", () =>
    scenario(
      Effect.gen(function* () {
        const { shellHooks, call } = yield* start({ home: HOME, heavy: ["make check"], nice: 5, memoryMax: "8G", cpuWeight: 50, launchers: "/nowhere" })
        expect(shellHooks).toEqual({})
        expect(yield* call("shell", { command: "bun test" })).toBeUndefined()
      }),
    ))

  test("every generated line starts at its caller's niceness and cgroup, with others running", () =>
    scenario(
      Effect.gen(function* () {
        const { shellHooks } = yield* start()
        // No hook of the guard's runs before a spawn: OpenCode spawns `<shell> -c <line>` as written.
        expect(Object.keys(shellHooks)).toEqual([])
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        // This tree's host-admit answers the prefixed lines, not the installed one.
        const bin = yield* fs.makeTempDirectoryScoped()
        yield* fs.symlink(yield* path.fromFileUrl(new URL("./host-admit.ts", import.meta.url)), path.join(bin, "host-admit"))
        // Every line runs in an empty folder: a heavy-looking line finds no package, test or module and ends at once.
        const cwd = yield* fs.makeTempDirectoryScoped()
        const env = { PATH: `${bin}:${yield* Config.String("PATH")}` }
        const shell = (line: string) => spawner.string(ChildProcess.make("/bin/sh", ["-c", line], { cwd, env, extendEnv: true, stderr: "ignore", forceKillAfter: "5 seconds" }))
        yield* Effect.forEach(Array.from({ length: 8 }), () => spawner.spawn(ChildProcess.make("sleep", ["20"], { stdout: "ignore", stderr: "ignore", forceKillAfter: "5 seconds" })))
        const untouched = (yield* shell(REPORT)).trim()
        const reports = yield* Effect.forEach(LINES, (line) => shell(`${line}; ${REPORT}`), { concurrency: 8 })
        expect(reports.flatMap((report, i) => Option.toArray(Option.liftPredicate(`${LINES[i]}: ${report.trim()}`, () => !report.trim().endsWith(untouched))))).toEqual([])
      }).pipe(Effect.provide(BunServices.layer)),
    ), hangGuard("process-fixture"))
})
