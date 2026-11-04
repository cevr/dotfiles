import { Context, type Effect } from "effect"
import type { CallLine } from "../CallLine.ts"

/** Where the call log's lines go, in order. Appending never fails: a lost line costs the pane a row, not the call. */
export class CallLog extends Context.Service<
  CallLog,
  { readonly append: (line: CallLine) => Effect.Effect<void> }
>()("dotfiles-opencode/orchestrate/CallLog") {}
