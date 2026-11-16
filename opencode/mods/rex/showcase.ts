// The showcase pane: one pane per Rex session, labeled `showcase`, beside
// the pane of whoever asked first, where rex-show draws. The rule that keeps
// it one: of the blocks labeled `showcase` in the session, the oldest stays
// (Rex's block ids are UUIDv7, so the smallest id is the oldest) and every
// other is closed; with none, one is made. The caller's own pane is never
// taken for the showcase, nor closed, whatever its label.
import { Array as Arr, Option, Order } from "effect"

/** The label that marks the showcase pane. */
export const LABEL = "showcase"

/** A block of a Rex session, as `rex block ls --json` lists it. */
export interface Block {
  readonly id: string
  readonly label: string
}

/** What to do about a session's showcase panes: keep one (or make one, when none is kept), and close the rest. */
export interface Arrangement {
  readonly keep: Option.Option<string>
  readonly close: ReadonlyArray<string>
}

const byId = Order.mapInput(Order.String, (block: Block) => block.id)

/** The showcase panes of a session's blocks, `caller`'s own pane aside: keep the oldest, close the others. */
export const arrange = (blocks: ReadonlyArray<Block>, caller: string): Arrangement => {
  const showcases = Arr.sort(
    blocks.filter((block) => block.label === LABEL && block.id !== caller),
    byId,
  )
  return { keep: Option.map(Arr.head(showcases), (block) => block.id), close: showcases.slice(1).map((block) => block.id) }
}
