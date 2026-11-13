/**
 * `$<skill>` as an OpenCode server plugin. The composition root: it decodes
 * the options, builds the skills model (`@dotfiles/opencode-skills/model`) on
 * the filesystem scan, and registers three things.
 *
 * - A skill transform that applies the tier edits: when a project and the user
 *   both have a skill of one id, the project's holds the id and the user's is
 *   added as `<id>:global`, which the skill tool loads by that name.
 * - A `prompt` hook: each `$<id>`, `$<id>:global` or `$<id>:local` token in a
 *   sent prompt that names a skill attaches that skill, as an `@` mention of
 *   it does, so the turn carries its instructions. The token stays in the
 *   text; an unknown one stays plain text.
 * - The skills RPC (`@dotfiles/opencode-skills/catalog`, `SKILLS`): `catalog`
 *   answers the skills with their tiers, which the composer's `$` popup draws.
 *
 * A `skill.updated` event scans the files again, and reloads the registry only
 * when they changed, so the reload's own event ends there.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `home`: the home directory, default OpenCode's (`OPENCODE_TEST_HOME`, else the user's).
 * - `config`: OpenCode's config directory, default OpenCode's (`OPENCODE_CONFIG_DIR`,
 *   else `$XDG_CONFIG_HOME/opencode`, `~/.config/opencode`).
 */
import { Plugin, Skill } from "@opencode/plugin/effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { SKILLS } from "@dotfiles/opencode-skills/catalog"
import * as SkillFiles from "@dotfiles/opencode-skills/filesystem/skill-files"
import * as Model from "@dotfiles/opencode-skills/model"
import type { SkillFiles as SkillFilesService } from "@dotfiles/opencode-skills/service"
import type { Found } from "@dotfiles/opencode-skills/tier"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

// OpenCode's Global.home and Global.config (packages/util/src/global.ts).
const home = () => process.env.OPENCODE_TEST_HOME || TuiDirs.dirs().home
const config = () => process.env.OPENCODE_CONFIG_DIR || join(TuiDirs.dirs().config, "opencode")

export const Options = Schema.Struct({
  home: Schema.NonEmptyString.pipe(withDefault(home())),
  config: Schema.NonEmptyString.pipe(withDefault(config())),
})
export type Options = typeof Options.Type

/** The live scan: the working directory's folders and the user's, on disk. */
export const live = (options: Options, directory: string): Layer.Layer<SkillFilesService> =>
  SkillFiles.layer({ directory, home: options.home, config: options.config })

const decodeSkill = Schema.decodeUnknownOption(Skill.Info)

/** A scanned skill as OpenCode's registry holds it, under `id`. */
const info = (id: string, skill: Found) =>
  decodeSkill({ id, name: skill.name, ...(skill.description === undefined ? {} : { description: skill.description }), path: skill.path, content: skill.content })

/** The plugin on `externals`: the filesystem scan in OpenCode, a scratch layout in the seam test. */
export const make = (externals: (options: Options, directory: string) => Layer.Layer<SkillFilesService>) =>
  Plugin.define({
    id: "dotfiles-opencode.skills",
    effect: Effect.fn("Skills.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.skills: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(externals(options, ctx.location.directory))))
      const skills = Context.get(services, Model.SkillsModel)
      const registered = ctx.skill.list().pipe(
        Effect.map((answer) => answer.data),
        Effect.orElseSucceed(() => []),
      )

      yield* ctx.skill.transform((editor) => {
        for (const edit of skills.edits(editor.list())) {
          const skill = info(edit.id, edit.skill)
          if (Option.isSome(skill)) editor.add(skill.value)
        }
      })

      yield* ctx.session.hook("prompt", (event) =>
        Effect.gen(function* () {
          const attached = (event.prompt.skills ?? []).map((skill) => skill.id)
          const added = skills.attach(event.prompt.text, attached, yield* registered)
          if (added.length === 0) return
          event.prompt.skills = [
            ...(event.prompt.skills ?? []),
            ...added.flatMap((attachment) => {
              const id = Schema.decodeUnknownOption(Skill.ID)(attachment.id)
              return Option.isSome(id) ? [{ id: id.value, mention: { ...attachment.mention } }] : []
            }),
          ]
        }),
      )

      yield* ctx.rpc.register(SKILLS, { catalog: () => registered.pipe(Effect.map((list) => ({ entries: skills.catalog(list) }))) }).pipe(Effect.orDie)

      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["skill.updated"] }).pipe(
          Stream.runForEach(() => skills.rescan.pipe(Effect.flatMap((changed) => (changed ? ctx.skill.reload() : Effect.void)))),
          Effect.ignoreCause,
        ),
      )
    }),
  })

export default make(live)
