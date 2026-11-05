// The guard's handler: it gathers what the verdict needs from outside (where
// the call runs, which of its `rm` targets are repositories) and fails with
// `Destructive` when the verdict denies the call. The plugin calls this and
// nothing else.
//
// The guard fails closed: a session whose directory the host cannot give, or
// a target it cannot tell is a repository, refuses the call with why.
import { Context, Effect, Layer } from "effect"
import { resolve } from "./path.ts"
import { expandWord } from "./shell-line.ts"
import { RepoRoots, SessionDirectories } from "./service.ts"
import { Destructive, repoCandidates, verdict } from "./verdict.ts"

/** The guard's settings, from the plugin's options. */
export interface Config {
  /** The home directory `~` and `$HOME` name. */
  readonly home: string
}

/** One shell call: the session it runs for, its command and its `workdir` (relative to the session's directory). */
export interface ShellCall {
  readonly sessionID: string
  readonly command: string
  readonly workdir?: string
}

export class Guard extends Context.Service<
  Guard,
  {
    /** Succeeds when the call may run; fails `Destructive` with the words the model reads when it may not. */
    readonly judge: (call: ShellCall) => Effect.Effect<void, Destructive>
  }
>()("dotfiles-opencode/guard/Guard") {}

export const layer = (config: Config) =>
  Layer.effect(
    Guard,
    Effect.gen(function* () {
      const sessions = yield* SessionDirectories
      const roots = yield* RepoRoots

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
      })

      return Guard.of({ judge })
    }),
  )
