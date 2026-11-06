// The process Landing over real Git repositories in a scratch directory: a
// bare origin, a warm source, an integration clone and two Rift clones on
// their branches. The lock file is a Bun workspace's, so installs need no
// network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Landing } from "../service.ts"
import * as ProcessLanding from "./landing.ts"

const ENV = {
  GIT_AUTHOR_NAME: "Rift Test",
  GIT_AUTHOR_EMAIL: "rift@example.invalid",
  GIT_COMMITTER_NAME: "Rift Test",
  GIT_COMMITTER_EMAIL: "rift@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

const scratches: Array<string> = []
afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true })
})

const sh = (cwd: string, ...argv: ReadonlyArray<string>): string => {
  const ran = Bun.spawnSync([...argv], { cwd, env: { ...process.env, ...ENV }, stdout: "pipe", stderr: "pipe" })
  if (ran.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

const write = (root: string, file: string, text: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true })
  writeFileSync(join(root, file), text)
}

/** A Bun workspace package `pkgs/<name>`, its lock file and the generated list, committed on the branch checked out in `root`. */
const addPackage = (root: string, name: string) => {
  write(root, `pkgs/${name}/package.json`, JSON.stringify({ name, version: "1.0.0" }))
  sh(root, "bun", "install")
  sh(root, "sh", "-c", "ls pkgs > gen.txt")
  sh(root, "git", "add", "-A")
  sh(root, "git", "commit", "-q", "-m", `add ${name}`)
}

const bench = () => {
  const scratch = mkdtempSync(join(tmpdir(), "rift-landing-"))
  scratches.push(scratch)
  const origin = join(scratch, "origin.git")
  const source = join(scratch, "app")
  sh(scratch, "git", "init", "-q", "--bare", "-b", "main", origin)
  sh(scratch, "git", "clone", "-q", origin, source)
  write(source, "package.json", JSON.stringify({ name: "app", private: true, workspaces: ["pkgs/*"] }))
  write(source, ".gitignore", "node_modules\n")
  write(source, "README.md", "app\n")
  addPackage(source, "a")
  sh(source, "git", "push", "-q", "-u", "origin", "main")
  sh(source, "git", "remote", "set-head", "origin", "main")
  const clone = (name: string, branch: string) => {
    const path = join(scratch, name)
    sh(scratch, "git", "clone", "-q", origin, path)
    sh(path, "git", "checkout", "-q", "-b", branch)
    return path
  }
  const integration = clone("integrate", "integrate")
  const x = clone("feat-x", "feat/x")
  const y = clone("feat-y", "feat/y")
  const settings = { main: "main", gate: undefined, accept: undefined, generated: ["gen.txt"], regenerate: "ls pkgs > gen.txt", push: true, pushBranches: false }
  const run = <A, E>(use: (landing: typeof Landing.Service) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(Landing, use).pipe(Effect.provide(ProcessLanding.layer({ logs: join(scratch, "logs"), env: ENV }))))
  return { scratch, origin, source, integration, x, y, settings, run }
}

