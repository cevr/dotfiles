// The handlers of rex-show: spool what to draw, then make sure the caller's
// session has exactly one showcase pane (`arrange`), made beside the caller's
// pane when it has none. Two calls at once may each make one; each then
// arranges again, so the older stays and the newer is closed.
import { Effect, Option } from "effect"
import type { Pane } from "./pane.ts"
import { arrange, LABEL } from "./showcase.ts"
import { Rex, Spool } from "./service.ts"
import { count, show, type Shown } from "./spool.ts"
import type { Tally } from "./status.ts"

/** The showcase panes `arrange` closes, closed. */
const closeAll = Effect.fn("Showcase.closeAll")(function* (session: string, blocks: ReadonlyArray<string>) {
  const rex = yield* Rex
  yield* Effect.forEach(blocks, (block) => rex.close(session, block), { discard: true })
})

/**
 * The showcase pane of `pane`'s session: the one already there (the oldest,
 * any other closed), or a new one beside `pane` running `viewer`. Its block id.
 */
export const ensureShowcase = Effect.fn("Showcase.ensure")(function* (pane: Pane, viewer: ReadonlyArray<string>) {
  const rex = yield* Rex
  const before = arrange(yield* rex.blocks(pane.session), pane.block)
  yield* closeAll(pane.session, before.close)
  if (Option.isSome(before.keep)) return before.keep.value
  const made = yield* rex.split({ session: pane.session, beside: pane.block, label: LABEL, command: viewer })
  const after = arrange(yield* rex.blocks(pane.session), pane.block)
  yield* closeAll(pane.session, after.close)
  return Option.getOrElse(after.keep, () => made)
})

/** Shows `shown` (its file kept in the spool first) in `pane`'s showcase; the showcase's block id. */
export const showFile = Effect.fn("Showcase.show")(function* (pane: Pane, shown: Shown, viewer: ReadonlyArray<string>) {
  const spool = yield* Spool
  const kept = yield* spool.keep(pane.session, shown.file)
  const spooled = yield* spool.read(pane.session)
  yield* spool.write(pane.session, show(spooled, { ...shown, file: kept }))
  return yield* ensureShowcase(pane, viewer)
})

/** Sets the tally `pane`'s showcase reports; the showcase's block id. */
export const setTally = Effect.fn("Showcase.tally")(function* (pane: Pane, tally: Tally, viewer: ReadonlyArray<string>) {
  const spool = yield* Spool
  const spooled = yield* spool.read(pane.session)
  yield* spool.write(pane.session, count(spooled, tally))
  return yield* ensureShowcase(pane, viewer)
})
