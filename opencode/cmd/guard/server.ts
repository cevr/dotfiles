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
 * for such a call. Everything else runs untouched.
 *
 * The hook is the registry's, so it sees every call the registry runs: a
 * direct call, a call from code mode's `execute`, and a kernel cell's
 * `tools.shell(...)` while the kernel is the agent's runtime (its calls go
 * through `runtime.call`, which runs these hooks). The kernel without
 * `codeOnly` runs a cell's tools directly, skipping the hooks; it leaves the
 * shell out of a cell for that reason (mods/kernel/tools.ts, HOOKED_TOOLS).
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `home`: the directory `~` and `$HOME` name; default the user's home.
 */
import { homedir } from "node:os"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as FilesystemRepoRoots from "@dotfiles/opencode-guard/filesystem/repo-roots"
import * as Model from "@dotfiles/opencode-guard/model"
import * as PsProcesses from "@dotfiles/opencode-guard/process/processes"
import * as OpenCodeSessionDirectories from "@dotfiles/opencode-guard/opencode/session-directories"
import type { Processes, RepoRoots, SessionDirectories } from "@dotfiles/opencode-guard/service"
import { message } from "@dotfiles/opencode-guard/verdict"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

export const Options = Schema.Struct({
  home: Schema.String.pipe(withDefault(homedir())),
})
export type Options = typeof Options.Type

/** The tools that run their `command` in a shell: the fork's `shell`, and `bash`, the name a model carries over, before the input-repair hook renames it. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["shell", "bash"])

/** What the guard reads of a shell call's input. */
const ShellInput = Schema.Struct({ command: Schema.String, workdir: Schema.optional(Schema.String) })
const decodeInput = Schema.decodeUnknownOption(ShellInput)
/** The input as a JSON string, as a model sometimes sends it and the input-repair hook may not have parsed yet. */
const decodeInputText = Schema.decodeUnknownOption(Schema.fromJsonString(ShellInput))

/** The outside systems the model runs on. */
export type Externals = Processes | RepoRoots | SessionDirectories

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** The outside systems as the filesystem and OpenCode provide them. */
export const live = (ctx: Plugin.Context): Layer.Layer<Externals> =>
  Layer.mergeAll(
    FilesystemRepoRoots.layer,
    PsProcesses.layer(),
    OpenCodeSessionDirectories.layer((sessionID) =>
      ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map((session) => session.location.directory)),
    ),
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
      const services = yield* Layer.build(Model.layer({ home: options.home, server: process.pid }).pipe(Layer.provide(externals(ctx, options))))
      const guard = Context.get(services, Model.Guard)

      yield* ctx.tool.hook("execute.before", (event) => {
        if (!SHELL_TOOLS.has(event.tool)) return Effect.void
        // An input that is not a shell call's is left to the tool, which refuses it itself.
        const input = Option.orElse(decodeInput(event.input), () => decodeInputText(event.input))
        if (Option.isNone(input)) return Effect.void
        const { command, workdir } = input.value
        return guard
          .judge({ sessionID: event.sessionID, command, ...(workdir === undefined ? {} : { workdir }) })
          .pipe(Effect.mapError((refusal) => new Tool.Error({ message: message(refusal.reason), error: refusal })))
      })
    }),
  })

export default make(live)
