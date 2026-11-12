// The process Rifts over the real `rift` CLI and Git, in a scratch HOME (so
// Rift's registry is the test's own) holding a warm source with a bare
// origin. With `workrift: true` it runs the workbox's own script
// (workbox/bin/workrift) with a no-op `flock`, which macOS lacks. Rift needs
// copy-on-write (APFS here), so these run on macOS only.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "bun:test"
import { Effect } from "effect"
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
}
process.exit(ran.exitCode)
`

/** A warm source with three packs and a multi-pack index naming them, whose `rift` drops the newest pack (the one holding HEAD) from each copy. */
const droppingBench = Effect.acquireRelease(
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
    sh(source, base, "git", "config", "maintenance.auto", "false")
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
    const env = { ...base, REAL_RIFT: REAL_RIFT ?? "rift", DROP_PACK: newest }
    sh(source, env, "git", "multi-pack-index", "write")
    sh(source, env, "rift", "init", "--here")
    return { scratch, env, newest, source: sh(source, env, "pwd", "-P").trim(), layer: ProcessRifts.layer({ workrift: false, env }) }
  }),
  (made) => Effect.sync(() => rmSync(made.scratch, { recursive: true, force: true })),
)

if (runnable) {
  riftsLaws("process Rifts on rift", () => bench(false), 30_000)
  riftsLaws("process Rifts on workrift", () => bench(true), 30_000)
  test(
    "a pack the source's multi-pack index names and the copy dropped is in the new Rift, which reads every object",
    () =>
      check(
        () => droppingBench,
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
} else test.skip("the process Rifts need macOS and the rift CLI", () => {})
