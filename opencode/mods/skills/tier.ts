// Skill tiers, as gent has them. A local skill sits in the project: a skill
// folder (`.opencode/skills`, `.opencode/skill`, `.claude/skills`,
// `.agents/skills`) in the working directory or one of its parents. A global
// skill sits in the user's: OpenCode's config directory and `~/.claude/skills`,
// `~/.agents/skills`. When both tiers hold one id, the local one wins the id
// and the global one stays reachable as `<id>:global`.
//
// OpenCode keeps one skill per id and drops the rest, and which of two
// same-id skills it keeps depends on the order its skill plugins registered
// (a global skill in its config directory can beat a project's `.claude` one).
// So `edits` says, from the scanned files, what to add for each id both tiers
// hold: `<id>:local` and `<id>:global`, which nothing else registers, so the
// `$` popup and the skill tool reach each copy whatever the order; and the
// local copy under the plain id, which holds only when this plugin's transform
// runs after OpenCode's own.
//
// Effect-free: the TUI reads it too.

export type Tier = "local" | "global"

/** The id a tier's copy of a skill both tiers hold is registered under: `review:local`, `review:global`. */
export const qualified = (id: string, tier: Tier = "global") => `${id}:${tier}`

/** The ids both tiers hold. */
export const collisions = (found: ReadonlyArray<Found>): ReadonlySet<string> =>
  new Set([...winners(found)].flatMap(([id, pair]) => (pair.local && pair.global ? [id] : [])))

/** One skill file a scan found, parsed by OpenCode's rules. */
export interface Found {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** The SKILL.md (or top-level .md) file's absolute path. */
  readonly path: string
  /** The file's body after its frontmatter. */
  readonly content: string
  readonly tier: Tier
}

/** A skill in OpenCode's registry, as far as tiers need it. */
export interface Registered {
  readonly id: string
  readonly path: string
}

/** One change to the registry: register `skill` under `id`, replacing what holds that id. */
export interface Edit {
  readonly id: string
  readonly skill: Found
}

/**
 * The first skill of each tier for each id, in scan order (nearest first
 * within a tier, as the scan lists them).
 */
export const winners = (found: ReadonlyArray<Found>): ReadonlyMap<string, { readonly local?: Found; readonly global?: Found }> => {
  const byId = new Map<string, { local?: Found; global?: Found }>()
  for (const skill of found) {
    const entry = byId.get(skill.id) ?? {}
    if (skill.tier === "local" && !entry.local) entry.local = skill
    if (skill.tier === "global" && !entry.global) entry.global = skill
    byId.set(skill.id, entry)
  }
  return byId
}

/**
 * What the registry must change for each id both tiers hold: its local copy
 * under the id (when another holds it) and under `<id>:local`, its global copy
 * under `<id>:global`. Ids only one tier holds, and skills no scan found (a
 * plugin's, a URL's), are left as they are.
 */
export const edits = (registered: ReadonlyArray<Registered>, found: ReadonlyArray<Found>): ReadonlyArray<Edit> => {
  const paths = new Map(registered.map((skill) => [skill.id, skill.path]))
  const changes: Array<Edit> = []
  for (const [id, { local, global }] of winners(found)) {
    if (!local || !global) continue
    if (paths.get(id) !== local.path) changes.push({ id, skill: local })
    changes.push({ id: qualified(id, "local"), skill: local }, { id: qualified(id, "global"), skill: global })
  }
  return changes
}
