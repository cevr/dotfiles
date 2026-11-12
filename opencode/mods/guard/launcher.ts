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
// - `ionice -c3` where `ionice` is (Linux): the idle I/O class, so a test's,
//   a clone's or a `du`'s disk reads wait behind the service's and the TUIs'.
// - On Linux with a user systemd, `systemd-run --user --scope`: the command
//   gets its own cgroup with `MemoryMax`, so the kernel kills the runaway
//   test, not the machine's largest process, and `CPUWeight`, since `nice`
//   means nothing between cgroups. A scope runs the command in place: the
//   same process, environment, directory and output, so a kill by PID or
//   process group reaches it as before.
//
// `heavyArgv` is the same wrapping for a caller that spawns an argv itself
// (the wakes' heavy job, rift land's gate and acceptance run); this file
// imports nothing, so any mod's process implementation may import it
// (`@dotfiles/opencode-guard/launcher`) without the guard plugin.

/** The limits a heavy command runs under. */
export interface Limits {
  /** `nice -n`: added to the caller's niceness, 0 to 19. */
  readonly nice: number
  /** The scope's `MemoryMax` (`12G`, `75%`), or `infinity` for none. */
  readonly memoryMax: string
  /** The scope's `CPUWeight` (1 to 10000; the default for everything else is 100). */
  readonly cpuWeight: number
}

/** The guard's default limits (cmd/guard/server.ts's options), which the other callers run under. */
export const DEFAULT_LIMITS: Limits = { nice: 10, memoryMax: "12G", cpuWeight: 20 }

/** The probe for a scope: on Linux, one is available when this exits 0 (a user systemd with a reachable bus). */
export const SCOPE_PROBE: ReadonlyArray<string> = ["systemd-run", "--user", "--scope", "--quiet", "--collect", "true"]

/** What the host offers a heavy command beyond `nice`: a user systemd scope (`SCOPE_PROBE`), and `ionice` (`ioniceAvailable`). */
export interface Host {
  readonly scope: boolean
  readonly ionice: boolean
}

/** Whether `ionice` can put a command in the idle I/O class: on Linux, where it is on PATH; never elsewhere. */
export const ioniceAvailable = (platform: string = process.platform, onPath: (command: string) => boolean = (command) => Boolean(Bun.which(command))): boolean =>
  platform === "linux" && onPath("ionice")

/** One launcher: the shell it stands in for, its limits, and what the host offers beyond `nice`. */
export interface Launch extends Host {
  /** The shell's absolute path, as OpenCode resolved it. */
  readonly shell: string
  readonly limits: Limits
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * `argv` under the limits: `nice`, then, when the host has them, `ionice -c3` and a user systemd
 * scope with its memory cap and CPU weight.
 */
export const heavyArgv = (argv: ReadonlyArray<string>, limits: Limits, host: Host): ReadonlyArray<string> => [
  "nice",
  "-n",
  String(limits.nice),
  ...["ionice", "-c3"].filter(() => host.ionice),
  ...["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", `MemoryMax=${limits.memoryMax}`, "-p", `CPUWeight=${limits.cpuWeight}`, "--"].filter(() => host.scope),
  ...argv,
]

/** The launcher's file name: the shell's own, so OpenCode reads the shell's dialect from it. */
export const launcherName = (shell: string): string => shell.slice(shell.lastIndexOf("/") + 1)

/** The launcher's text: a POSIX script that execs the shell, with its arguments, under the limits. */
export const launcherScript = (launch: Launch): string => {
  const run = ["exec", ...heavyArgv([quote(launch.shell), '"$@"'], launch.limits, launch)].join(" ")
  const what = [
    `at nice ${launch.limits.nice}`,
    ...[" in the idle I/O class"].filter(() => launch.ionice),
    ...[`, in a systemd scope with MemoryMax=${launch.limits.memoryMax} and CPUWeight=${launch.limits.cpuWeight}`].filter(() => launch.scope),
  ].join("")
  return `#!/bin/sh\n# Written by the OpenCode guard plugin (mods/guard/launcher.ts): runs ${launch.shell} for a heavy command ${what}.\n${run}\n`
}
