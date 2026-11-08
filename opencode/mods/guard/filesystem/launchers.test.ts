// Launchers in a scratch directory: a written launcher runs its shell at the
// lower priority with the command's arguments, its path is stable for one
// script and new for another, and a directory it cannot write is
// LauncherUnavailable.
import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { launcherScript, systemdRunScript } from "../launcher.ts"
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
  const script = launcherScript({ shell: "/bin/sh", limits: { nice: 10, memoryMax: "12G", cpuWeight: 20 }, scope: false })
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

test("behind the launcher, a command's own systemd-run gives its unit the limits, ahead of the caller's options", async () => {
  const limits = { nice: 10, memoryMax: "12G", cpuWeight: 20 }
  const shim = await install(scratch, "systemd-run", systemdRunScript(limits))
  // The real systemd-run, later on the PATH: it prints the arguments it gets.
  const real = join(scratch, "real")
  mkdirSync(real)
  writeFileSync(join(real, "systemd-run"), '#!/bin/sh\nprintf "%s " "$@"\n')
  chmodSync(join(real, "systemd-run"), 0o755)
  const launcher = await install(scratch, "sh", launcherScript({ shell: "/bin/sh", limits, scope: false, systemdRun: shim }))
  const run = (command: string, path: string) =>
    Bun.spawnSync([launcher, "-c", command], { stdout: "pipe", stderr: "pipe", env: { PATH: path } })
  const out = (command: string) => run(command, `${real}:/usr/bin:/bin`).stdout.toString().trim()

  expect(out("systemd-run --user --wait --pipe -p MemoryMax=8G go test ./...")).toBe(
    "-p Nice=10 -p MemoryMax=12G -p CPUWeight=20 --user --wait --pipe -p MemoryMax=8G go test ./...",
  )
  // A scope refuses `Nice`, and keeps the launcher's nice by itself.
  expect(out("systemd-run --user --scope -- go test ./...")).toBe("-p MemoryMax=12G -p CPUWeight=20 --user --scope -- go test ./...")
  // The command may put the guard's directory on its PATH again: the shim still finds the real one, not itself.
  expect(out(`PATH=${dirname(shim)}:$PATH systemd-run --user true`)).toBe("-p Nice=10 -p MemoryMax=12G -p CPUWeight=20 --user true")
  const alone = Bun.spawnSync([shim, "--user", "true"], { stdout: "pipe", stderr: "pipe", env: { PATH: dirname(shim) } })
  expect([alone.exitCode, alone.stderr.toString().trim()]).toEqual([127, "systemd-run: not found on PATH"])
})

test("a directory it cannot write is LauncherUnavailable", async () => {
  const locked = join(scratch, "locked")
  mkdirSync(locked)
  chmodSync(locked, 0o500)
  const error = await Effect.runPromise(Effect.flip(installing(locked, "sh", "#!/bin/sh\n")))
  chmodSync(locked, 0o700)
  expect(error).toBeInstanceOf(LauncherUnavailable)
})
