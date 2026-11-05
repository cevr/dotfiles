// The dock's shell list as plain values: which of the host's shell commands
// belong to a session, the order they list in, and the words each option
// shows (its state, how long it has run, its last line of output). The
// dialog that draws them and the reads behind it are opencode/shells.ts.
import { elapsed } from "./clock.ts"

/** A shell command as the host's shell routes report it, narrowed to what the list reads. */
export type ShellEntry = {
  readonly id: string
  readonly status: "running" | "exited" | "timeout" | "killed"
  readonly command: string
  readonly exit?: number
  readonly signal?: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly time: { readonly started: number; readonly completed?: number }
}

/** How many shells the list shows: the newest. */
export const SHELLS_SHOWN = 30
/** How many characters of a command or output line an option shows. */
const LINE_CHARS = 72

/** The session's shells, running first, then ended; newest first within each. */
export function sessionShells(shells: ReadonlyArray<ShellEntry>, sessionID: string): ReadonlyArray<ShellEntry> {
  return shells
    .filter((shell) => shell.metadata.sessionID === sessionID)
    .toSorted(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") || b.time.started - a.time.started,
    )
    .slice(0, SHELLS_SHOWN)
}

/** `running`, `exited 0`, `killed`, `timed out`: the words the agent's shell_list uses. */
export function shellState(shell: ShellEntry) {
  if (shell.status === "running") return "running"
  if (shell.status === "exited" && shell.signal === undefined) return `exited ${shell.exit ?? "?"}`
  if (shell.status === "timeout") return "timed out"
  return "killed"
}

/** How long the command has run, or ran. */
export function shellRuntime(shell: ShellEntry, now: number) {
  return elapsed((shell.time.completed ?? now) - shell.time.started)
}

const clip = (text: string) => (text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text)

/** The output's last line with text in it, on one line. */
export function lastLine(output: string) {
  const line = output
    .split(/\r?\n/)
    .map((each) => each.replace(/\s+$/, ""))
    .findLast((each) => each.trim() !== "")
  return line === undefined ? undefined : clip(line.trim())
}

/** What the command is: its description, else its first line. */
export function shellTitle(shell: ShellEntry) {
  const description = shell.metadata.description
  if (typeof description === "string" && description.trim() !== "") return clip(description.trim())
  return clip(shell.command.split("\n")[0]?.trim() ?? "")
}

/** One option of the list: the title, then `state · runtime · last line` under it. */
export function shellOption(shell: ShellEntry, now: number, output: string | undefined) {
  const last = output === undefined ? undefined : lastLine(output)
  return {
    title: shellTitle(shell),
    value: shell.id,
    description: [shellState(shell), shellRuntime(shell, now), last ?? "no output"].join(" · "),
    category: shell.status === "running" ? "Running" : "Ended",
  }
}
