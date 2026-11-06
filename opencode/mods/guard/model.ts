// The guard's handlers. `ShellPolicy` picks the shell a command spawns
// with: a launcher under limits for a heavy one (heavy.ts, launcher.ts).
//
// `Guard`: it gathers what the verdict needs from outside (where the call
// runs, which of its `rm` targets are repositories, and, for a kill by
// pattern, what runs on the machine) and fails with `Destructive` when a
// verdict denies the call; then, for a foreground call that opens with a long
// sleep (sleep.ts), it asks whether the session is a subagent and fails with
// `Idle` when it is. The plugin calls this and nothing else.
//
// The destructive and kill rules fail closed: a session whose directory the
// host cannot give, a target it cannot tell is a repository, or a kill by
// pattern while it cannot list the processes, refuses the call with why. The
// sleep rule fails open: a session the host cannot place as a subagent or a
// root runs its sleep, since a sleep loses nothing.
import { Context, Effect, Layer } from "effect"
import { isHeavy } from "./heavy.ts"
import { killsByPattern, killVerdict } from "./kill.ts"
import { launcherName, launcherScript, type Limits } from "./launcher.ts"
import { resolve } from "./path.ts"
import { expandWord } from "./shell-line.ts"
import { Launchers, Processes, RepoRoots, Scopes, SessionDirectories, Subagents } from "./service.ts"
import { Idle, idleReason, sleepsTooLong } from "./sleep.ts"
import { Destructive, repoCandidates, verdict } from "./verdict.ts"

/** The guard's settings, from the plugin's options. */
export interface Config {
  /** The home directory `~` and `$HOME` name. */
  readonly home: string
  /** The PID of the OpenCode server the guard runs in, which a kill by pattern must not reach. */
  readonly server: number
}

/** One shell call: the session it runs for, its command, its `workdir` (relative to the session's directory), and whether it starts in the background. */
export interface ShellCall {
  readonly sessionID: string
  readonly command: string
  readonly workdir?: string
  readonly background?: boolean
}

export class Guard extends Context.Service<
  Guard,
  {
    /** Succeeds when the call may run; fails `Destructive` or `Idle` with the words the model reads when it may not. */
    readonly judge: (call: ShellCall) => Effect.Effect<void, Destructive | Idle>
  }
>()("dotfiles-opencode/guard/Guard") {}

export const layer = (config: Config) =>
  Layer.effect(
    Guard,
    Effect.gen(function* () {
      const sessions = yield* SessionDirectories
      const roots = yield* RepoRoots
      const processes = yield* Processes
      const subagents = yield* Subagents

      const judge = Effect.fn("Guard.judge")(function* (call: ShellCall) {
        const refuse = (reason: string) => Effect.fail(new Destructive({ command: call.command, reason }))
        const directory = yield* sessions
          .directoryOf(call.sessionID)
          .pipe(
            Effect.catchTag("SessionUnreadable", (error) =>
              refuse(`cannot tell where \`${call.command}\` runs (${error.message}); the guard refuses rather than guess`),
            ),
          )
        const workdir = call.workdir === undefined ? "." : expandWord({ text: call.workdir, bareStart: true, singleQuoted: false }, config.home, directory)
        const place = { cwd: resolve(directory, workdir), home: config.home }
        const answers = yield* Effect.forEach(
          repoCandidates(call.command, place),
          (path) =>
            roots.isRoot(path).pipe(
              Effect.map((root) => [path, root] as const),
              Effect.catchTag("RepoRootUnknown", (error) =>
                refuse(`cannot tell whether ${error.path} is a repository (${error.message}); remove what you mean by a path the guard can read`),
              ),
            ),
          { concurrency: "unbounded" },
        )
        const repositories = new Set(answers.flatMap(([path, root]) => (root ? [path] : [])))
        const answer = verdict(call.command, { ...place, isRepoRoot: (path) => repositories.has(path) })
        if (answer._tag === "Deny") return yield* refuse(answer.reason)
        // The process table is read only for a kill by pattern; a `kill -1` needs none.
        const running = killsByPattern(call.command)
          ? yield* processes
              .list()
              .pipe(
                Effect.catchTag("ProcessesUnreadable", (error) =>
                  refuse(`cannot list the processes \`${call.command}\` may kill (${error.message}); find the PID you mean and \`kill <pid>\``),
                ),
              )
          : []
        const kill = killVerdict(call.command, running, config.server)
        if (kill._tag === "Deny") return yield* refuse(kill.reason)

        const sleep = call.background === true ? undefined : sleepsTooLong(call.command)
        if (sleep === undefined) return
        const inSubagent = yield* subagents.isSubagent(call.sessionID).pipe(Effect.catchTag("SessionUnreadable", () => Effect.succeed(false)))
        if (inSubagent) return yield* new Idle({ command: call.command, seconds: sleep.seconds, reason: idleReason(sleep) })
      })

      return Guard.of({ judge })
    }),
  )

/** What runs heavy commands, and under which limits; from the plugin's options. */
export interface PolicyConfig {
  /** The patterns of heavy commands (heavy.ts). */
  readonly heavy: ReadonlyArray<string>
  readonly limits: Limits
}

export class ShellPolicy extends Context.Service<
  ShellPolicy,
  {
    /**
     * The shell to spawn `command` with in place of `shell`: a launcher under
     * the limits for a heavy command, `shell` itself for any other. It never
     * fails: when no launcher can be written, the command runs as it would
     * have, and the failure is logged.
     */
    readonly shellFor: (shell: string, command: string) => Effect.Effect<string>
  }
>()("dotfiles-opencode/guard/ShellPolicy") {}

export const policyLayer = (config: PolicyConfig) =>
  Layer.effect(
    ShellPolicy,
    Effect.gen(function* () {
      const launchers = yield* Launchers
      const scopes = yield* Scopes

      const shellFor = Effect.fn("ShellPolicy.shellFor")(function* (shell: string, command: string) {
        if (!shell.startsWith("/") || !isHeavy(command, config.heavy)) return shell
        const scope = yield* scopes.available
        return yield* launchers.install(launcherName(shell), launcherScript({ shell, limits: config.limits, scope })).pipe(
          Effect.catchTag("LauncherUnavailable", (error) =>
            Effect.logWarning(`dotfiles-opencode.guard: a heavy command runs without its limits: ${error.message}`).pipe(Effect.as(shell)),
          ),
        )
      })

      return ShellPolicy.of({ shellFor })
    }),
  )
