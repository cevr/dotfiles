/**
 * The image tool as an OpenCode server plugin: the composition root of
 * `@dotfiles/opencode-image` on the call's side. It
 *
 * - adds the `image` tool, a direct tool (a kernel cell reaches it as
 *   `tools.image`), always registered, so the tool list never changes in a
 *   session;
 * - takes OpenCode's own image tool (`experimental_image_generate`) out of the
 *   registry, so there is one image tool and no silent third-party default;
 * - adds the `image` skill from `mods/image/SKILL.md`.
 *
 * A call checks the input and resolves its paths (the subscription's models
 * from OpenCode's catalog), asserts the `image` permission with the route as
 * its resource (the owner's rules may deny the paid route; nothing forces a
 * prompt), keeps the request in a file, and starts `run.ts` on it as a job of
 * the session through the wakes' `set` RPC. It answers at once; the job's end
 * letter wakes the session with the saved path, or the failure.
 *
 * Options (all optional): `bun`, a real bun by path (default the one on PATH,
 * else ~/.bun/bin/bun); `outputs`, the folder images go in by session (default
 * `<tmp>/opencode/images`); `codexOrigin`, `codexHome` and `openaiOrigin`, the
 * runner's backends and Codex home (the real-OpenCode test points them at a
 * fake).
 */
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Random, Schema } from "effect"
import * as FileRequests from "@dotfiles/opencode-image/filesystem/requests"
import * as Launch from "@dotfiles/opencode-image/launch"
import * as OpenCodeCatalog from "@dotfiles/opencode-image/opencode/catalog"
import * as WakeJobs from "@dotfiles/opencode-image/opencode/jobs"
import type { ImageFailed } from "@dotfiles/opencode-image/outcome"
import type { Catalog, JobRefused, Jobs, Requests } from "@dotfiles/opencode-image/service"
import { DESCRIPTION, ImageInput, NAME, receipt, UPSTREAM_TOOL } from "@dotfiles/opencode-image/tool"
import { WAKES } from "@dotfiles/opencode-wake/wake"

export const ID = "dotfiles-opencode.image"

export const Options = Schema.Struct({
  bun: Schema.optionalKey(Schema.String),
  outputs: Schema.optionalKey(Schema.String),
  codexOrigin: Schema.optionalKey(Schema.String),
  codexHome: Schema.optionalKey(Schema.String),
  openaiOrigin: Schema.optionalKey(Schema.String),
})
export type Options = typeof Options.Type

/** What a call runs on. */
export type Externals = Catalog | Requests | Jobs

/** The job's runner, beside this file. */
export const RUN_SCRIPT = fileURLToPath(new URL("./run.ts", import.meta.url))
/** The skill the plugin adds. */
export const SKILL_FILE = fileURLToPath(new URL("../../mods/image/SKILL.md", import.meta.url))

const outputsOf = (options: Options) => options.outputs ?? path.join(tmpdir(), "opencode", "images")

const bunOf = (options: Options) => options.bun ?? Bun.which("bun") ?? path.join(TuiDirs.dirs().home, ".bun", "bin", "bun")

/** `value` as one `/bin/sh` word. */
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const flag = (name: string, value: Option.Option<string>) => Option.match(value, { onNone: () => [], onSome: (set) => [`--${name}`, quote(set)] })

/** The job's command for a request file: the runner, and the backends the options name. */
export const commandOf = (options: Options) => (file: string) =>
  [
    quote(bunOf(options)),
    quote(RUN_SCRIPT),
    quote(file),
    ...flag("codex-origin", Option.fromNullishOr(options.codexOrigin)),
    ...flag("codex-home", Option.fromNullishOr(options.codexHome)),
    ...flag("openai-origin", Option.fromNullishOr(options.openaiOrigin)),
  ].join(" ")

/** The live externals: OpenCode's model list, request files beside the images, and the wakes' jobs. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.mergeAll(
    OpenCodeCatalog.layer((directory) => ctx.model.list({ location: { directory } }).pipe(Effect.map((answer) => answer.data))),
    FileRequests.layer(path.join(outputsOf(options), ".requests")),
    WakeJobs.layer((ask) => ctx.rpc(WAKES).set(ask), commandOf(options)),
  )

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u

const field = (head: string, name: string) => Option.fromNullishOr(new RegExp(`^${name}:\\s*(.+)$`, "mu").exec(head)?.[1]?.trim())

/** The skill in `file`: its frontmatter's name and description, and the text after it. */
export const skillOf = (file: string) => {
  const text = readFileSync(file, "utf8")
  const match = Option.fromNullishOr(FRONTMATTER.exec(text))
  const head = Option.getOrElse(Option.flatMap(match, (found) => Option.fromNullishOr(found[1])), () => "")
  const content = Option.getOrElse(Option.map(match, (found) => text.slice(found[0].length)), () => text)
  return Schema.decodeUnknownSync(Skill.Info)({
    id: NAME,
    name: Option.getOrElse(field(head, "name"), () => NAME),
    description: Option.getOrElse(field(head, "description"), () => ""),
    path: file,
    content,
  })
}

const failed = (error: ImageFailed | JobRefused) => {
  if (error._tag === "JobRefused") return new Tool.Error({ message: `The image job did not start: ${error.reason}`, error })
  return new Tool.Error({ message: `[${error.code}] ${error.message}`, error })
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

/** Six base-36 characters: a default file name's suffix and the request file's name. */
const callId = Effect.forEach(Array.from({ length: 6 }), () => Random.nextIntBetween(0, ALPHABET.length - 1)).pipe(
  Effect.map((indexes) => indexes.map((index) => ALPHABET[index]).join("")),
)

/** The plugin on `externals`: OpenCode's in a server, stand-ins in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: ID,
    effect: Effect.fn("Image.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(Option.getOrElse(Option.fromNullishOr(ctx.options), () => ({}))).pipe(
        Effect.catch((error) => Effect.die(`${ID}: invalid options: ${error.message}`)),
      )
      const services = yield* Layer.build(Launch.layer.pipe(Layer.provide(externals(ctx, options))))
      const launcher = Context.get(services, Launch.Launcher)
      const skill = skillOf(SKILL_FILE)
      const outputs = outputsOf(options)

      yield* ctx.skill.transform((editor) => {
        editor.add(skill)
      })

      yield* ctx.tool.transform((editor) => {
        editor.remove(UPSTREAM_TOOL)
        editor.add({
          name: NAME,
          description: DESCRIPTION,
          input: ImageInput,
          options: { codemode: false },
          execute: (input, context) =>
            Effect.gen(function* () {
              const id = yield* callId
              const place = { sessionID: context.sessionID, directory: ctx.location.directory, outputs: path.join(outputs, context.sessionID), id }
              const prepared = yield* launcher.prepare(input, place).pipe(Effect.mapError(failed))
              yield* ctx.permission.assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: NAME,
                resources: [prepared.label],
                save: ["*"],
                metadata: { route: prepared.label, path: prepared.request.path },
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const started = yield* launcher.launch(prepared, place).pipe(Effect.mapError(failed))
              return {
                content: [{ type: "text" as const, text: receipt(started.id, started.path, started.route) }],
                metadata: { id: started.id, path: started.path, route: started.route },
              }
            }),
        })
      })
    }),
  })

export default make(live)