describe("process Landing", () => {
  test("config reads the warm source's Git config, the default branch from origin's HEAD", async () => {
    const made = bench()
    sh(made.source, "git", "config", "rift.gate", "bun run gate")
    sh(made.source, "git", "config", "--add", "rift.generated", "gen.txt")
    sh(made.source, "git", "config", "--add", "rift.generated", "other.json")
    sh(made.source, "git", "config", "rift.regenerate", "ls pkgs > gen.txt")
    expect(await made.run((landing) => landing.config(made.source))).toEqual({
      main: "main",
      gate: "bun run gate",
      accept: undefined,
      generated: ["gen.txt", "other.json"],
      regenerate: "ls pkgs > gen.txt",
      push: true,
      pushBranches: false,
    })
    sh(made.source, "git", "config", "workrift.main", "trunk")
    // A repository that lands through pull requests: Git's own booleans.
    sh(made.source, "git", "config", "rift.push", "no")
    sh(made.source, "git", "config", "rift.pushBranches", "on")
    expect(await made.run((landing) => landing.config(made.source))).toMatchObject({ main: "trunk", push: false, pushBranches: true })
    sh(made.source, "git", "config", "rift.push", "maybe")
    expect((await made.run((landing) => Effect.flip(landing.config(made.source)))).message).toContain("rift.push")
  })

  test("pushBranch sends a Rift's branch to the same branch on origin, never forced", async () => {
    const made = bench()
    addPackage(made.x, "b")
    const pushed = await made.run((landing) => landing.pushBranch({ path: made.x, branch: "feat/x" }))
    expect(pushed).toEndWith(" add b")
    expect(sh(made.origin, "git", "rev-parse", "feat/x")).toBe(sh(made.x, "git", "rev-parse", "HEAD"))
    // The branch on origin moved on; a rewritten local branch is refused, not forced over it.
    write(made.y, "y.txt", "y\n")
    sh(made.y, "git", "add", "y.txt")
    sh(made.y, "git", "commit", "-q", "-m", "y")
    const refused = await made.run((landing) => Effect.flip(landing.pushBranch({ path: made.y, branch: "feat/x" })))
    expect(refused.message).toContain("rejected")
    expect(sh(made.origin, "git", "rev-parse", "feat/x")).toBe(sh(made.x, "git", "rev-parse", "HEAD"))
  })

  test("merges each branch onto origin's main; a conflict in the lock file and the generated files alone is written again and committed", async () => {
    const made = bench()
    addPackage(made.x, "b")
    addPackage(made.y, "c")
    const merged = await made.run((landing) =>
      Effect.gen(function* () {
        const started = yield* landing.start(made.integration, "main")
        const first = yield* landing.merge(made.integration, { path: made.x, branch: "feat/x" }, made.settings)
        const second = yield* landing.merge(made.integration, { path: made.y, branch: "feat/y" }, made.settings)
        return { started, first, second }
      }),
    )
    expect(merged.started.base).toBe(sh(made.source, "git", "rev-parse", "HEAD"))
    expect(merged.first).toEqual({ _tag: "Merged", regenerated: [] })
    expect(merged.second).toEqual({ _tag: "Merged", regenerated: ["bun.lock", "gen.txt"] })
    expect(readFileSync(join(made.integration, "gen.txt"), "utf8")).toBe("a\nb\nc\n")
    const lock = readFileSync(join(made.integration, "bun.lock"), "utf8")
    expect(lock).toContain('"pkgs/b"')
    expect(lock).toContain('"pkgs/c"')
    expect(sh(made.integration, "git", "status", "--porcelain", "--untracked-files=no")).toBe("")
    expect(sh(made.integration, "git", "log", "-1", "--format=%s")).toBe("Merge feat/y")
  })

  test("a clean merge that leaves a generated file stale ends with it regenerated and committed; nothing to write commits nothing", async () => {
    const made = bench()
    // The Rift adds a package but never writes gen.txt again, so the merge is clean and gen.txt stale.
    write(made.x, "pkgs/b/package.json", JSON.stringify({ name: "b", version: "1.0.0" }))
    sh(made.x, "bun", "install")
    sh(made.x, "git", "add", "-A")
    sh(made.x, "git", "commit", "-q", "-m", "add b, gen.txt stale")
    const landed = await made.run((landing) =>
      Effect.gen(function* () {
        const started = yield* landing.start(made.integration, "main")
        const merged = yield* landing.merge(made.integration, { path: made.x, branch: "feat/x" }, made.settings)
        const locks = yield* landing.install(made.integration, started.previous)
        const regenerated = yield* landing.regenerate(made.integration, made.settings)
        const again = yield* landing.regenerate(made.integration, made.settings)
        return { merged, locks, regenerated, again }
      }),
    )
    expect(landed).toEqual({ merged: { _tag: "Merged", regenerated: [] }, locks: [], regenerated: ["gen.txt"], again: [] })
    expect(readFileSync(join(made.integration, "gen.txt"), "utf8")).toBe("a\nb\n")
    expect(sh(made.integration, "git", "log", "-2", "--format=%s")).toBe("chore: regenerate generated files after landing\nadd b, gen.txt stale")
    expect(sh(made.integration, "git", "status", "--porcelain", "--untracked-files=no")).toBe("")
    const failed = await made.run((landing) => Effect.flip(landing.regenerate(made.integration, { ...made.settings, regenerate: "echo cannot write >&2; exit 4" })))
    expect(failed.message).toBe("cannot write")
  })

  test("any other conflict aborts the merge and answers its files", async () => {
    const made = bench()
    write(made.x, "README.md", "x\n")
    sh(made.x, "git", "commit", "-q", "-am", "x")
    write(made.y, "README.md", "y\n")
    sh(made.y, "git", "commit", "-q", "-am", "y")
    const merged = await made.run((landing) =>
      Effect.gen(function* () {
        yield* landing.start(made.integration, "main")
        yield* landing.merge(made.integration, { path: made.x, branch: "feat/x" }, made.settings)
        return yield* landing.merge(made.integration, { path: made.y, branch: "feat/y" }, made.settings)
      }),
    )
    expect(merged).toEqual({ _tag: "Conflict", files: ["README.md"] })
    expect(sh(made.integration, "git", "status", "--porcelain", "--untracked-files=no")).toBe("")
    expect(readFileSync(join(made.integration, "README.md"), "utf8")).toBe("x\n")
  })

  test("start resets the integration Rift to origin's newest main, and a new batch reinstalls lock files changed since its last commit", async () => {
    const made = bench()
    const old = sh(made.integration, "git", "rev-parse", "HEAD")
    addPackage(made.source, "d")
    write(made.source, "README.md", "next\n")
    sh(made.source, "git", "commit", "-q", "-am", "next")
    sh(made.source, "git", "push", "-q", "origin", "main")
    // The last gate rewrote a tracked file the new main changes too (a lint fix); start drops it.
    write(made.integration, "README.md", "fixed by the gate\n")
    const started = await made.run((landing) => landing.start(made.integration, "main"))
    expect(started).toEqual({ base: sh(made.source, "git", "rev-parse", "HEAD"), previous: old })
    expect(sh(made.integration, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe("integrate")
    expect(readFileSync(join(made.integration, "README.md"), "utf8")).toBe("next\n")
    // The lock file matches its packages, so the install leaves it and commits nothing.
    expect(await made.run((landing) => landing.install(made.integration, started.previous))).toEqual([])
  })

  test("check keeps the command's output in a log and never fails on its exit code", async () => {
    const made = bench()
    const ran = await made.run((landing) => landing.check(made.integration, "gate", 'echo " 3 pass"; echo oops >&2; [ "$RIFT_LAND_BASE" = b0 ] && exit 3', { RIFT_LAND_BASE: "b0" }))
    expect(ran.code).toBe(3)
    expect(ran.log).toBe(join(made.scratch, "logs", "integrate.gate.log"))
    expect(ran.output).toBe(" 3 pass\noops\n")
  })

  test("the gate and acceptance run always go through the guard's launcher: niced, and in a scope under MemoryMax=12G on systemd", () => {
    expect(ProcessLanding.checkArgv("bun run gate", "/l/gate.log", false)).toEqual(["nice", "-n", "10", "sh", "-c", 'sh -c "$1" >"$2" 2>&1', "rift-land", "bun run gate", "/l/gate.log"])
    expect(ProcessLanding.checkArgv("bun run gate", "/l/gate.log", true)).toEqual([
      "nice", "-n", "10",
      "systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=12G", "-p", "CPUWeight=20", "--",
      "sh", "-c", 'sh -c "$1" >"$2" 2>&1', "rift-land", "bun run gate", "/l/gate.log",
    ])
  })

  /** One check of `command` in a bare scratch directory, under the layer's `options`. */
  const checkIn = (options: Partial<ProcessLanding.Options>, command: string) => {
    const scratch = mkdtempSync(join(tmpdir(), "rift-check-"))
    scratches.push(scratch)
    const layer = ProcessLanding.layer({ logs: join(scratch, "logs"), ...options })
    return { scratch, ran: Effect.runPromise(Effect.flatMap(Landing, (landing) => landing.check(scratch, "gate", command, {})).pipe(Effect.provide(layer))) }
  }

  test("on the Mac a check runs niced alone, ten more than the caller", async () => {
    const own = Number(sh(tmpdir(), "sh", "-c", "ps -o nice= -p $$"))
    const { ran } = checkIn({ platform: "darwin", probe: ["/nonexistent/loop-probe-x"] }, "ps -o nice= -p $$")
    expect(Number((await ran).output.trim())).toBe(Math.min(process.platform === "darwin" ? 20 : 19, own + 10))
  })

  test("on a systemd host a check runs in a user scope with its limits; a failed probe runs it niced alone", async () => {
    // A stand-in systemd-run on PATH records its arguments and runs the command after `--`.
    const bin = mkdtempSync(join(tmpdir(), "rift-systemd-"))
    scratches.push(bin)
    write(bin, "systemd-run", '#!/bin/sh\necho "$@" > "$(dirname "$0")/asked"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n')
    sh(bin, "chmod", "755", join(bin, "systemd-run"))
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` }

    const scoped = checkIn({ platform: "linux", probe: ["true"], env }, "echo ran")
    expect((await scoped.ran).output).toBe("ran\n")
    expect(readFileSync(join(bin, "asked"), "utf8")).toBe(`--user --scope --quiet --collect -p MemoryMax=12G -p CPUWeight=20 -- sh -c sh -c "$1" >"$2" 2>&1 rift-land echo ran ${join(scoped.scratch, "logs", `${basename(scoped.scratch)}.gate.log`)}\n`)

    rmSync(join(bin, "asked"))
    const refused = checkIn({ platform: "linux", probe: ["false"], env }, "echo ran")
    expect((await refused.ran).output).toBe("ran\n")
    expect(existsSync(join(bin, "asked"))).toBe(false)
  })

  test("push sends HEAD to main when it holds origin's newest main, and refuses when main moved", async () => {
    const made = bench()
    addPackage(made.x, "b")
    const pushed = await made.run((landing) =>
      Effect.gen(function* () {
        yield* landing.start(made.integration, "main")
        yield* landing.merge(made.integration, { path: made.x, branch: "feat/x" }, made.settings)
        return yield* landing.push(made.integration, "main")
      }),
    )
    expect(pushed).toEndWith(" add b")
    expect(sh(made.origin, "git", "rev-parse", "main")).toBe(sh(made.integration, "git", "rev-parse", "HEAD"))
    // Another push lands first; the batch must merge it before pushing.
    write(made.source, "README.md", "moved\n")
    sh(made.source, "git", "commit", "-q", "-am", "moved")
    sh(made.source, "git", "pull", "-q", "--no-rebase", "origin", "main")
    sh(made.source, "git", "push", "-q", "origin", "main")
    write(made.integration, "late.txt", "late\n")
    sh(made.integration, "git", "add", "late.txt")
    sh(made.integration, "git", "commit", "-q", "-m", "late")
    const refused = await made.run((landing) => Effect.flip(landing.push(made.integration, "main")))
    expect(refused.message).toBe("origin/main moved while the gate ran; land the batch again to merge it first.")
  })

  test("ownChanges leaves out a change the warm source holds too, and sync makes a landed branch read as pushed", async () => {
    const made = bench()
    write(made.source, "private.toml", "mine\n")
    write(made.x, "private.toml", "mine\n")
    write(made.x, "work.ts", "x\n")
    expect(await made.run((landing) => landing.ownChanges(made.x, made.source))).toEqual(["?? work.ts"])
    sh(made.x, "git", "push", "-q", "origin", "feat/x")
    await made.run((landing) => landing.sync(made.x))
    expect(sh(made.x, "git", "rev-parse", "origin/feat/x")).toBe(sh(made.x, "git", "rev-parse", "HEAD"))
  })
})
