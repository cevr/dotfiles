// Sessions held in memory: what each received, under which id and whether it
// woke the session, the sessions fires started, each session's parent, and
// the latches' children with their marks.
// `refusing` makes deliveries to a session fail, as a host that would not take
// them, and `archived` refuses an archived session's as the host does. The
// model's tests and the plugin's seam test use it.
import { Effect, Layer } from "effect"
import type { Mark } from "../latch.ts"
import type { Letter } from "../message.ts"
import { type Child, Courier, DeliveryRefused } from "../service.ts"

export interface Received {
  readonly id: string
  readonly letter: Letter
  readonly resume: boolean
}

export interface Started {
  readonly directory: string
  readonly prompts: Array<{ readonly id: string; readonly text: string }>
}

/** A latch's child as it was made, and its mark now (none once cleared). */
export interface Made extends Omit<Child, "mark"> {
  readonly mark: Mark | undefined
}

export interface MemorySessions {
  readonly inboxes: Map<string, Array<Received>>
  readonly parents: Map<string, string>
  readonly started: Map<string, Started>
  readonly refusing: Map<string, string>
  readonly children: Map<string, Made>
  /** Sessions archived: a delivery to one is refused as the host refuses it, and nothing is admitted. A world kept before this has none. */
  readonly archived?: Set<string>
  minted: number
}

export const empty = (...sessionIDs: ReadonlyArray<string>): MemorySessions => ({
  inboxes: new Map(sessionIDs.map((sessionID) => [sessionID, []])),
  parents: new Map(),
  started: new Map(),
  refusing: new Map(),
  children: new Map(),
  archived: new Set(),
  minted: 0,
})

const mint = (memory: MemorySessions, prefix: string) =>
  Effect.sync(() => {
    memory.minted += 1
    return `${prefix}${String(memory.minted).padStart(12, "0")}`
  })

export const layer = (memory: MemorySessions) =>
  Layer.succeed(Courier, {
    newDelivery: mint(memory, "msg_"),
    newSession: mint(memory, "ses_"),
    deliver: (sessionID, delivery, letter, resume) =>
      Effect.suspend(() => {
        const inbox = memory.inboxes.get(sessionID)
        const refusing = memory.refusing.get(sessionID)
        if (inbox === undefined) return Effect.fail(new DeliveryRefused({ sessionID, message: `no session ${sessionID}`, gone: true }))
        if (memory.archived?.has(sessionID) === true) return Effect.fail(new DeliveryRefused({ sessionID, message: `Session ${sessionID} is archived`, gone: false, archived: true }))
        if (refusing !== undefined) return Effect.fail(new DeliveryRefused({ sessionID, message: refusing, gone: false }))
        if (!inbox.some((message) => message.id === delivery)) inbox.push({ id: delivery, letter, resume })
        return Effect.void
      }),
    start: ({ sessionID, directory, delivery, text }) =>
      Effect.sync(() => {
        const started = memory.started.get(sessionID) ?? { directory, prompts: [] }
        memory.started.set(sessionID, started)
        if (!started.prompts.some((prompt) => prompt.id === delivery)) started.prompts.push({ id: delivery, text })
      }),
    parentOf: (sessionID) => Effect.sync(() => memory.parents.get(sessionID)),
    child: (child) =>
      Effect.suspend(() => {
        if (!memory.inboxes.has(child.parentID)) return Effect.fail(new DeliveryRefused({ sessionID: child.parentID, message: `no session ${child.parentID}`, gone: true }))
        if (!memory.children.has(child.sessionID)) {
          memory.children.set(child.sessionID, child)
          memory.parents.set(child.sessionID, child.parentID)
          memory.inboxes.set(child.sessionID, [])
        }
        return Effect.void
      }),
    mark: (sessionID, mark) =>
      Effect.suspend(() => {
        if (!memory.inboxes.has(sessionID)) return Effect.fail(new DeliveryRefused({ sessionID, message: `no session ${sessionID}`, gone: true }))
        const made = memory.children.get(sessionID)
        if (made !== undefined) memory.children.set(sessionID, { ...made, mark })
        return Effect.void
      }),
  })
