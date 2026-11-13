/**
 * The guard as an OpenCode server plugin, the Claude Code hook
 * `claude/hooks/guard-destructive.ts` ported. The composition root: it
 * decodes the options, builds the model (`@dotfiles/opencode-guard/model`) on
 * the filesystem and OpenCode's sessions, and answers the tool registry's
 * `execute.before` hook with it.
 *
 * A shell call that loses work for good is refused before it runs, and the
 * model reads why: `rm -rf` of the root, the home, the directory it runs in or
 * a repository, `git reset --hard`, and a forced `git clean` with `-d`, `-x`
 * or `-X` (`@dotfiles/opencode-guard/verdict` has the rules). So is a kill
 * by pattern (`pkill`, `killall`, `kill $(pgrep …)`) whose pattern matches
 * this server or another OpenCode process running now, and `kill -1`
 * (`@dotfiles/opencode-guard/kill`); the process table is read with `ps` only
 * for such a call. A subagent's foreground call that opens by sleeping 30
 * seconds or more is refused too, naming a background shell and
 * `shell({ action: "wait", id, ms })` instead (`@dotfiles/opencode-guard/sleep`);
 * a root session's runs. So is `git worktree add` in a checkout Rift serves (its
 * file system clones, or a warm source has its origin): a worktree is a full
 * copy, and the refusal names the rift tool's `create` or `workrift create
 * <branch>` (`@dotfiles/opencode-guard/worktree`); the checkout is read with
 * `git`, `df` and `mount` only for such a call. Everything else runs untouched.
 *
 * The hook is the registry's, so it sees every call the registry runs: a
 * direct call, a call from code mode's `execute`, and a kernel cell's
 * `tools.shell(...)` while the kernel is the agent's runtime (its calls go
 * through `runtime.call`, which runs these hooks). The kernel without
 * `codeOnly` runs a cell's tools directly, skipping the hooks; it leaves the
 * shell out of a cell for that reason (mods/kernel/tools.ts, HOOKED_TOOLS).
 *
 * The shell policy rides the shell's own `create.before` hook, which sees
 * every command OpenCode spawns (a direct call, a cell's, the user's `!`): a
 * heavy one (`bun test`, `tsc`, a gate; `@dotfiles/opencode-guard/heavy`) is
 * spawned through a launcher that stands in for the shell, at `nice` and, on
 * Linux, in a systemd scope under `MemoryMax`
 * (`@dotfiles/opencode-guard/launcher`). The command text stays as written.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `home`: the directory `~` and `$HOME` name; default the user's home.
 * - `heavy`: the heavy commands' patterns; default `DEFAULT_HEAVY`. `[]` turns the policy off.
 * - `nice`: the niceness added to a heavy command, 0 to 19; default 10.
 * - `memoryMax`: the scope's `MemoryMax` on Linux; default `12G`.
 * - `cpuWeight`: the scope's `CPUWeight` on Linux, 1 to 10000; default 20.
 * - `launchers`: the directory the launchers are written to; default `~/.cache/opencode/guard-launchers`.
 */
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { join } from "node:path"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as FilesystemLaunchers from "@dotfiles/opencode-guard/filesystem/launchers"
import * as FilesystemRepoRoots from "@dotfiles/opencode-guard/filesystem/repo-roots"
import { DEFAULT_HEAVY } from "@dotfiles/opencode-guard/heavy"
import { DEFAULT_LIMITS } from "@dotfiles/opencode-guard/launcher"
import * as Model from "@dotfiles/opencode-guard/model"
import * as PsProcesses from "@dotfiles/opencode-guard/process/processes"
import * as ProcessScopes from "@dotfiles/opencode-guard/process/scopes"
import * as OpenCodeSessionDirectories from "@dotfiles/opencode-guard/opencode/session-directories"
import * as OpenCodeSubagents from "@dotfiles/opencode-guard/opencode/subagents"
import * as ProcessCheckouts from "@dotfiles/opencode-guard/process/checkouts"
import type { Checkouts, Launchers, Processes, RepoRoots, Scopes, SessionDirectories, Subagents } from "@dotfiles/opencode-guard/service"
import { type Idle, idleMessage } from "@dotfiles/opencode-guard/sleep"
import { type Destructive, message } from "@dotfiles/opencode-guard/verdict"
import { type FullCopy, worktreeMessage } from "@dotfiles/opencode-guard/worktree"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const Int = (min: number, max: number) => Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }))

