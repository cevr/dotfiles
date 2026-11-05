// Sessions held in memory: what each received, under which id and whether it
// woke the session, the sessions fires started, and each session's parent.
// `refusing` makes deliveries to a session fail, as a host that would not take
// them. The model's tests and the plugin's seam test use it.
import { Effect, Layer } from "effect"
import type { Letter } from "../message.ts"
import { Courier, DeliveryRefused } from "../service.ts"

export interface Received {
  readonly id: string
  readonly letter: Letter
  readonly resume: boolean
}

export interface Started {
  readonly directory: string
  readonly prompts: Array<{ readonly id: string; readonly text: string }>
}

export interface MemorySessions {
  readonly inboxes: Map<string, Array<Received>>
  readonly parents: Map<string, string>
  readonly started: Map<string, Started>
  readonly refusing: Map<string, string>
  minted: number
}

export const empty = (...sessionIDs: ReadonlyArray<string>): MemorySessions => ({
  inboxes: new Map(sessionIDs.map((sessionID) => [sessionID, []])),
  parents: new Map(),
  started: new Map(),
  refusing: new Map(),
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
  })
