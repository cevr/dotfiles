// The dock's and the picker's subagent rows that scenarios/prime-subagents.ts
// waits for and tests/prime-subagents.test.ts asserts, in one place: a frame is
// kept only once every worker's row is in (a wait on the count alone could keep
// the dock or the picker before the rows under it were drawn, on a loaded host).

/** The dock's count line while the three workers run. */
export const DOCK_COUNT = "◆ 3 subagents"

/** A worker's live row under the dock's count: its state mark, agent, model, title, last update and time. */
export const dockRow = (title: string) => new RegExp(`^[◇◈◆] general gpt  ${title} +.+ · \\d+s$`)

/** A worker's row in the Subagents picker, `working` with its time. */
export const workingRow = (title: string) => new RegExp(`[◆◇◈] general +\\S+ +${title} .* working +\\d+s$`, "m")

/** Whether the frame's dock shows its count with each worker's row under it, in the order they started. */
export function dockRows(titles: ReadonlyArray<string>, frame: string) {
  const lines = frame.split("\n")
  const at = lines.findIndex((line) => line.includes(DOCK_COUNT))
  const rows = lines.slice(at + 1, at + 1 + titles.length).map((line) => line.trim())
  return at >= 0 && titles.every((title, index) => dockRow(title).test(rows[index] ?? ""))
}

/** Whether the frame lists every worker working, as the picker does. */
export const listsWorking = (titles: ReadonlyArray<string>, frame: string) => titles.every((title) => workingRow(title).test(frame))
