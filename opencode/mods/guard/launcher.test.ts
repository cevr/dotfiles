// A launcher's text: the shell it execs, under nice alone or in a scope with
// its limits. filesystem/launchers.test.ts runs one.
import { expect, test } from "bun:test"
import { DEFAULT_LIMITS, heavyArgv, launcherName, launcherScript, systemdRunScript } from "./launcher.ts"

const limits = { nice: 10, memoryMax: "12G", cpuWeight: 20 }

test("an argv runs niced off systemd, and in a user scope with its limits on systemd", () => {
  expect(DEFAULT_LIMITS).toEqual(limits)
  expect(heavyArgv(["sh", "-c", "bun test"], limits, false)).toEqual(["nice", "-n", "10", "sh", "-c", "bun test"])
  expect(heavyArgv(["sh", "-c", "bun test"], limits, true)).toEqual([
    "nice", "-n", "10",
    "systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=12G", "-p", "CPUWeight=20", "--",
    "sh", "-c", "bun test",
  ])
})

test("off systemd, the shell runs at the lower priority", () => {
  expect(launcherScript({ shell: "/bin/zsh", limits, scope: false })).toBe(
    "#!/bin/sh\n# Written by the OpenCode guard plugin (mods/guard/launcher.ts): runs /bin/zsh for a heavy command at nice 10.\nexec nice -n 10 '/bin/zsh' \"$@\"\n",
  )
})

test("with systemd, the shell runs in a user scope with its memory cap and CPU weight", () => {
  expect(launcherScript({ shell: "/usr/bin/zsh", limits, scope: true }).split("\n")[2]).toBe(
    "exec nice -n 10 systemd-run --user --scope --quiet --collect -p MemoryMax=12G -p CPUWeight=20 -- '/usr/bin/zsh' \"$@\"",
  )
})

test("with the guard's systemd-run, the launcher puts its directory first on the shell's PATH", () => {
  expect(launcherScript({ shell: "/usr/bin/zsh", limits, scope: true, systemdRun: "/cache/x y/systemd-run" }).split("\n").slice(2)).toEqual([
    "PATH='/cache/x y':\"$PATH\"",
    "export PATH",
    "exec nice -n 10 systemd-run --user --scope --quiet --collect -p MemoryMax=12G -p CPUWeight=20 -- '/usr/bin/zsh' \"$@\"",
    "",
  ])
  const script = systemdRunScript(limits)
  expect(script).toContain('exec "$real" -p Nice=10 -p MemoryMax=12G -p CPUWeight=20 "$@"')
  expect(script).toContain('exec "$real" -p MemoryMax=12G -p CPUWeight=20 "$@"')
})

test("a shell path with a quote is quoted, and the launcher takes the shell's file name", () => {
  expect(launcherScript({ shell: "/opt/it's/bash", limits, scope: false })).toContain(`'/opt/it'\\''s/bash' "$@"`)
  expect(launcherName("/usr/bin/zsh")).toBe("zsh")
})
