import { Context, type Effect } from "effect"
import type { Pace } from "../Pace.ts"

/**
 * The Codex account's pace for one new agent: the orchestrate skill's
 * admission script, asked with the model id and the role (`none` for a
 * non-role agent). Only the script's own answer holds; anything else is
 * undefined and fails open.
 */
export class CodexAdmission extends Context.Service<
  CodexAdmission,
  { readonly admit: (model: string, role: string) => Effect.Effect<Pace | undefined> }
>()("dotfiles-opencode/orchestrate/CodexAdmission") {}
