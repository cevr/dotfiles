// The handlers: they keep the latest scan of the skill files and answer, from
// it and the registry OpenCode holds, the tier edits, the catalog and a
// prompt's attachments. They require only the SkillFiles contract.
import { Context, Effect, Layer } from "effect"
import { attachments, catalog, type Attachment, type Entry, type Skill } from "./catalog.ts"
import { SkillFiles } from "./service.ts"
import { edits, type Edit, type Found } from "./tier.ts"

export class SkillsModel extends Context.Service<
  SkillsModel,
  {
    /** Scans the files again; true when what it found changed since the last scan. */
    readonly rescan: Effect.Effect<boolean>
    /** The tier edits for a registry, from the latest scan. Synchronous: a skill transform calls it. */
    readonly edits: (registered: ReadonlyArray<Skill>) => ReadonlyArray<Edit>
    /** The catalog of a registry, from the latest scan. */
    readonly catalog: (registered: ReadonlyArray<Skill>) => ReadonlyArray<Entry>
    /** The skills a prompt's `$` tokens add to what it attaches already. */
    readonly attach: (text: string, attached: ReadonlyArray<string>, registered: ReadonlyArray<Skill>) => ReadonlyArray<Attachment>
  }
>()("dotfiles-opencode/skills/SkillsModel") {}

const same = (a: ReadonlyArray<Found>, b: ReadonlyArray<Found>) => JSON.stringify(a) === JSON.stringify(b)

/** The model over SkillFiles; it scans once when built. */
export const layer = Layer.effect(
  SkillsModel,
  Effect.gen(function* () {
    const files = yield* SkillFiles
    let latest = yield* files.scan
    return SkillsModel.of({
      rescan: files.scan.pipe(
        Effect.map((next) => {
          if (same(next, latest)) return false
          latest = next
          return true
        }),
        Effect.withSpan("SkillsModel.rescan"),
      ),
      edits: (registered) => edits(registered, latest),
      catalog: (registered) => catalog(registered, latest),
      attach: (text, attached, registered) => attachments(text, attached, catalog(registered, latest)),
    })
  }),
)
