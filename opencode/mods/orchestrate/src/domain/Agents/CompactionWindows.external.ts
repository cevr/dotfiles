import { Context, type Effect } from "effect"
import type { Windows } from "../Compaction.ts"

/**
 * The compaction window each agent kind runs at, as the orchestrate tuner's
 * compact.json says now. The tuner rewrites it about once a day; no file, or
 * a broken one, gives the defaults. Reading is synchronous at heart: the
 * host's agent transform runs it inside a synchronous callback.
 */
export class CompactionWindows extends Context.Service<
  CompactionWindows,
  { readonly read: Effect.Effect<Windows> }
>()("dotfiles-opencode/orchestrate/CompactionWindows") {}
