// OpenCode's own state as a Rex program status record: what the TUI writes
// to its terminal (OSC 7501) so Rex's tab header and sidebar show the session
// on screen working, blocked, idle or failed. The state is decided over the
// TUI's view by opencode/state.ts (herdr's decision: the root session of the
// route and its whole family, so any busy member makes the root's tab working
// and any blocked one blocked); this file maps it to one record and decides
// when a record is written. Both are pure: opencode/state.ts feeds them the
// state and a clock and writes what they return. The protocol:
// https://www.superlogical.com/rex/docs/build/program-status.md
import { Equal, Match, Option } from "effect"

/** The record's app: the program Rex names for the root record. */
export const APP = "opencode"

/** The label of a working session when nothing runs: the model is thinking or writing. */
export const THINKING = "thinking"

/** The fewest milliseconds between two writes: state changes only, at most four a second. */
export const GAP_MS = 250

/** What a blocked record waits on, as the protocol names it. */
export type BlockedKind = "permission" | "question"

/**
 * One OSC 7501 report of the root record (no `id`), as the TUI's renderer
 * takes it (`ProgramStatus`): each replaces the record whole; `clear` removes
 * it and every record beneath it.
 */
export type Report =
  | { readonly state: "idle" | "error"; readonly app: string; readonly title?: string; readonly message?: string }
  | { readonly state: "working"; readonly app: string; readonly title?: string; readonly message: string }
  | { readonly state: "blocked"; readonly app: string; readonly kind: BlockedKind; readonly title?: string; readonly message?: string }
  | { readonly state: "clear" }

/**
 * What the TUI shows, as the record reads it: the family's state (`unknown`
 * when no session is open), the root's title, what runs, why it blocks and
 * on what, and whether the root's last run failed.
 */
export interface Seen {
  readonly state: "idle" | "working" | "blocked" | "unknown"
  readonly title?: string
  /** What runs now; only for `working`. */
  readonly working?: string
  /** Why it blocks; only for `blocked`. */
  readonly message?: string
  /** What it blocks on; only for `blocked`. */
  readonly blockedOn?: BlockedKind
  /** The root session's last run ended failed (its `outcome`). */
  readonly failed: boolean
}

/** The protocol's caps on a decoded title and message, in UTF-8 bytes. */
const TITLE_BYTES = 192
const MESSAGE_BYTES = 2048

const isControl = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length

/** `chars` cut until they and an ellipsis fit in `bytes`. */
const cut = (chars: ReadonlyArray<string>, bytes: number): string => {
  const text = `${chars.join("").trimEnd()}…`
  if (chars.length === 0 || bytesOf(text) <= bytes) return text
  return cut(chars.slice(0, -1), bytes)
}

/**
 * `text` as a field the protocol takes: one line (a report holding a control
 * character is refused whole), within `bytes`, cut on a character with an
 * ellipsis; none for empty text.
 */
export const field = (text: Option.Option<string>, bytes: number): Option.Option<string> =>
  Option.map(
    Option.filter(
      Option.map(text, (raw) =>
        Array.from(raw, (char) => Option.match(Option.liftPredicate(char, isControl), { onNone: () => char, onSome: () => " " }))
          .join("")
          .replace(/\s+/g, " ")
          .trim(),
      ),
      (line) => line !== "",
    ),
    (line) => Option.match(Option.liftPredicate(line, (fits) => bytesOf(fits) <= bytes), { onSome: (fits) => fits, onNone: () => cut(Array.from(line), bytes) }),
  )

/** The title, when there is one. */
const titled = (value: Option.Option<string>): { readonly title?: string } => Option.match(value, { onNone: () => ({}), onSome: (title) => ({ title }) })

/** The message, when there is one. */
const messaged = (value: Option.Option<string>): { readonly message?: string } => Option.match(value, { onNone: () => ({}), onSome: (message) => ({ message }) })

/**
 * The record of what the TUI shows:
 * - `working` while any session of the family runs, its message the running
 *   call (`shell: bun test`, `2 subagents`) or "thinking";
 * - `blocked` on a permission (kind `permission`), a question form or the
 *   owner's open background questions (kind `question`), its message naming it;
 * - `error` when nothing works or waits and the root's last run failed;
 * - `idle` otherwise, and with no title when no session is open.
 * The title is the root session's.
 */
