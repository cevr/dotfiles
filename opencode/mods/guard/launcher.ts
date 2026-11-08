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
// - On that Linux, a `systemd-run` of the guard's first on the shell's PATH.
//   A heavy command an agent starts through `systemd-run` runs in a unit of
//   its own: a service (the default) is started by the user's systemd, so it
//   leaves both the launcher's nice and its scope; a `--scope` keeps the nice
//   but leaves the launcher's scope for one with the default weight. Measured
//   on the workbox on 2026-11-08: five verifiers' `systemd-run --user --wait
//   --pipe … go test` ran at nice 0 and took 12 of 16 cores. The guard's
//   `systemd-run` gives the unit the launcher's limits (`Nice` for a service,
//   which a scope refuses), ahead of the caller's options, so a `-p` of the
//   caller's own still wins, then runs the next `systemd-run` on the PATH.
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

/** One launcher: the shell it stands in for, its limits, and whether it runs a systemd scope. */
export interface Launch {
  /** The shell's absolute path, as OpenCode resolved it. */
  readonly shell: string
  readonly limits: Limits
  readonly scope: boolean
  /** The path of the guard's `systemd-run` (`systemdRunScript`), whose directory goes first on the shell's PATH. */
  readonly systemdRun?: string
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/** `argv` under the limits: `nice`, then, when `scope`, a user systemd scope with its memory cap and CPU weight. */
export const heavyArgv = (argv: ReadonlyArray<string>, limits: Limits, scope: boolean): ReadonlyArray<string> => [
  "nice",
  "-n",
  String(limits.nice),
  ...(scope ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", `MemoryMax=${limits.memoryMax}`, "-p", `CPUWeight=${limits.cpuWeight}`, "--"] : []),
  ...argv,
]

/** The launcher's file name: the shell's own, so OpenCode reads the shell's dialect from it. */
export const launcherName = (shell: string): string => shell.slice(shell.lastIndexOf("/") + 1)

/** The launcher's text: a POSIX script that execs the shell, with its arguments, under the limits. */
export const launcherScript = (launch: Launch): string => {
  const run = ["exec", ...heavyArgv([quote(launch.shell), '"$@"'], launch.limits, launch.scope)].join(" ")
  const what = launch.scope
    ? `at nice ${launch.limits.nice}, in a systemd scope with MemoryMax=${launch.limits.memoryMax} and CPUWeight=${launch.limits.cpuWeight}`
    : `at nice ${launch.limits.nice}`
  const shim = launch.systemdRun
  const path = shim === undefined ? "" : `PATH=${quote(shim.slice(0, shim.lastIndexOf("/")))}:"$PATH"\nexport PATH\n`
  return `#!/bin/sh\n# Written by the OpenCode guard plugin (mods/guard/launcher.ts): runs ${launch.shell} for a heavy command ${what}.\n${path}${run}\n`
}

/**
 * The guard's `systemd-run`: the next `systemd-run` on the PATH (past this
 * file, however it is named), its unit under `limits`. A scope takes the CPU
 * weight and memory cap and keeps the caller's nice; a service takes `Nice`
 * too. The caller's own options come after these, so theirs win.
 */
export const systemdRunScript = (limits: Limits): string => {
  const caps = `-p MemoryMax=${limits.memoryMax} -p CPUWeight=${limits.cpuWeight}`
  return [
    "#!/bin/sh",
    "# Written by the OpenCode guard plugin (mods/guard/launcher.ts): a heavy command's systemd-run, its unit under the launcher's limits.",
    "real=",
    "set -f",
    "IFS=:",
    "for dir in $PATH; do",
    '  if [ -x "$dir/systemd-run" ] && ! [ "$dir/systemd-run" -ef "$0" ]; then real=$dir/systemd-run; break; fi',
    "done",
    "unset IFS",
    "set +f",
    'if [ -z "$real" ]; then echo "systemd-run: not found on PATH" >&2; exit 127; fi',
    'for arg in "$@"; do',
    `  if [ "$arg" = --scope ]; then exec "$real" ${caps} "$@"; fi`,
    "done",
    `exec "$real" -p Nice=${limits.nice} ${caps} "$@"`,
    "",
  ].join("\n")
}
