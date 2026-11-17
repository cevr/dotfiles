// Prime's row under a finished turn (mods/prime/turn-time.ts), as a real-OpenCode frame test reads it. The row
// shows once the turn's completion reaches the TUI, so a frame taken near a turn's end may or may not hold it: a
// test that reads rows by index, length or sequence drops it (`withoutTurnTime`), and where the order is the
// test's subject it checks that each one present sits under the last row of a turn (`timedRows`).
import { TURN_TIME_ROW } from "../mods/prime/turn-time.ts"

/** Whether a frame's line is the turn-time row. */
export const isTurnTime = (line: string): boolean => TURN_TIME_ROW.test(line)

/** The frame's lines without the turn-time rows. */
export const withoutTurnTime = (lines: ReadonlyArray<string>): ReadonlyArray<string> => lines.filter((line) => !isTurnTime(line))

/** The row right above each turn-time row, blank rows skipped: the last row of the turn it closes. */
export const timedRows = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const kept = lines.filter((line) => line.trim() !== "")
  return kept.filter((line, index) => !isTurnTime(line) && kept.slice(index + 1, index + 2).some(isTurnTime))
}

/** Of `rows`, the ones a turn-time row sits under in `lines`. */
export const timedAmong = (lines: ReadonlyArray<string>, rows: ReadonlyArray<string>): ReadonlyArray<string> =>
  timedRows(lines).filter((line) => rows.includes(line))
