// The process Rifts over the real `rift` CLI and Git, in a scratch HOME (so
// Rift's registry is the test's own) holding a warm source with a bare
// origin. With `workrift: true` it runs the workbox's own script
// (workbox/bin/workrift) with a no-op `flock`, which macOS lacks. Rift needs
// copy-on-write (APFS here), so these run on macOS only.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { quietRepo } from "../../../tests/git-repo.ts"
import { check, riftsLaws } from "../laws.ts"
import { Rifts } from "../service.ts"
import * as ProcessRifts from "./rifts.ts"

const WORKRIFT = resolve(import.meta.dir, "../../../../workbox/bin/workrift")
const REAL_RIFT = Bun.which("rift")
const runnable = process.platform === "darwin" && REAL_RIFT !== null

const sh = (cwd: string, env: Record<string, string>, ...argv: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([...argv], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  if (ran.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${ran.stderr.toString()}`)
  return ran.stdout.toString()
}

/** The commands' environment in `scratch`: its own HOME (made here), `bin` first on PATH, and a fixed Git identity. */
const scratchEnv = (scratch: string, bin: string) => {
  const env = {
    HOME: join(scratch, "home"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GIT_AUTHOR_NAME: "Rift Test",
    GIT_AUTHOR_EMAIL: "rift@example.invalid",
    GIT_COMMITTER_NAME: "Rift Test",
    GIT_COMMITTER_EMAIL: "rift@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
  }
  mkdirSync(env.HOME)
  return env
}

/** A scratch HOME with a warm source `code/app` (one commit, pushed to a bare origin), removed after the test. */
const bench = (workrift: boolean) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const scratch = mkdtempSync(join(tmpdir(), "rift-process-"))
      const bin = join(scratch, "bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 0\n")
      chmodSync(join(bin, "flock"), 0o755)
      symlinkSync(WORKRIFT, join(bin, "workrift"))
      const env = scratchEnv(scratch, bin)
      const origin = join(scratch, "origin.git")
      const source = join(scratch, "code/app")
      mkdirSync(join(source, "src"), { recursive: true })
      sh(scratch, env, "git", "init", "-q", "--bare", "-b", "main", origin)
      sh(source, env, "git", "init", "-q", "-b", "main")
      quietRepo(origin)
      quietRepo(source)
      writeFileSync(join(source, "README.md"), "app\n")
      writeFileSync(join(source, "src/index.ts"), "export {}\n")
      sh(source, env, "git", "add", "README.md", "src/index.ts")
      sh(source, env, "git", "commit", "-q", "-m", "init")
      sh(source, env, "git", "remote", "add", "origin", origin)
      sh(source, env, "git", "push", "-q", "-u", "origin", "main")
      sh(source, env, "git", "remote", "set-head", "origin", "--auto")
      sh(source, env, "rift", "init", "--here")
      const plain = join(scratch, "plain")
      mkdirSync(plain)
      return {
        scratch,
        layer: ProcessRifts.layer({ workrift, env }),
        source: sh(source, env, "pwd", "-P").trim(),
        inside: join(source, "src"),
        plain,
        commit: (path: string) => Effect.sync(() => void sh(path, env, "git", "commit", "-q", "--allow-empty", "-m", "only here")),
        dirty: (path: string) => Effect.sync(() => writeFileSync(join(path, "scratch.txt"), "unsaved\n")),
        stash: (path: string) =>
          Effect.sync(() => {
            writeFileSync(join(path, "README.md"), `stashed in ${path}\n`)
            sh(path, env, "git", "stash", "push", "-q", "-m", "wip")
          }),
        switchTo: (path: string, branch: string) => Effect.sync(() => void sh(path, env, "git", "switch", "-q", "-c", branch)),
      }
    }),
    (made) => Effect.sync(() => rmSync(made.scratch, { recursive: true, force: true })),
  )

/**
 * A `rift` that copies as the real one (`REAL_RIFT`) does, then drops the new Rift's files of the pack
 * `DROP_PACK` names: what the APFS copy of the dotfiles' warm source did on 2026-11-12, again and again.
 * With `REPACK_SOURCE` "true", the warm source at `SOURCE` then folds every pack into one (as a gc does)
 * before the tool's repair reads it, so the pack the copy's multi-pack index names is found nowhere.
 */
const DROPPING_RIFT = `#!/usr/bin/env bun
import { readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
const ran = Bun.spawnSync([process.env.REAL_RIFT, ...process.argv.slice(2)], { stdout: "pipe", stderr: "inherit" })
const out = ran.stdout.toString()
process.stdout.write(out)
if (ran.exitCode === 0 && process.argv[2] === "create") {
  const pack = join(out.trim().split("\\n").at(-1), ".git/objects/pack")
  for (const file of readdirSync(pack)) if (file.startsWith(process.env.DROP_PACK)) unlinkSync(join(pack, file))
  if (process.env.REPACK_SOURCE === "true") {
    for (const argv of [["repack", "-a", "-d", "-q"], ["multi-pack-index", "write", "--no-progress"]]) {
      if (Bun.spawnSync(["git", "-C", process.env.SOURCE, ...argv], { stdout: "inherit", stderr: "inherit" }).exitCode !== 0) process.exit(9)
    }
  }
}
process.exit(ran.exitCode)
`

/**
 * A warm source with four packs and a multi-pack index naming them, whose `rift` drops the newest pack (the
 * one holding HEAD) from each copy; with `repack`, the source then repacks it away before the repair.
 */
const droppingBench = (repack: boolean) => Effect.acquireRelease(
  Effect.sync(() => {
    const scratch = mkdtempSync(join(tmpdir(), "rift-packs-"))
    const bin = join(scratch, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "rift"), DROPPING_RIFT)
    chmodSync(join(bin, "rift"), 0o755)
    const source = join(scratch, "code/app")
    mkdirSync(source, { recursive: true })
    const base = scratchEnv(scratch, bin)
    sh(source, base, "git", "init", "-q", "-b", "main")
    // No background maintenance: it would fold the packs into one while the test reads them.
    quietRepo(source)
    const packs = () => readdirSync(join(source, ".git/objects/pack")).filter((file) => file.endsWith(".pack"))
    for (const n of [1, 2, 3]) {
      writeFileSync(join(source, `file-${n}.txt`), `${n}\n`)
      sh(source, base, "git", "add", `file-${n}.txt`)
      sh(source, base, "git", "commit", "-q", "-m", `commit ${n}`)
      sh(source, base, "git", "repack", "-q")
    }
    const before = new Set(packs())
    writeFileSync(join(source, "file-4.txt"), "4\n")
    sh(source, base, "git", "add", "file-4.txt")
    sh(source, base, "git", "commit", "-q", "-m", "commit 4")
    sh(source, base, "git", "repack", "-q")
    const newest = packs()
      .filter((file) => !before.has(file))
      .map((file) => file.slice(0, -".pack".length))
      .join(" ")
    const real = sh(source, base, "pwd", "-P").trim()
    const env = { ...base, REAL_RIFT: REAL_RIFT ?? "rift", DROP_PACK: newest, SOURCE: real, REPACK_SOURCE: String(repack) }
    sh(source, env, "git", "multi-pack-index", "write")
    sh(source, env, "rift", "init", "--here")
    return { scratch, env, newest, source: real, layer: ProcessRifts.layer({ workrift: false, env }) }
  }),
  (made) => Effect.sync(() => rmSync(made.scratch, { recursive: true, force: true })),
)

/**
 * A scratch HOME whose PATH holds the workbox's `workrift` and stubs: a `git` that logs the nice it runs
 * at and fails, so each command stops at its first Git call; an `ionice` that logs its class and runs the
 * rest; a `rift` that fails. No Rift and no network, so it runs on any host.
 */
const priorityBench = () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const scratch = mkdtempSync(join(tmpdir(), "workrift-priority-"))
      const bin = join(scratch, "bin")
      mkdirSync(bin)
      symlinkSync(WORKRIFT, join(bin, "workrift"))
      const log = join(scratch, "log")
      writeFileSync(join(bin, "ionice"), `#!/bin/sh\nprintf 'ionice %s\\n' "$1" >>'${log}'\nshift\nexec "$@"\n`)
      writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'git %s %s\\n' "$1" "$(ps -o nice= -p $$ | tr -d ' ')" >>'${log}'\nexit 3\n`)
      writeFileSync(join(bin, "rift"), "#!/bin/sh\nexit 4\n")
      for (const stub of ["ionice", "git", "rift"]) chmodSync(join(bin, stub), 0o755)
      // Empty is unset to workrift: the test's own environment may carry either.
      const env = { ...scratchEnv(scratch, bin), WORKRIFT_LOWERED: "", WORKRIFT_SOURCE: "" }
      return { scratch, env, log, workrift: join(bin, "workrift"), layer: ProcessRifts.layer({ workrift: true, env }) }
    }),
    (made) => Effect.sync(() => rmSync(made.scratch, { recursive: true, force: true })),
  )

test("workrift's init, create, refresh and deps run at nice 10 and in the idle I/O class; list runs as called", () =>
  check(priorityBench, (made) =>
    Effect.sync(() => {
      /** What the stubs logged while `workrift <argv>` ran to its failing Git call. */
      const logged = (...argv: ReadonlyArray<string>) => {
        writeFileSync(made.log, "")
        expect(() => sh(made.scratch, made.env, made.workrift, ...argv)).toThrow()
        return readFileSync(made.log, "utf8").trim().split("\n")
      }
      // As `ps` reads it here, the Mac's ceiling 20 and Linux's 19 included.
      const niceUnder = (...prefix: ReadonlyArray<string>) => sh(made.scratch, made.env, ...prefix, "/bin/sh", "-c", "ps -o nice= -p $$").trim()
      const lowered = niceUnder("nice", "-n", "10")
      expect(logged("init", "/nonexistent/loop-probe-x/repo.git", join(made.scratch, "source"))).toEqual(["ionice -c3", `git clone ${lowered}`])
      for (const argv of [["create", "feat/x"], ["refresh"], ["deps"]]) expect(logged(...argv)).toEqual(["ionice -c3", `git rev-parse ${lowered}`])
      expect(logged("list")).toEqual([`git rev-parse ${niceUnder()}`])
    }),
  ))

if (runnable) {
  riftsLaws("process Rifts on rift", () => bench(false), 30_000)
  riftsLaws("process Rifts on workrift", () => bench(true), 30_000)
  test(
    "a pack the source's multi-pack index names and the copy dropped is in the new Rift, which reads every object",
    () =>
      check(
        () => droppingBench(false),
        (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            const path = yield* rifts.create({ source: made.source, from: made.source, name: "packed", branch: "packed" })
            expect(readdirSync(join(path, ".git/objects/pack"))).toEqual(expect.arrayContaining([`${made.newest}.idx`, `${made.newest}.pack`]))
            sh(path, made.env, "git", "multi-pack-index", "verify", "--no-progress")
            expect(sh(path, made.env, "git", "log", "--format=%s").trim().split("\n")).toEqual(["commit 4", "commit 3", "commit 2", "commit 1"])
            sh(path, made.env, "git", "rev-list", "--objects", "--all")
          }),
      ),
    30_000,
  )
  test(
    "a multi-pack index naming a pack the copy dropped and the source has since repacked away is written again from the packs there are",
    () =>
      check(
        () => droppingBench(true),
        (made) =>
          Effect.gen(function* () {
            const rifts = yield* Rifts
            const path = yield* rifts.create({ source: made.source, from: made.source, name: "repacked", branch: "repacked" })
            expect(readdirSync(join(path, ".git/objects/pack")).filter((file) => file.startsWith(made.newest))).toEqual([])
            sh(path, made.env, "git", "multi-pack-index", "verify", "--no-progress")
            sh(path, made.env, "git", "fsck", "--connectivity-only")
            expect(sh(path, made.env, "git", "log", "--format=%s").trim().split("\n")).toEqual(["commit 4", "commit 3", "commit 2", "commit 1"])
          }),
      ),
    30_000,
  )
} else test.skip("the process Rifts need macOS and the rift CLI", () => {})
