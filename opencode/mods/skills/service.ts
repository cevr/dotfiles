// The contract the skills plugin needs from outside: the skill files on disk,
// by tier. `laws.ts` states what every implementation owes.
import { Context, type Effect } from "effect"
import type { Found } from "./tier.ts"

/**
 * The skill files OpenCode would load for one working directory, each tier's
 * nearest first: the local tier's (the directory and its parents) before the
 * global tier's (the user's). A folder that is missing or cannot be read holds
 * no skills, as OpenCode reads it, so a scan does not fail.
 */
export class SkillFiles extends Context.Service<
  SkillFiles,
  {
    readonly scan: Effect.Effect<ReadonlyArray<Found>>
  }
>()("dotfiles-opencode/skills/SkillFiles") {}
