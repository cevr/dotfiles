// Sheets held in memory: each session's sheet, or why it cannot be read. The
// model's tests and the plugin's seam test use it.
import { Effect, Layer } from "effect"
import { EMPTY, type Sheet } from "../question.ts"
import { QuestionStore, QuestionsUnreadable } from "../service.ts"

/** The store's contents: each session's sheet, and the sessions whose sheet reads as broken (with why). */
export interface MemorySheets {
  readonly sheets: Map<string, Sheet>
  readonly broken: Map<string, string>
}

export const empty = (): MemorySheets => ({ sheets: new Map(), broken: new Map() })

export const layer = (memory: MemorySheets) =>
  Layer.succeed(QuestionStore, {
    read: (sessionID) =>
      Effect.suspend(() => {
        const broken = memory.broken.get(sessionID)
        return broken === undefined ? Effect.succeed(memory.sheets.get(sessionID) ?? EMPTY) : Effect.fail(new QuestionsUnreadable({ message: broken }))
      }),
    write: (sessionID, sheet) =>
      Effect.sync(() => {
        memory.broken.delete(sessionID)
        memory.sheets.set(sessionID, sheet)
      }),
    remove: (sessionID) =>
      Effect.sync(() => {
        memory.broken.delete(sessionID)
        memory.sheets.delete(sessionID)
      }),
    sessions: Effect.sync(() => [...new Set([...memory.sheets.keys(), ...memory.broken.keys()])]),
  })