export const Options = Schema.Struct({
  home: Schema.String.pipe(withDefault(TuiDirs.dirs().home)),
  heavy: Schema.Array(Schema.String).pipe(withDefault<ReadonlyArray<string>>(DEFAULT_HEAVY)),
  nice: Int(0, 19).pipe(withDefault(DEFAULT_LIMITS.nice)),
  memoryMax: Schema.String.check(Schema.isPattern(/^(\d+[KMGT]?|\d+%|infinity)$/)).pipe(withDefault(DEFAULT_LIMITS.memoryMax)),
  cpuWeight: Int(1, 10_000).pipe(withDefault(DEFAULT_LIMITS.cpuWeight)),
  launchers: Schema.String.pipe(withDefault(join(TuiDirs.dirs().home, ".cache/opencode/guard-launchers"))),
})
export type Options = typeof Options.Type

/** The tools that run their `command` in a shell: the fork's `shell`, and `bash`, the name a model carries over, before the input-repair hook renames it. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["shell", "bash"])

/** What the guard reads of a shell call's input. */
// `background` is read loosely: a malformed one must not take the call out of the destructive rule's reach.
const ShellInput = Schema.Struct({ command: Schema.String, workdir: Schema.optional(Schema.String), background: Schema.optional(Schema.Unknown) })
const decodeInput = Schema.decodeUnknownOption(ShellInput)
/** The input as a JSON string, as a model sometimes sends it and the input-repair hook may not have parsed yet. */
const decodeInputText = Schema.decodeUnknownOption(Schema.fromJsonString(ShellInput))

/** What the model reads of a refusal, each rule in its own words. */
const wordsOf = (refusal: Destructive | FullCopy | Idle): string => {
  if (refusal._tag === "Idle") return idleMessage(refusal.reason)
  if (refusal._tag === "FullCopy") return worktreeMessage(refusal.reason)
  return message(refusal.reason)
}

/** The outside systems the model runs on. */
export type Externals = Checkouts | Launchers | Processes | RepoRoots | Scopes | SessionDirectories | Subagents

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** Where a session runs and whether it is a subagent, as OpenCode's sessions say: the same on any host. */
export const sessionsOf = (ctx: Plugin.Context): Layer.Layer<SessionDirectories | Subagents> => {
  const get = (sessionID: string) => ctx.session.get({ sessionID: sessionID as SessionID })
  return Layer.mergeAll(
    OpenCodeSessionDirectories.layer((sessionID) => get(sessionID).pipe(Effect.map((session) => session.location.directory))),
    OpenCodeSubagents.layer((sessionID) => get(sessionID).pipe(Effect.map((session) => session.parentID))),
  )
}

/** The outside systems as the filesystem and OpenCode provide them. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.mergeAll(
    FilesystemRepoRoots.layer,
    ProcessCheckouts.layer(),
    FilesystemLaunchers.layer(options.launchers),
    PsProcesses.layer(),
    ProcessScopes.layer(),
    sessionsOf(ctx),
  )

/** The plugin on `externals`: the live systems in OpenCode, memory layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.guard",
    effect: Effect.fn("Guard.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.guard: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const limits = { nice: options.nice, memoryMax: options.memoryMax, cpuWeight: options.cpuWeight }
      const services = yield* Layer.build(
        Layer.mergeAll(Model.layer({ home: options.home, server: process.pid }), Model.policyLayer({ heavy: options.heavy, limits })).pipe(
          Layer.provide(externals(ctx, options)),
        ),
      )
      const guard = Context.get(services, Model.Guard)
      const policy = Context.get(services, Model.ShellPolicy)

      // The command stays as written: only the program that runs it changes.
      yield* ctx.shell.hook("create.before", (invocation) =>
        policy.shellFor(invocation.shell, invocation.command).pipe(
          Effect.map((shell) => {
            invocation.shell = shell
          }),
        ),
      )

      yield* ctx.tool.hook("execute.before", (event) => {
        if (!SHELL_TOOLS.has(event.tool)) return Effect.void
        // An input that is not a shell call's is left to the tool, which refuses it itself.
        const input = Option.orElse(decodeInput(event.input), () => decodeInputText(event.input))
        if (Option.isNone(input)) return Effect.void
        const { command, workdir, background } = input.value
        return guard
          .judge({
            sessionID: event.sessionID,
            command,
            ...(workdir === undefined ? {} : { workdir }),
            ...(background === true ? { background } : {}),
          })
          .pipe(
            Effect.mapError((refusal) => new Tool.Error({ message: wordsOf(refusal), error: refusal })),
          )
      })
    }),
  })

export default make(live)
