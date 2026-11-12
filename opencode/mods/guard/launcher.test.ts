// A launcher's text: the shell it execs, under nice alone, in the idle I/O
// class where ionice is, or in a scope with its limits. filesystem/launchers.test.ts runs one.
import { expect, test } from "bun:test"
import { DEFAULT_LIMITS, heavyArgv, ioniceAvailable, launcherName, launcherScript } from "./launcher.ts"

const limits = { nice: 10, memoryMax: "12G", cpuWeight: 20 }
const mac = { scope: false, ionice: false }
const linux = { scope: true, ionice: true }

test("an argv runs niced off systemd, and in the idle I/O class and a user scope with its limits on systemd", () => {
  expect(DEFAULT_LIMITS).toEqual(limits)
  expect(heavyArgv(["sh", "-c", "bun test"], limits, mac)).toEqual(["nice", "-n", "10", "sh", "-c", "bun test"])
  expect(heavyArgv(["sh", "-c", "bun test"], limits, linux)).toEqual([
    "nice", "-n", "10",
    "ionice", "-c3",
    "systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=12G", "-p", "CPUWeight=20", "--",
    "sh", "-c", "bun test",
  ])
  expect(heavyArgv(["du", "-sh", "/nonexistent/loop-probe-x"], limits, { scope: false, ionice: true })).toEqual(["nice", "-n", "10", "ionice", "-c3", "du", "-sh", "/nonexistent/loop-probe-x"])
})

test("ionice is used on Linux where it is on PATH, and never on the Mac", () => {
  expect(ioniceAvailable("linux", (command) => command === "ionice")).toBe(true)
  expect(ioniceAvailable("linux", () => false)).toBe(false)
  expect(ioniceAvailable("darwin", () => true)).toBe(false)
})

test("off systemd, the shell runs at the lower priority", () => {
  expect(launcherScript({ shell: "/bin/zsh", limits, ...mac })).toBe(
    "#!/bin/sh\n# Written by the OpenCode guard plugin (mods/guard/launcher.ts): runs /bin/zsh for a heavy command at nice 10.\nexec nice -n 10 '/bin/zsh' \"$@\"\n",
  )
})

test("with systemd, the shell runs in the idle I/O class and a user scope with its memory cap and CPU weight", () => {
  const script = launcherScript({ shell: "/usr/bin/zsh", limits, ...linux }).split("\n")
  expect(script[1]).toContain("at nice 10 in the idle I/O class, in a systemd scope")
  expect(script[2]).toBe("exec nice -n 10 ionice -c3 systemd-run --user --scope --quiet --collect -p MemoryMax=12G -p CPUWeight=20 -- '/usr/bin/zsh' \"$@\"")
})

test("a shell path with a quote is quoted, and the launcher takes the shell's file name", () => {
  expect(launcherScript({ shell: "/opt/it's/bash", limits, ...mac })).toContain(`'/opt/it'\\''s/bash' "$@"`)
  expect(launcherName("/usr/bin/zsh")).toBe("zsh")
})
