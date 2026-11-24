// The guard's handlers. `ShellPolicy` picks the shell a command spawns
// with: a launcher under limits for a heavy one (heavy.ts, launcher.ts).
//
// `Guard`: it gathers what the verdict needs from outside (where the call
// runs, which of its `rm` targets are repositories, and, for a kill by
// pattern, what runs on the machine) and fails with `Destructive` when a
// verdict denies the call; for a `git worktree add`, it reads the checkout
// (and, off a cloning file system, the warm sources) and fails with
// `FullCopy` when a workspace can copy it (worktree.ts); for a `work gc`, it reads
// the workspaces work is still making and fails with `Destructive` while one's
// folder exists (work-gc.ts); then, for a foreground call that opens with a long
// sleep (sleep.ts), it asks whether the session is a subagent and fails with
// `Idle` when it is. A line that starts Chrome for DevTools or headless without
// the keychain flags, or runs a script that does (its text asked of
// `ScriptFiles` only for a line that runs one), fails with `KeychainPrompt`
// (chrome.ts). The plugin calls this and nothing else.
//
// The destructive, worktree and kill rules fail closed: a session whose directory the
// host cannot give, a target it cannot tell is a repository, a worktree add in
// a checkout it cannot read, or a kill by
// pattern while it cannot list the processes, refuses the call with why. The
// sleep rule fails open: a session the host cannot place as a subagent or a
// root runs its sleep, since a sleep loses nothing.
import { Context, Effect, Layer, Match, Option, Predicate } from "effect"
import { type BareLaunch, bareLaunches, KeychainPrompt, keychainReason, runtimeRuns, scriptLaunch } from "./chrome.ts"
import { parseShell } from "./command-line.ts"
import { DEFAULT_HEAVY, heavyCommand } from "./heavy.ts"
import { killsByPattern, killVerdict } from "./kill.ts"
import { admissionLauncher, launcherName, launcherScript, type Limits } from "./launcher.ts"
import { resolve } from "./path.ts"
import { expandWord } from "./shell-line.ts"
import { type Checkout, type CheckoutUnknown, Checkouts, type LauncherUnavailable, Launchers, Processes, RepoRoots, Reservations, Scopes, ScriptFiles, SessionDirectories, Subagents, type WarmSource } from "./service.ts"
import { Idle, idleReason, sleepsTooLong } from "./sleep.ts"
import { Destructive, repoCandidates, verdict } from "./verdict.ts"
import { workGcReason, workGcs } from "./work-gc.ts"
import { clones, FullCopy, riftHome, worktreeAdds, worktreeReason } from "./worktree.ts"

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
    /** Succeeds when the call may run; fails `Destructive`, `FullCopy`, `KeychainPrompt` or `Idle` with the words the model reads when it may not. */
    readonly judge: (call: ShellCall) => Effect.Effect<void, Destructive | FullCopy | KeychainPrompt | Idle>
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
      const checkouts = yield* Checkouts
      const reservations = yield* Reservations
      const scripts = yield* ScriptFiles

      /** The bases that decide whether a workspace can copy `checkout`: none asked on a cloning file system, which decides alone. */
      const sourcesFor = (checkout: Checkout): Effect.Effect<ReadonlyArray<WarmSource>, CheckoutUnknown> => {
        if (clones(checkout.filesystem)) return Effect.succeed([])
        return checkouts.warmSources
      }

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
        // The checkout and the warm sources are read only for a worktree add; the sources only off a cloning file system.
        for (const add of worktreeAdds(call.command, place)) {
          const unknown = (error: CheckoutUnknown) =>
            Effect.fail(
              new FullCopy({
                command: call.command,
                reason: `cannot tell whether a workspace can copy the checkout at ${add.directory} (${error.path}: ${error.message}), so the guard refuses \`${add.command}\` rather than guess; make a workspace with the work tool (\`{ action: "create", branch }\`) or \`workrift create <branch>\` on the workbox`,
              }),
            )
          const checkout = yield* checkouts.of(add.directory).pipe(Effect.catchTag("CheckoutUnknown", unknown))
          if (Option.isNone(checkout)) continue
          const sources = yield* sourcesFor(checkout.value).pipe(Effect.catchTag("CheckoutUnknown", unknown))
          const home = riftHome(checkout.value, sources)
          if (Option.isSome(home)) return yield* new FullCopy({ command: call.command, reason: worktreeReason(add, checkout.value, home.value) })
        }
        // The work registry is read only for a `work gc`.
        for (const gc of workGcs(call.command, place)) {
          const making = yield* reservations
            .of(gc.directory)
            .pipe(
              Effect.catchTag("ReservationsUnknown", (error) =>
                refuse(`cannot tell which workspaces \`${gc.command}\` would delete (${error.directory}: ${error.message}); the guard refuses rather than guess`),
              ),
            )
          if (making.length > 0) return yield* refuse(workGcReason(gc, making))
        }
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
        // A Chrome the line starts is read from the line; a script's text only for a line that runs one.
        const keychain = (launch: BareLaunch) => new KeychainPrompt({ command: call.command, reason: keychainReason(launch) })
        for (const launch of bareLaunches(call.command, place)) return yield* keychain(launch)
        for (const run of runtimeRuns(call.command, place)) {
          const text = yield* Match.valueTags(run.ran, { Inline: ({ code }) => Effect.succeed(Option.some(code)), ScriptFile: ({ path }) => scripts.text(path) })
          const launch = Option.flatMap(text, (code) => scriptLaunch(run, code))
          if (Option.isSome(launch)) return yield* keychain(launch.value)
        }

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
  readonly admission?: ReadonlyArray<string>
}

export class ShellPolicy extends Context.Service<
  ShellPolicy,
  {
    /**
     * The shell to spawn `command` with in place of `shell`: a launcher under
     * the limits for a heavy command, `shell` itself for any other.
     */
    readonly shellFor: (shell: string, command: string) => Effect.Effect<string, LauncherUnavailable>
  }
>()("dotfiles-opencode/guard/ShellPolicy") {}

export const policyLayer = (config: PolicyConfig) =>
  Layer.effect(
    ShellPolicy,
    Effect.gen(function* () {
      const launchers = yield* Launchers
      const scopes = yield* Scopes

      const shellFor = Effect.fn("ShellPolicy.shellFor")(function* (shell: string, command: string) {
        const helper = config.admission
        const parsed = parseShell(command)
        if (Predicate.isNotUndefined(helper) && heavyCommand(parsed, [...DEFAULT_HEAVY, ...config.heavy]))
          return yield* launchers.install(launcherName(shell), admissionLauncher(shell, helper, parsed))
        if (!shell.startsWith("/") || !heavyCommand(parsed, config.heavy)) return shell
        const scope = yield* scopes.available
        const ionice = yield* scopes.ionice
        return yield* launchers.install(launcherName(shell), launcherScript({ shell, limits: config.limits, scope, ionice })).pipe(
          Effect.catchTag("LauncherUnavailable", (error) =>
            Effect.logWarning(`dotfiles-opencode.guard: a heavy command runs without its limits: ${error.message}`).pipe(Effect.as(shell)),
          ),
        )
      })

      return ShellPolicy.of({ shellFor })
    }),
  )
