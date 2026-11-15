// Rex in memory, for the model's tests: sessions of labeled blocks, ids that
// grow as Rex's UUIDv7 ids do, and a pause before each call's answer that the
// test chooses, so calls running at once interleave the way it wants.
import { Effect, Layer, Ref } from "effect"
import { Rex, RexFailed } from "../service.ts"
import type { Block } from "../showcase.ts"

/** A block in memory: its id, label and session. */
export interface Held extends Block {
  readonly session: string
  /** The program a split started in it; none for a block the world began with. */
  readonly command?: ReadonlyArray<string>
}

/** The memory Rex's state: every block, and the last id it gave. */
export interface World {
  readonly blocks: ReadonlyArray<Held>
  readonly last: number
}

/** A block id that sorts after every earlier one, like Rex's UUIDv7 ids. */
export const blockId = (n: number) => `block:${n.toString().padStart(8, "0")}`

/** A world with these blocks, numbered in order. */
export const world = (blocks: ReadonlyArray<Omit<Held, "id">>): World => ({
  blocks: blocks.map((block, at) => ({ ...block, id: blockId(at + 1) })),
  last: blocks.length,
})

/**
 * The Rex over `state`. `pause()` is how many times a call yields before it
 * reads or changes the world; a split beside a block that is not in the
 * session fails, as Rex refuses it.
 */
export const layer = (state: Ref.Ref<World>, pause: () => number = () => 0) => {
  const wait = Effect.suspend(() => Effect.forEach(Array.from({ length: Math.max(0, pause()) }), () => Effect.yieldNow, { discard: true }))
  return Layer.succeed(
    Rex,
    Rex.of({
      blocks: Effect.fn("MemoryRex.blocks")(function* (session: string) {
        yield* wait
        const now = yield* Ref.get(state)
        return now.blocks.filter((block) => block.session === session).map(({ id, label }) => ({ id, label }))
      }),
      split: Effect.fn("MemoryRex.split")(function* (split) {
        yield* wait
        const now = yield* Ref.get(state)
        if (!now.blocks.some((block) => block.session === split.session && block.id === split.beside))
          return yield* new RexFailed({ command: "split", message: `no block ${split.beside} in ${split.session}` })
        const id = blockId(now.last + 1)
        yield* Ref.set(state, { blocks: [...now.blocks, { id, label: split.label, session: split.session, command: split.command }], last: now.last + 1 })
        return id
      }),
      close: Effect.fn("MemoryRex.close")(function* (session: string, block: string) {
        yield* wait
        yield* Ref.update(state, (now) => ({ ...now, blocks: now.blocks.filter((held) => !(held.session === session && held.id === block)) }))
      }),
    }),
  )
}
