/**
 * The escape mod's server plugin: queued prompts arrive as one message. When
 * a session goes idle with two or more user prompts queued for after the turn
 * (leader+Enter), the fork's `experimental.queue.deliver` hook asks how many of
 * them to deliver together; `deliver` answers all of them, the texts joined by
 * a newline (`@dotfiles/opencode-escape/take` SEPARATOR), the attachments in
 * order. A queued control (a compaction, a move) still runs where it was
 * queued: the host offers only the prompts before it. Steers keep their own
 * delivery, one message each at the next step. On a host without the hook it
 * registers a hook nothing calls, and each queued prompt goes out alone.
 * tests/queue-merge.test.ts runs it in OpenCode.
 */
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { SEPARATOR } from "@dotfiles/opencode-escape/take"

/** The hook's event, as far as the plugin reads and sets it. */
export interface Deliver {
  readonly prompts: ReadonlyArray<unknown>
  take: number
  separator: string
}

/** Delivers every queued prompt the host offers as one message, joined by a newline. */
export const deliver = (event: Deliver) => {
  event.take = event.prompts.length
  event.separator = SEPARATOR
}

export default Plugin.define({
  id: "dotfiles-opencode.escape",
  effect: Effect.fn("Escape.plugin")(function* (ctx) {
    yield* ctx.session.hook("experimental.queue.deliver", (event) => Effect.sync(() => deliver(event)))
  }),
})
