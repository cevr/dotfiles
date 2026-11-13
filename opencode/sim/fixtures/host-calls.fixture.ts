// Read by sim/host-calls.test.ts, never loaded: a planted plugin whose host
// calls pass arguments no host law passes, the ways a real plugin does. Two
// through a spread of its own type (a field and a choice only in the type), one
// through a narrowed view of the context (no `Plugin.Context` in sight at the
// call), one a hook name held in a constant; beside them a call whose every
// argument a law passes, which the check must leave alone.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** A letter as the planted plugin keeps it: its own type, `delivery` among its fields. */
interface Letter {
  readonly sessionID: SessionID
  readonly text: string
  readonly delivery: "queue"
}

/** A prompt as the planted plugin keeps it: its own type, `metadata` among its fields (no law prompts with metadata). */
interface Note {
  readonly sessionID: SessionID
  readonly text: string
  readonly metadata: { readonly [key: string]: string }
}

/** The planted plugin's view of the context: a narrowed one, as idle compaction's `Reads` is. */
interface Compacts {
  readonly session: Pick<Plugin.Context["session"], "compact">
}

/** A hook name no law registers, held in a constant. */
const HOOK = "experimental.ws.send"

/** The planted plugin's calls. */
export const planted = (ctx: Plugin.Context, view: Compacts, letter: Letter, note: Note) =>
  Effect.all([
    ctx.session.synthetic({ ...letter }),
    ctx.session.prompt({ ...note }),
    view.session.compact({ sessionID: letter.sessionID, reason: "manual" }),
    ctx.session.hook(HOOK, () => Effect.void),
    ctx.session.get({ sessionID: letter.sessionID }),
  ])
