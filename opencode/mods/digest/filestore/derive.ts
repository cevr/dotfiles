// The digest of a frozen day, as the acceptance check reads it (`accept/derive.accept.test.ts` in the run's folder):
// `derive(dir, { now })` backfills the folder's old stores into events (backfill.ts), folds them (fold.ts) and reads
// the messages (messages.ts), then names them as the check does: orchestrations (a project and its status),
// outcomes (a message), units by `<project>/<unit>`, events (each fact, a unit's under the message it sits under),
// needs (each question and needs-you item) and entries (the messages he reads, newest first). No clock, no network,
// no model: the same folder gives the same bytes.
import { Array as Arr, Option, Order } from "effect"
import { backfill } from "../backfill.ts"
import type { DigestEvent } from "../event.ts"
import { EMPTY, fold, isStep, rootOf, type State } from "../fold.ts"
import { readStores } from "./stores.ts"
import { type Message, type ProjectView, projectsOf } from "../messages.ts"

export interface Orchestration {
  readonly id: string
  readonly name: string
  readonly status: "go" | "watch" | "nogo"
  readonly reason: string
}

export interface Outcome {
  readonly id: string
  readonly orch: string
  readonly kind: string
  readonly subject: string
  readonly t: number
  readonly units: ReadonlyArray<string>
  readonly events: ReadonlyArray<string>
}

export interface UnitOf {
  readonly id: string
  readonly purpose: string
  readonly rounds: ReadonlyArray<{ readonly n: number; readonly verdict: string }>
}

export interface Fact {
  readonly id: string
  readonly t: number
  readonly kind: string
  readonly unit?: string
  readonly outcome?: string
}

export interface Need {
  readonly id: string
  readonly orch: string
  readonly question: string
  readonly assumption: string
  readonly answer: string
  readonly differs: boolean
  readonly open: boolean
}

export interface Entry {
  readonly id: string
  readonly orch: string
  readonly t: number
  readonly subject: string
}

export interface Digest {
  readonly orchestrations: ReadonlyArray<Orchestration>
  readonly outcomes: ReadonlyArray<Outcome>
  readonly units: Readonly<Record<string, UnitOf>>
  readonly events: ReadonlyArray<Fact>
  readonly needs: ReadonlyArray<Need>
  readonly entries: ReadonlyArray<Entry>
}

const statusOf = (view: ProjectView): Orchestration["status"] => {
  if (view.project.level === "red") return "nogo"
  if (view.project.level === "need") return "watch"
  return "go"
}

/** The units of an event, for a project's roots: its unit, or the units of a verdict's rows. */
const unitsOfEvent = (event: DigestEvent): ReadonlyArray<string> => {
  if (event._tag === "Lane") return [event.unit]
  if (isStep(event)) return Arr.filter([event.unit], () => event.role !== "verifier")
  if (event._tag === "Verdict") return Arr.match(event.units, { onEmpty: () => Arr.filter([event.batch], (batch) => !batch.startsWith("batch-")), onNonEmpty: (rows) => rows.map((row) => row.unit) })
  if (event._tag === "Item") return Option.toArray(event.unit)
  return []
}

/** Every fact as an event of the digest, a unit's under the message that unit sits under. */
const factsOf = (events: ReadonlyArray<DigestEvent>, views: ReadonlyArray<ProjectView>): ReadonlyArray<Fact> => {
  const projectOf = new Map(views.flatMap((view) => view.project.roots.map((root) => [root, view] as const)))
  return events.flatMap((event, at) => {
    const view = Option.flatMap(rootOf(event), (root) => Option.fromUndefinedOr(projectOf.get(root)))
    return Arr.match(unitsOfEvent(event), {
      onEmpty: () => [{ id: `e${at}`, t: event.t, kind: event._tag }],
      onNonEmpty: (units) =>
        units.flatMap((unit, row) =>
          Option.toArray(
            Option.flatMap(view, (each) =>
              Option.map(Option.fromUndefinedOr(each.unitMessage.get(unit)), (outcome) => ({ id: `e${at}.${row}`, t: event.t, kind: event._tag, unit: `${each.project.id}/${unit}`, outcome })),
            ),
          ),
        ),
    })
  })
}

const needsOf = (view: ProjectView): ReadonlyArray<Need> =>
  view.project.messages.flatMap((message: Message): ReadonlyArray<Need> => {
    if (Option.isSome(message.ask))
      return [{ id: `${view.project.id}:${message.ask.value.ref}`, orch: view.project.id, question: message.subject, assumption: Option.getOrElse(message.ask.value.assume, () => ""), answer: "", differs: false, open: true }]
    if (Option.isSome(message.decided))
      return message.decided.value.map((each, at) => ({
        id: `${view.project.id}:${Option.getOrElse(Arr.get(message.src.replace(/^question:/, "").split(","), at), () => each.q)}`,
        orch: view.project.id,
        question: each.q,
        assumption: each.assumed,
        answer: each.said,
        differs: !each.matches,
        open: false,
      }))
    if (message.open) return [{ id: `${view.project.id}:${message.src.replace(/^item:/, "")}`, orch: view.project.id, question: `${message.subject} ${message.body}`.trim(), assumption: "", answer: "", differs: false, open: true }]
    return []
  })

/** The digest of folded events. */
export const digestOf = (events: ReadonlyArray<DigestEvent>, state: State): Digest => {
  const views = projectsOf(state, { names: new Map() })
  const facts = factsOf(events, views)
  const byOutcome = Arr.groupBy(
    facts.flatMap((fact) => Option.toArray(Option.map(Option.fromUndefinedOr(fact.outcome), (outcome) => ({ outcome, id: fact.id })))),
    (fact) => fact.outcome,
  )
  const outcomes = views.flatMap((view) =>
    view.project.messages.map((message) => ({
      id: message.id,
      orch: view.project.id,
      kind: message.kind,
      subject: message.subject,
      t: message.t,
      units: message.units.map((unit) => `${view.project.id}/${unit.name}`),
      events: (byOutcome[message.id] ?? []).map((fact) => fact.id),
    })),
  )
  const units = Object.fromEntries(
    views.flatMap((view) =>
      view.project.messages.flatMap((message) =>
        message.units.map((unit) => [
          `${view.project.id}/${unit.name}`,
          {
            id: `${view.project.id}/${unit.name}`,
            purpose: Option.getOrElse(unit.purpose, () => ""),
            rounds: unit.rounds.flatMap((round) => Option.toArray(Option.map(round.verdict, (verdict) => ({ n: round.n, verdict })))),
          },
        ]),
      ),
    ),
  )
  const entries = Arr.sort(
    outcomes.filter((outcome) => outcome.t > 0).map((outcome) => ({ id: outcome.id, orch: outcome.orch, t: outcome.t, subject: outcome.subject })),
    Order.combine(Order.mapInput(Order.flip(Order.Number), (entry: Entry) => entry.t), Order.mapInput(Order.String, (entry: Entry) => entry.id)),
  )
  return {
    orchestrations: views.map((view) => ({
      id: view.project.id,
      name: view.project.name,
      status: statusOf(view),
      reason: Option.getOrElse(Option.liftPredicate(view.project.headline, (line) => line !== ""), () => "Nothing new from this run."),
    })),
    outcomes,
    units,
    events: facts,
    needs: views.flatMap(needsOf),
    entries,
  }
}

/** The digest of the frozen day at `dir`. `now` is the moment it is read at; the fold itself needs no clock. */
export const derive = (dir: string, _opts: { readonly now: number }): Digest => {
  const events = backfill(readStores(dir))
  return digestOf(events, fold(EMPTY, events))
}
