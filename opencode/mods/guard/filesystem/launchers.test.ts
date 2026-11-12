// Launchers in a scratch directory: a written launcher runs its shell at the
// lower priority with the command's arguments, its path is stable for one
// script and new for another, and a directory it cannot write is
// LauncherUnavailable.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { launcherScript } from "../launcher.ts"
import { Launchers, LauncherUnavailable } from "../service.ts"
import * as FilesystemLaunchers from "./launchers.ts"

const scratch = mkdtempSync(join(tmpdir(), "guard-launchers-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const installing = (dir: string, name: string, script: string) =>
  Effect.gen(function* () {
    return yield* (yield* Launchers).install(name, script)
  }).pipe(Effect.provide(FilesystemLaunchers.layer(dir)))
const install = (dir: string, name: string, script: string) => Effect.runPromise(installing(dir, name, script))

const niceOf = (argv: ReadonlyArray<string>) => Number(Bun.spawnSync([...argv], { stdout: "pipe" }).stdout.toString().trim())

test("a launcher runs its shell with the command, at the lower priority", async () => {
  const script = launcherScript({ shell: "/bin/sh", limits: { nice: 10, memoryMax: "12G", cpuWeight: 20 }, scope: false, ionice: false })
  const path = await install(scratch, "sh", script)
  expect(path).toEndWith("/sh")
  expect(readFileSync(path, "utf8")).toBe(script)
  const base = niceOf(["/bin/sh", "-c", "ps -o nice= -p $$"])
  // The test may itself run niced: the Mac's `ps` reads the ceiling as 20, Linux's as 19.
  expect(niceOf([path, "-c", "ps -o nice= -p $$"])).toBe(Math.min(process.platform === "darwin" ? 20 : 19, base + 10))
  expect(Bun.spawnSync([path, "-c", 'printf "%s|%s" "$0" "$1"', "zero", "one two"], { stdout: "pipe" }).stdout.toString()).toBe("zero|one two")
  expect(await install(scratch, "sh", script)).toBe(path)
  expect(await install(scratch, "sh", script.replace("nice -n 10", "nice -n 5"))).not.toBe(path)
})

test("a directory it cannot write is LauncherUnavailable", async () => {
  const locked = join(scratch, "locked")
  mkdirSync(locked)
  chmodSync(locked, 0o500)
  const error = await Effect.runPromise(Effect.flip(installing(locked, "sh", "#!/bin/sh\n")))
  chmodSync(locked, 0o700)
  expect(error).toBeInstanceOf(LauncherUnavailable)
})
