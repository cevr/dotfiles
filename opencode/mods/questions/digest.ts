// The questions' facts for the digest: the owner's questions only (put to no session, asked by no plugin). One line
// when one opens, one when it is answered (with whether the answer is what the agent assumed), one when it closes
// unanswered (withdrawn, superseded, dropped or dismissed). A question put to an orchestrator, or a plugin's, writes
// nothing: the digest shows what waits on the owner.
import { Array as Arr, Match, Option, Predicate } from "effect"
import { DigestEvent, VERSION } from "@dotfiles/opencode-digest/event"
import { redact } from "@dotfiles/opencode-digest/redact"
import { type Event, matches, ownersOf, ownOf, type Row, type Sheet } from "./question.ts"

/** The owner's own rows of a sheet, by id. */
const ownersById = (sheet: Sheet): ReadonlyMap<string, Row> => new Map(ownersOf(ownOf(sheet.rows)).map((row) => [row.id, row]))

const optionsOf = (row: Row): ReadonlyArray<string> => Option.getOrElse(Option.map(Option.fromUndefinedOr(row.options), (options) => options.map((option) => option.label)), Arr.empty)

/**
 * The digest lines of `events` decided on `before` and leading to `after`, in session `sessionID` of run `root` at `t`.
 * A question that opens is read off `after`; one answered or closed, off `before`.
 */
export const linesOf = (root: string, sessionID: string, before: Sheet, after: Sheet, events: ReadonlyArray<Event>, t: number): ReadonlyArray<DigestEvent> => {
  const was = ownersById(before)
  const now = ownersById(after)
  const base = { v: VERSION, t, root, session: sessionID }
  return events.flatMap((event): ReadonlyArray<DigestEvent> =>
    Match.value(event).pipe(
      Match.tag("QuestionOpened", (opened) =>
        Option.toArray(
          Option.map(Option.fromUndefinedOr(now.get(opened.question.id)), (row) =>
            DigestEvent.cases.Asked.make({ ...base, id: row.id, question: row.question, header: Option.fromUndefinedOr(row.header), options: optionsOf(row), assume: row.assume }),
          ),
        ),
      ),
      Match.tag("QuestionAnswered", (answered) =>
        Option.toArray(
          Option.map(
            Option.filter(Option.fromUndefinedOr(was.get(answered.id)), () => Predicate.isUndefined(answered.dismissed)),
            (row) =>
              DigestEvent.cases.Answered.make({
                ...base,
                id: row.id,
                // The session gets the answer as typed; the log keeps it with any secret shape replaced.
                answer: redact(answered.answer),
                matches: matches(answered.answer, row),
                question: Option.some(row.question),
                assume: Option.some(row.assume),
                via: Option.fromUndefinedOr(answered.via),
              }),
          ),
        ),
      ),
      Match.tag("QuestionClosed", (closed) =>
        Option.toArray(
          Option.map(
            Option.filter(Option.fromUndefinedOr(was.get(closed.id)), (row) => closed.reason !== "delivered" && Predicate.isUndefined(row.answered)),
            (row) => DigestEvent.cases.Closed.make({ ...base, id: row.id, reason: closed.reason }),
          ),
        ),
      ),
      Match.orElse(() => []),
    ),
  )
}
