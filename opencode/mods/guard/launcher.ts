// How a heavy command runs (heavy.ts): through a launcher, a small script that
// stands in for the shell. OpenCode spawns `<shell> -c <command>`; for a
// heavy command the plugin swaps `<shell>` for a launcher of the same file
// name, which runs the real shell at a lower priority and, where systemd
// can, in its own scope under a memory cap. The command text is never
// touched, so the call's echo, title and permission scan read what the agent
// wrote; the file name is the shell's, so OpenCode reads the shell's dialect.
//
// - `nice -n <nice>` everywhere: a lower CPU priority among the processes of
//   one cgroup (on the Mac, the whole machine).
// - On Linux with a user systemd, `systemd-run --user --scope`: the command
//   gets its own cgroup with `MemoryMax`, so the kernel kills the runaway
//   test, not the machine's largest process, and `CPUWeight`, since `nice`
//   means nothing between cgroups. A scope runs the command in place: the
//   same process, environment, directory and output, so a kill by PID or
//   process group reaches it as before.

/** The limits a heavy command runs under. */
export interface Limits {
  /** `nice -n`: added to the caller's niceness, 0 to 19. */
  readonly nice: number
  /** The scope's `MemoryMax` (`12G`, `75%`), or `infinity` for none. */
  readonly memoryMax: string
  /** The scope's `CPUWeight` (1 to 10000; the default for everything else is 100). */
  readonly cpuWeight: number
}

/** One launcher: the shell it stands in for, its limits, and whether it runs a systemd scope. */
export interface Launch {
  /** The shell's absolute path, as OpenCode resolved it. */
  readonly shell: string
  readonly limits: Limits
  readonly scope: boolean
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/** The launcher's file name: the shell's own, so OpenCode reads the shell's dialect from it. */
export const launcherName = (shell: string): string => shell.slice(shell.lastIndexOf("/") + 1)

/** The launcher's text: a POSIX script that execs the shell, with its arguments, under the limits. */
export const launcherScript = (launch: Launch): string => {
  const scope = launch.scope
    ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", `MemoryMax=${launch.limits.memoryMax}`, "-p", `CPUWeight=${launch.limits.cpuWeight}`, "--"]
    : []
  const run = ["exec", "nice", "-n", String(launch.limits.nice), ...scope, quote(launch.shell), '"$@"'].join(" ")
  const what = launch.scope
    ? `at nice ${launch.limits.nice}, in a systemd scope with MemoryMax=${launch.limits.memoryMax} and CPUWeight=${launch.limits.cpuWeight}`
    : `at nice ${launch.limits.nice}`
  return `#!/bin/sh\n# Written by the OpenCode guard plugin (mods/guard/launcher.ts): runs ${launch.shell} for a heavy command ${what}.\n${run}\n`
}
