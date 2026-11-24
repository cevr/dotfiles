// @reads all
// @reads-reason subprocess reads at mods/work/process/command.ts: try: () => Bun.spawn([...argv], { cwd, env: { ...base, ...extra }, stdin: "ignore", stdout: "pi
// The process Rifts' parts that need no `work` binary: how a failed `work` call reads, which base a path tries first,
// and the priority workrift runs at (stubs on PATH). The process Rifts over the real `work` binary are
// tests/work-process.test.ts, an acceptance file: it needs that binary and runs past the unit leg's minute.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { withProcessEnv } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import { check } from "../laws.ts"
import { commands } from "./command.ts"
import * as ProcessWork from "./work.ts"

const PROCESS = withProcessEnv({})

/** Writes `text` to `path`, its folder made first. */
const writer = (run: ReturnType<typeof commands>["run"]) => (path: string, text: string) =>
  run(["sh", "-c", 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', "write", text, path], "/").pipe(Effect.orDie, Effect.asVoid)

test("a failed work call says its tag and JSON (status 1) or that it was a usage error (status 2), never a parse error", () => {
  expect(ProcessWork.failureOf({ code: 1, stdout: '{"_tag":"NameTaken","name":"twice"}\n', stderr: "work: failed; the JSON on standard output says why\n" })).toBe(
    'NameTaken: {"_tag":"NameTaken","name":"twice"}',
  )
  expect(ProcessWork.failureOf({ code: 2, stdout: "", stderr: 'work: unknown command "bogus"\n' })).toBe('usage (exit 2): work: unknown command "bogus"')
  expect(ProcessWork.failureOf({ code: 1, stdout: "not json", stderr: "boom\n" })).toBe("exit 1: boom")
})

test("a path under .work/<name>/ or .rifts/<name>/ tries the base beside it first", () => {
  const bases = ["/a/x", "/b/dotfiles", "/b/opencode"]
  expect(ProcessWork.searchOrder(bases, "/b/.work/dotfiles/feat/src")).toEqual(["/b/dotfiles", "/a/x", "/b/opencode"])
  expect(ProcessWork.searchOrder(bases, "/b/.rifts/opencode/prime-look/.rifts/prime-look/x")).toEqual(["/b/opencode", "/a/x", "/b/dotfiles"])
  expect(ProcessWork.searchOrder(bases, "/c/.work/gone/w")).toEqual(bases)
})

/**
 * A scratch HOME whose PATH holds the workbox's `workrift` and stubs: a `git` that logs the nice it runs
 * at and fails, so each command stops at its first Git call; an `ionice` that logs its class and runs the
 * rest; a `rift` that fails. No `work` and no network, so it runs on any host.
 */
const priorityBench = () =>
  Effect.acquireRelease(
    Effect.sync(() => scratch("workrift-priority-")),
    (held) => Effect.sync(() => held[Symbol.dispose]()),
  ).pipe(
    Effect.flatMap((held) =>
      Effect.gen(function* () {
        const root = (yield* commands().run(["pwd", "-P"], held.path).pipe(Effect.orDie)).trim()
        const bin = `${root}/bin`
        const log = `${root}/log`
        // Empty is unset to workrift: the test's own environment may carry either.
        const env = {
          HOME: `${root}/home`,
          PATH: `${bin}:${PROCESS["PATH"] ?? ""}`,
          GIT_CONFIG_NOSYSTEM: "1",
          WORKRIFT_LOWERED: "",
          WORKRIFT_SOURCE: "",
        }
        const { run, spawn } = commands(env)
        const write = writer(run)
        yield* run(["mkdir", "-p", env.HOME, bin], root).pipe(Effect.orDie)
        // The workbox's own `workrift`, in the checkout the test runs in (from opencode/).
        const top = (yield* commands().run(["git", "rev-parse", "--show-toplevel"], ".").pipe(Effect.orDie)).trim()
        yield* run(["ln", "-s", `${top}/workbox/bin/workrift`, `${bin}/workrift`], root).pipe(Effect.orDie)
        yield* write(`${bin}/ionice`, `#!/bin/sh\nprintf 'ionice %s\\n' "$1" >>'${log}'\nshift\nexec "$@"\n`)
        yield* write(`${bin}/git`, `#!/bin/sh\nprintf 'git %s %s\\n' "$1" "$(ps -o nice= -p $$ | tr -d ' ')" >>'${log}'\nexit 3\n`)
        yield* write(`${bin}/rift`, "#!/bin/sh\nexit 4\n")
        yield* run(["chmod", "755", `${bin}/ionice`, `${bin}/git`, `${bin}/rift`], root).pipe(Effect.orDie)
        return { root, log, run, spawn, write, layer: ProcessWork.layer({ work: "work", workrift: true, env }) }
      }),
    ),
  )

test("workrift's init, create, refresh and deps run at nice 10 and in the idle I/O class; list runs as called", () =>
  check(priorityBench, (made) =>
    Effect.gen(function* () {
      /** What the stubs logged while `workrift <argv>` ran to its failing Git call. */
      const logged = (...argv: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* made.write(made.log, "")
          expect((yield* made.spawn(["workrift", ...argv], made.root).pipe(Effect.orDie)).code).not.toBe(0)
          return (yield* made.run(["cat", made.log], made.root).pipe(Effect.orDie)).trim().split("\n")
        })
      // As `ps` reads it here, the Mac's ceiling 20 and Linux's 19 included.
      const niceUnder = (...prefix: ReadonlyArray<string>) =>
        made.run([...prefix, "/bin/sh", "-c", "ps -o nice= -p $$"], made.root).pipe(Effect.orDie, Effect.map((said) => said.trim()))
      const lowered = yield* niceUnder("nice", "-n", "10")
      expect(yield* logged("init", "/nonexistent/loop-probe-x/repo.git", `${made.root}/source`)).toEqual(["ionice -c3", `git clone ${lowered}`])
      for (const argv of [["create", "feat/x"], ["refresh"], ["deps"]]) expect(yield* logged(...argv)).toEqual(["ionice -c3", `git rev-parse ${lowered}`])
      expect(yield* logged("list")).toEqual([`git rev-parse ${yield* niceUnder()}`])
    }),
  ))
