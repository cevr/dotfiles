// Sessions held in memory, each with the messages it received, and who each
// one is (its parent, title and agent). The model's tests and the plugin's
// seam test use it; `refuse` makes the next deliveries to a session fail, as a
// host that would not take them.
import { Effect, Layer } from "effect"
import type { Letter } from "../reply.ts"
import { Courier, DeliveryRefused, Family, type SessionInfo } from "../service.ts"

export interface MemorySessions {
  /** Each open session's messages, in the order they arrived. */
  readonly inboxes: Map<string, Array<{ readonly id: string; readonly letter: Letter }>>
  /** The ids of the messages delivered without waking the session (notices). */
  readonly quiet: Set<string>
  /** Sessions that refuse what is delivered, with why. */
  readonly refusing: Map<string, string>
  /** Who each session is; an open session missing here is a root with no title. */
  readonly family: Map<string, SessionInfo>
  minted: number
}

export const empty = (...sessionIDs: ReadonlyArray<string>): MemorySessions => ({
  inboxes: new Map(sessionIDs.map((sessionID) => [sessionID, []])),
  quiet: new Set(),
  refusing: new Map(),
  family: new Map(),
  minted: 0,
})

/** Open `session` as a subagent of `parentID`. */
export const child = (memory: MemorySessions, session: SessionInfo & { readonly parentID: string }): void => {
  memory.inboxes.set(session.id, memory.inboxes.get(session.id) ?? [])
  memory.family.set(session.id, session)
}

export const layer = (memory: MemorySessions) => {
  const put = (wake: boolean) => (sessionID: string, delivery: string, letter: Letter) =>
    Effect.suspend(() => {
      const inbox = memory.inboxes.get(sessionID)
      const refusing = memory.refusing.get(sessionID)
      if (inbox === undefined) return Effect.fail(new DeliveryRefused({ sessionID, message: `no session ${sessionID}`, gone: true }))
      if (refusing !== undefined) return Effect.fail(new DeliveryRefused({ sessionID, message: refusing, gone: false }))
      if (!inbox.some((message) => message.id === delivery)) {
        inbox.push({ id: delivery, letter })
        if (!wake) memory.quiet.add(delivery)
      }
      return Effect.void
    })
  return Layer.merge(
    Layer.succeed(Courier, {
      newDelivery: Effect.sync(() => {
        memory.minted += 1
        return `msg_${String(memory.minted).padStart(12, "0")}`
      }),
      deliver: put(true),
      notify: put(false),
    }),
    Layer.succeed(Family, {
      info: (sessionID) =>
        Effect.sync(() => memory.family.get(sessionID) ?? (memory.inboxes.has(sessionID) ? { id: sessionID } : undefined)),
    }),
  )
}
