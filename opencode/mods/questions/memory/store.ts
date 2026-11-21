// Sheets held in memory: each session's sheet, or why it cannot be read. The
// model's tests and the plugin's seam test use it. A write is conditional on
// the rev read, as the fork's storage `setIf` is (opencode/store.ts).
import { Effect, Equal, Layer, Option } from "effect"
import { EMPTY, type Sheet } from "../question.ts"
import { QuestionStore, QuestionsUnreadable } from "../service.ts"

/** The store's contents: each session's sheet, and the sessions whose sheet reads as broken (with why). */
export interface MemorySheets {
  readonly sheets: Map<string, Sheet>
  readonly broken: Map<string, string>
}

export const empty = (): MemorySheets => ({ sheets: new Map(), broken: new Map() })

/** The rev a stored sheet reads at: its own, 0 for one stored before revs; none when nothing is stored. */
const revOf = (memory: MemorySheets, sessionID: string): Option.Option<number> =>
  Option.map(Option.fromUndefinedOr(memory.sheets.get(sessionID)), (sheet) => Option.getOrElse(Option.fromUndefinedOr(sheet.rev), () => 0))

export const layer = (memory: MemorySheets) =>
  Layer.succeed(QuestionStore, {
    read: (sessionID) =>
      Effect.suspend(() => {
        const broken = memory.broken.get(sessionID)
        if (broken !== undefined) return Effect.fail(new QuestionsUnreadable({ message: broken }))
        return Effect.succeed(Option.match(Option.fromUndefinedOr(memory.sheets.get(sessionID)), { onNone: () => EMPTY, onSome: (sheet) => ({ ...sheet, rev: Option.getOrElse(revOf(memory, sessionID), () => 0) }) }))
      }),
    writeIf: (sessionID, sheet, rev) =>
      Effect.sync(() => {
        if (!Equal.equals(revOf(memory, sessionID), rev)) return false
        memory.broken.delete(sessionID)
        memory.sheets.set(sessionID, { ...sheet, rev: Option.getOrElse(rev, () => 0) + 1 })
        return true
      }),
    remove: (sessionID) =>
      Effect.sync(() => {
        memory.broken.delete(sessionID)
        memory.sheets.delete(sessionID)
      }),
    sessions: Effect.sync(() => [...new Set([...memory.sheets.keys(), ...memory.broken.keys()])]),
  })
