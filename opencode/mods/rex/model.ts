// The handlers of rex-show: spool what to draw, then make sure the caller's
// session has exactly one showcase pane (`arrange`), made beside the caller's
// pane when it has none. Two calls at once may each make one; each then
// arranges again, so the older stays and the newer is closed.
import { Effect, Option } from "effect"
import type { Pane } from "./pane.ts"
import { arrange, LABEL } from "./showcase.ts"
import { Rex, Spool } from "./service.ts"
import { type Browse, count, type Feed, type Page, type Picture, show, type Sim, type Url } from "./spool.ts"
import type { Tally } from "./status.ts"

/** The showcase panes `arrange` closes, closed. */
const closeAll = Effect.fn("Showcase.closeAll")(function* (session: string, blocks: ReadonlyArray<string>) {
  const rex = yield* Rex
  yield* Effect.forEach(blocks, (block) => rex.close(session, block), { discard: true })
})

/** The showcase `arrange` keeps when its viewer still runs; one whose viewer ended is closed, to be made again. */
const live = Effect.fn("Showcase.live")(function* (session: string, keep: Option.Option<string>) {
  const rex = yield* Rex
  if (Option.isNone(keep)) return keep
  if (yield* rex.running(session, keep.value)) return keep
  yield* rex.close(session, keep.value)
  return Option.none<string>()
})

/**
 * The showcase pane of `pane`'s session: the one already there (the oldest,
 * any other closed) while its viewer runs, or a new one beside `pane`
 * running `viewer`. Its block id.
 */
export const ensureShowcase = Effect.fn("Showcase.ensure")(function* (pane: Pane, viewer: ReadonlyArray<string>) {
  const rex = yield* Rex
  const before = arrange(yield* rex.blocks(pane.session), pane.block)
  yield* closeAll(pane.session, before.close)
  const kept = yield* live(pane.session, before.keep)
  if (Option.isSome(kept)) return kept.value
  const made = yield* rex.split({ session: pane.session, beside: pane.block, label: LABEL, command: viewer })
  const after = arrange(yield* rex.blocks(pane.session), pane.block)
  yield* closeAll(pane.session, after.close)
  return Option.getOrElse(after.keep, () => made)
})

/** Shows `shown` (its file kept in the spool first) in `pane`'s showcase; the showcase's block id. */
export const showFile = Effect.fn("Showcase.show")(function* (pane: Pane, shown: Picture | Page, viewer: ReadonlyArray<string>) {
  const spool = yield* Spool
  const kept = yield* spool.keep(pane.session, shown.file)
  const spooled = yield* spool.read(pane.session)
  yield* spool.write(pane.session, show(spooled, { ...shown, file: kept }))
  return yield* ensureShowcase(pane, viewer)
})

/**
 * Shows a live item in `pane`'s showcase: a web page its viewer shoots, a
 * Sideshow session it follows, a simulator it mirrors, or a live tab; the showcase's block id. Whether the page or
 * Sideshow answers is the viewer's to say, in the pane.
 */
export const showLive = Effect.fn("Showcase.live")(function* (pane: Pane, live: Url | Feed | Sim | Browse, viewer: ReadonlyArray<string>) {
  const spool = yield* Spool
  const spooled = yield* spool.read(pane.session)
  yield* spool.write(pane.session, show(spooled, live))
  return yield* ensureShowcase(pane, viewer)
})

/** Sets the tally `pane`'s showcase reports; the showcase's block id. */
export const setTally = Effect.fn("Showcase.tally")(function* (pane: Pane, tally: Tally, viewer: ReadonlyArray<string>) {
  const spool = yield* Spool
  const spooled = yield* spool.read(pane.session)
  yield* spool.write(pane.session, count(spooled, tally))
  return yield* ensureShowcase(pane, viewer)
})
