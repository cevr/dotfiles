// A launcher's text: the shell it execs, under nice alone or in a scope with
// its limits. filesystem/launchers.test.ts runs one.
import { expect, test } from "bun:test"
import { launcherName, launcherScript } from "./launcher.ts"

const limits = { nice: 10, memoryMax: "12G", cpuWeight: 20 }

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

test("a shell path with a quote is quoted, and the launcher takes the shell's file name", () => {
  expect(launcherScript({ shell: "/opt/it's/bash", limits, scope: false })).toContain(`'/opt/it'\\''s/bash' "$@"`)
  expect(launcherName("/usr/bin/zsh")).toBe("zsh")
})
