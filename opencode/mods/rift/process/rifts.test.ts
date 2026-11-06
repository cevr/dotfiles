// The process Rifts over the real `rift` CLI and Git, in a scratch HOME (so
// Rift's registry is the test's own) holding a warm source with a bare
// origin. With `workrift: true` it runs the workbox's own script
// (workbox/bin/workrift) with a no-op `flock`, which macOS lacks. Rift needs
// copy-on-write (APFS here), so these run on macOS only.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "bun:test"
import { Effect } from "effect"
import { riftsLaws } from "../laws.ts"
import * as ProcessRifts from "./rifts.ts"

const WORKRIFT = resolve(import.meta.dir, "../../../../workbox/bin/workrift")
const runnable = process.platform === "darwin" && Bun.which("rift") !== null

const sh = (cwd: string, env: Record<string, string>, ...argv: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([...argv], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  if (ran.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${ran.stderr.toString()}`)
  return ran.stdout.toString()
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
      }
    }),
    (made) => Effect.sync(() => rmSync(made.scratch, { recursive: true, force: true })),
  )

if (runnable) {
  riftsLaws("process Rifts on rift", () => bench(false), 30_000)
  riftsLaws("process Rifts on workrift", () => bench(true), 30_000)
} else test.skip("the process Rifts need macOS and the rift CLI", () => {})