export const reportOf = (seen: Seen): Report => {
  const title = titled(field(Option.fromUndefinedOr(seen.title), TITLE_BYTES))
  const message = field(Option.fromUndefinedOr(seen.message), MESSAGE_BYTES)
  return Match.value(seen.state).pipe(
    Match.when("working", (): Report => ({
      state: "working",
      app: APP,
      ...title,
      message: Option.getOrElse(field(Option.fromUndefinedOr(seen.working), MESSAGE_BYTES), () => THINKING),
    })),
    Match.when("blocked", (): Report => ({ state: "blocked", app: APP, kind: seen.blockedOn ?? "question", ...title, ...messaged(message) })),
    Match.orElse((): Report =>
      Option.match(Option.liftPredicate(seen, (it) => it.state === "idle" && it.failed), {
        onSome: (): Report => ({ state: "error", app: APP, ...title, message: "The last run failed" }),
        onNone: (): Report => ({ state: "idle", app: APP, ...title }),
      }),
    ),
  )
}

const CLEAR: Report = { state: "clear" }

/**
 * When records are written: the last one written and when, the newest one
 * held back by the gap, and whether the TUI exited. Outside Rex (`rex`
 * false) it never writes.
 */
export interface Reporting {
  readonly rex: boolean
  readonly sent: Option.Option<Report>
  readonly sentAt: number
  readonly waiting: Option.Option<Report>
  readonly exited: boolean
}

/** Something the reporter hears: a record the view now gives, the clock reaching a wake time, a write the renderer refused, or the TUI exiting. */
export type Event =
  | { readonly type: "show"; readonly report: Report; readonly at: number }
  | { readonly type: "tick"; readonly at: number }
  | { readonly type: "refused"; readonly report: Report; readonly at: number }
  | { readonly type: "exit" }

/** What a step does: the state after, the reports to write now, and when to tick next for a held report. */
export interface Step {
  readonly state: Reporting
  readonly write: ReadonlyArray<Report>
  readonly wake?: number
}

/** A reporter that has written nothing, in a Rex pane or not. */
export const start = (rex: boolean): Reporting => ({ rex, sent: Option.none(), sentAt: Number.NEGATIVE_INFINITY, waiting: Option.none(), exited: false })

const isSent = (state: Reporting, report: Report) => Option.exists(state.sent, (sent) => Equal.equals(sent, report))

const send = (state: Reporting, report: Report, at: number): Step => ({
  state: { ...state, sent: Option.some(report), sentAt: at, waiting: Option.none() },
  write: [report],
})

const nothing = (state: Reporting): Step => ({ state, write: [] })

const held = (state: Reporting, at: number): Step =>
  Option.match(state.waiting, {
    onNone: () => nothing(state),
    onSome: (waiting) =>
      Option.match(Option.liftPredicate(at, (now) => now >= state.sentAt + GAP_MS), {
        onSome: (now) => send(state, waiting, now),
        onNone: () => ({ state, write: [], wake: state.sentAt + GAP_MS }),
      }),
  })

const shown = (state: Reporting, report: Report, at: number): Step => {
  if (isSent(state, report)) return nothing({ ...state, waiting: Option.none() })
  if (at >= state.sentAt + GAP_MS) return send(state, report, at)
  return { state: { ...state, waiting: Option.some(report) }, write: [], wake: state.sentAt + GAP_MS }
}

const refused = (state: Reporting, report: Report): Step => {
  if (!isSent(state, report)) return nothing(state)
  return { state: { ...state, sent: Option.none(), waiting: Option.orElse(state.waiting, () => Option.some(report)) }, write: [], wake: state.sentAt + GAP_MS }
}

/**
 * One step: a record that differs from the last one written is written at
 * once when the gap since that write has passed, else held (the newest held
 * replaces an older one) until a tick at the gap's end; a record equal to the
 * last written drops what was held. A write the renderer refused (it was not
 * queued: the terminal not active yet, its output full) counts as unwritten
 * and is held for the next tick, unless a newer one is. Exiting writes
 * `clear` and ends it: in a Rex pane exit always clears, once, and nothing is
 * written after.
 */
export const step = (state: Reporting, event: Event): Step => {
  if (!state.rex || state.exited) return nothing(state)
  return Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      exit: (): Step => ({ state: { ...state, exited: true, waiting: Option.none(), sent: Option.some(CLEAR) }, write: [CLEAR] }),
      refused: (it) => refused(state, it.report),
      tick: (it) => held(state, it.at),
      show: (it) => shown(state, it.report, it.at),
    }),
  )
}

/** Whether a process environment is a Rex pane's, as Rex sets it for the programs of its terminals. */
export const inRex = (env: Readonly<Partial<Record<string, string>>>): boolean => env.TERM_PROGRAM === "rex" || (env.REX_SESSION ?? "") !== ""
