// The transcript map's collapsed turns in the Prime look, without rendering:
// the words a turn's one line says (tui/map.tsx draws them). The host folds
// the transcript to one line a turn (its `session.map.turn` slot, ctrl+x g)
// and gives each its kind, its line of text, its work and its time.
import { Array as Arr, Match, Option } from "effect"

/** One collapsed turn as the host's `session.map.turn` slot gives it. */
export type MapTurn = {
  readonly sessionID: string
  readonly messageID: string
  readonly kind: "user" | "agent" | "notice" | "compaction"
  /** A prompt's first line, a notice's title, a run's first sentence (empty when it wrote none). */
  readonly text: string
  /** A notice's sender (`subagent`, `shell`, `mail`, …). */
  readonly source?: string
  readonly thoughts: number
  readonly tools: number
  /** When the turn reads as happening (ms): a prompt or notice when sent, a run when its last step ended. */
  readonly time: number
  readonly selected: boolean
}

const said = (text: string) => text !== ""
const plural = (count: number) => Match.value(count).pipe(Match.when(1, () => ""), Match.orElse(() => "s"))
const counted = (count: number, noun: string) => Arr.filter([`${count} ${noun}${plural(count)}`], () => count > 0)

/** A run's work as the transcript's folded row words it, `+ 2 thoughts, 3 tools`; empty when it did none. */
export const mapWork = (turn: Pick<MapTurn, "thoughts" | "tools">): string =>
  Option.match(Option.liftPredicate([...counted(turn.thoughts, "thought"), ...counted(turn.tools, "tool")], Arr.isArrayNonEmpty), {
    onNone: () => "",
    onSome: (words) => `+ ${words.join(", ")}`,
  })

/** What follows a run's sentence on its line: ` · ` and its work (its work alone when it wrote no text). */
export const mapWorkTail = (turn: Pick<MapTurn, "text" | "thoughts" | "tools">): string =>
  Option.match(Option.liftPredicate(mapWork(turn), said), {
    onNone: () => "",
    onSome: (work) => Option.match(Option.liftPredicate(turn.text, said), { onNone: () => work, onSome: () => ` · ${work}` }),
  })

type Tone = "muted" | "warning" | "error"
/** How a worker's or shell's stop notice reads, in notice.ts's words and tones (`noticeGroup`). */
export type MapNotice = {
  readonly glyph: { readonly char: string; readonly tone: Tone }
  readonly actor: string
  readonly word: string
  readonly tone: Tone
  /** ` · ` and its task, or nothing when it names none. */
  readonly tail: string
}

type Ending = { readonly glyph: MapNotice["glyph"]; readonly tone: Tone }
/** How the notice's word reads: `finished` (and anything the title's pattern lets through) muted. */
const ending = (word: string): Ending =>
  Match.value(word).pipe(
    Match.when("failed", (): Ending => ({ glyph: { char: "✗", tone: "error" }, tone: "error" })),
    Match.when("cancelled", (): Ending => ({ glyph: { char: "●", tone: "warning" }, tone: "warning" })),
    Match.orElse((): Ending => ({ glyph: { char: "●", tone: "muted" }, tone: "muted" })),
  )
const group = (match: RegExpExecArray, index: number) => Option.getOrElse(Option.fromNullishOr(match[index]), () => "")

/**
 * A stop notice from its title (`Implementor finished · fix csv`, the host's outline words): `● Implementor
 * finished · fix csv`, `✗ Shell failed · …` (error), `● Worker cancelled` (warning). None for any other notice.
 */
export const mapNotice = (turn: Pick<MapTurn, "kind" | "source" | "text">): Option.Option<MapNotice> =>
  Option.liftPredicate(turn, (each) => each.kind === "notice" && (each.source === "subagent" || each.source === "shell")).pipe(
    Option.flatMap((each) => Option.fromNullishOr(/^(.+?) (finished|failed|cancelled)(?: · (.*))?$/s.exec(each.text))),
    Option.map((match) => ({
      ...ending(group(match, 2)),
      actor: group(match, 1),
      word: group(match, 2),
      tail: Arr.map(Arr.filter([group(match, 3)], said), (task) => ` · ${task}`).join(""),
    })),
  )

/** Any other notice's glyph, as the host's notice row draws it: `◎` a goal, `✉` mail, `◈` the rest. */
export const mapNoticeGlyph = (source: string): string =>
  Match.value(source).pipe(
    Match.when("goal", () => "◎"),
    Match.when("mail", () => "✉"),
    Match.orElse(() => "◈"),
  )
