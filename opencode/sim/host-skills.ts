// The in-memory skill catalog, derived by a location's registered transforms.
import type { Plugin } from "@opencode/plugin/effect"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Effect, Option, Schema, Scope, type Types } from "effect"

type Domain = Plugin.Context["skill"]
type Edit = Parameters<Domain["transform"]>[0]
type Entries = ReadonlyArray<Skill.Info>
type Entry = Types.DeepMutable<Skill.Info>
const decodeSkill = Schema.decodeUnknownSync(Skill.Info)

/** The catalog is cached until a registration changes or a plugin reloads it. */
export const makeSkillCatalog = (directory: string): Domain => {
  const edits = new Set<{ readonly edit: Edit }>()
  let cache = Option.none<Entries>()
  const rebuild = () => {
    const entries = new Map<string, Entry>()
    for (const { edit } of edits) {
      edit({
        list: () => [...entries.values()].map((entry) => ({ ...entry })),
        get: (id) => entries.get(id),
        add: (entry) => entries.set(entry.id, { ...decodeSkill(entry) }),
        update: (id, update) => {
          const entry = entries.get(id)
          if (!entry) return
          update(entry)
          entry.id = Skill.ID.make(id)
        },
        remove: (id) => entries.delete(id),
      })
    }
    return [...entries.values()]
  }
  const current = () => Option.getOrElse(cache, () => {
    const data = rebuild()
    cache = Option.some(data)
    return data
  })
  const reload = () => Effect.sync(() => { cache = Option.none() })
  return {
    list: () => Effect.sync(() => ({ location: { directory: AbsolutePath.make(directory) }, data: current() })),
    reload,
    transform: (edit) => Effect.gen(function* () {
      const registration = { edit }
      const dispose = Effect.sync(() => {
        if (edits.delete(registration)) cache = Option.none()
      })
      yield* Scope.addFinalizer(yield* Effect.scope, dispose)
      edits.add(registration)
      yield* reload()
      return { dispose }
    }),
  }
}
