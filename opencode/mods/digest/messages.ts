// The digest's messages: projects, each with its messages newest first, each message with its units, their rounds
// and agents. A pure function of the folded state (fold.ts) and the owner's renames: nothing is invented, so a
// message's words are its run's own (a queue item's text, a `Digest:` line, a question) or, with none, the unit's
// lane purpose and what happened to it. Read state, Later and pinning are the page's (view.ts), over these.
//
// - A project is a run: the run records of its roots, by the run's name. Its name is the repository, with the
//   run's name added when two projects share one; a rename (names) wins.
// - A message is a queue item of a root; an open or answered question; a batch's verdict; a unit no item or
//   verdict names; a failed land check; an install. A unit sits under exactly one message: the newest item that
//   names it, else the newest verdict that holds it, else its own.
// - Colour comes from data only: red from an item's `level: red` or a failed land check not followed by a land;
//   "Needs you" from an open question or a needs-you item. Never from words.
import { Array as Arr, Option, Order, Schema } from "effect"
import { clip } from "./event.ts"
import { type Answered, type Asked, type HandBack, type Item, type ItemGone, keyOf, type Lane, type Run, type Start, type State, type Verdict } from "./fold.ts"

const maybe = Schema.OptionFromOptionalKey

export const Round = Schema.Struct({
  n: Schema.Int,
  handed: maybe(Schema.Finite),
  verdict: maybe(Schema.String),
  batch: maybe(Schema.String),
  verdictAt: maybe(Schema.Finite),
  request: maybe(Schema.String),
  findings: maybe(Schema.String),
})
export type Round = typeof Round.Type

export const Agent = Schema.Struct({ role: Schema.String, start: Schema.Finite, end: maybe(Schema.Finite) })
export type Agent = typeof Agent.Type

export const UnitView = Schema.Struct({ name: Schema.String, purpose: maybe(Schema.String), rounds: Schema.Array(Round), agents: Schema.Array(Agent) })
export type UnitView = typeof UnitView.Type

export const Ask = Schema.Struct({ ref: Schema.String, options: Schema.Array(Schema.String), assume: maybe(Schema.String) })
export const Decision = Schema.Struct({ q: Schema.String, assumed: Schema.String, said: Schema.String, matches: Schema.Boolean })
export type Decision = typeof Decision.Type

export const KINDS = ["shipped", "stuck", "needs", "decided", "fyi"] as const
export const Kind = Schema.Literals(KINDS)
export type Kind = typeof Kind.Type
export const MessageLevel = Schema.Literals(["red", "need", "ok", "none"])
export type MessageLevel = typeof MessageLevel.Type

export const Message = Schema.Struct({
  id: Schema.String,
  /** Where it comes from: `item:<id>`, `question:<ref>`, `verdict:<batch>`, `unit:<name>`, `check`, `install`. */
  src: Schema.String,
  kind: Kind,
  level: MessageLevel,
  subject: Schema.String,
  body: Schema.String,
  t: Schema.Finite,
  units: Schema.Array(UnitView),
  ask: maybe(Ask),
  decided: maybe(Schema.Array(Decision)),
  /** A needs-you message not yet answered. */
  open: Schema.Boolean,
  /** The root session of the run it belongs to. */
  root: Schema.String,
})
export type Message = typeof Message.Type

export const ProjectLevel = Schema.Literals(["red", "need", "none"])
export type ProjectLevel = typeof ProjectLevel.Type

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  where: Schema.String,
  host: Schema.String,
  repo: Schema.String,
  roots: Schema.Array(Schema.String),
  level: ProjectLevel,
  headline: Schema.String,
  messages: Schema.Array(Message),
})
export type Project = typeof Project.Type

export const Evidence = Schema.Struct({ path: Schema.String, excerpt: Schema.String })

export const Page = Schema.Struct({
  projects: Schema.Array(Project),
  evidence: Schema.Record(Schema.String, Evidence),
})
export type Page = typeof Page.Type

/** What the messages read besides the state: the owner's renames of projects, by project id. */
export interface Reader {
  readonly names: ReadonlyMap<string, string>
}

// ── Words ──

/** A text's first sentence and the rest: the subject and the body of a message. */
export interface Words {
  readonly subject: string
  readonly body: string
}

export const splitSubject = (text: string): Words => {
  const one = text.replace(/\s+/g, " ").trim()
  const at = one.search(/[.!?](?=\s+[^a-z\s])/)
  if (at < 0) return { subject: clip(one, 160), body: "" }
  return { subject: clip(one.slice(0, at + 1), 160), body: one.slice(at + 1).trim() }
}

const baseOf = (path: string): string => Option.getOrElse(Arr.last(path.replace(/\/+$/, "").split("/")), () => path)

// ── Projects ──

/** A run's name: its record's, else its run dir's last segment, else its root. */
export const runNameOf = (run: Run): string => Option.getOrElse(Option.orElse(run.name, () => Option.map(run.dir, baseOf)), () => run.root)

interface Group {
  readonly id: string
  readonly runs: ReadonlyArray<Run>
}

/** The projects of the state: its runs grouped by name, each group's newest record first. */
const groupsOf = (state: State): ReadonlyArray<Group> => {
  const byName = Arr.groupBy([...state.runs.values()], runNameOf)
  return Object.entries(byName).map(([id, runs]) => ({ id, runs: Arr.sort(runs, Order.flip(Order.mapInput(Order.Number, (run: Run) => run.t))) }))
}

/** A host as the owner names it: the Mac by that word, any other by its own name. */
const hostWords = (host: string): string => {
  if (host === "mac" || host.endsWith(".local") || host.startsWith("Mac")) return "Mac"
  return host
}

// ── Units ──

/** A unit of a project, from every fact that names it. */
interface UnitFacts {
  readonly name: string
  readonly lane: Option.Option<Lane>
  readonly starts: ReadonlyArray<Start>
  readonly handBacks: ReadonlyArray<HandBack>
  readonly verdicts: ReadonlyArray<{ readonly verdict: Verdict; readonly round: number; readonly said: string }>
}

const isStepOfUnit = (role: string): boolean => role !== "verifier"

/** The rows a verdict holds: its findings' units, or, with none, itself when its batch is a unit's name. */
const rowsOf = (verdict: Verdict): ReadonlyArray<{ readonly unit: string; readonly round: number; readonly verdict: string }> =>
  Arr.match(verdict.units, {
    onEmpty: () => Arr.filter([{ unit: verdict.batch, round: verdict.round, verdict: verdict.verdict }], (row) => !row.unit.startsWith("batch-")),
    onNonEmpty: (rows) => rows,
  })

/** The units of a project's roots, by name, from their lanes, steps, verdicts and items. */
const unitsOf = (state: State, roots: ReadonlySet<string>): ReadonlyMap<string, UnitFacts> => {
  const units = new Map<string, { name: string; lane: Option.Option<Lane>; starts: Array<Start>; handBacks: Array<HandBack>; verdicts: Array<UnitFacts["verdicts"][number]> }>()
  const unit = (name: string) => {
    const found = Option.fromUndefinedOr(units.get(name))
    if (Option.isSome(found)) return found.value
    const made = { name, lane: Option.none<Lane>(), starts: [], handBacks: [], verdicts: [] }
    units.set(name, made)
    return made
  }
  for (const lane of state.lanes.values()) if (roots.has(lane.root)) unit(lane.unit).lane = Option.some(lane)
  for (const start of state.starts.values()) if (roots.has(start.root) && isStepOfUnit(start.role)) unit(start.unit).starts.push(start)
  for (const back of state.handBacks.values()) if (roots.has(back.root) && isStepOfUnit(back.role)) unit(back.unit).handBacks.push(back)
  for (const verdict of state.verdicts.values())
    if (roots.has(verdict.root)) for (const row of rowsOf(verdict)) unit(row.unit).verdicts.push({ verdict, round: row.round, said: row.verdict })
  for (const item of liveItems(state, roots)) for (const name of Option.toArray(item.unit)) unit(name)
  return units
}

/** A unit's rounds: each round its implementor handed back or a verdict judged, in order. */
const roundsOf = (facts: UnitFacts): ReadonlyArray<Round> => {
  const backs = facts.handBacks.filter((back) => back.role === "implementor")
  const numbers = Arr.sort(Arr.dedupe([...backs.map((back) => back.round), ...facts.verdicts.map((each) => each.round)]), Order.Number)
  return numbers.map((n) => {
    const back = Arr.findLast(backs, (each) => each.round === n)
    const judged = Arr.last(Arr.sort(facts.verdicts.filter((each) => each.round === n), Order.mapInput(Order.Number, (each: UnitFacts["verdicts"][number]) => each.verdict.t)))
    return {
      n,
      handed: Option.map(back, (each) => each.t),
      verdict: Option.map(judged, (each) => each.said),
      batch: Option.filter(Option.map(judged, (each) => each.verdict.batch), (batch) => batch !== facts.name),
      verdictAt: Option.map(judged, (each) => each.verdict.t),
      request: Option.flatMap(back, (each) => each.file),
      findings: Option.flatMap(judged, (each) => each.verdict.file),
    }
  })
}

/** A unit's agents: each step started, ended by its hand-back. */
const agentsOf = (facts: UnitFacts): ReadonlyArray<Agent> =>
  Arr.sort(facts.starts, Order.mapInput(Order.Number, (start: Start) => start.t)).map((start) => ({
    role: start.role,
    start: start.t,
    end: Option.map(
      Arr.findFirst(facts.handBacks, (back) => back.role === start.role && back.round === start.round && back.t >= start.t),
      (back) => back.t,
    ),
  }))

const unitViewOf = (facts: UnitFacts): UnitView => ({
  name: facts.name,
  purpose: Option.flatMap(facts.lane, (lane) => lane.purpose),
  rounds: roundsOf(facts),
  agents: agentsOf(facts),
})

/** When a unit last changed. */
const unitTime = (facts: UnitFacts): number =>
  Math.max(0, ...Option.toArray(Option.map(facts.lane, (lane) => lane.t)), ...facts.starts.map((each) => each.t), ...facts.handBacks.map((each) => each.t), ...facts.verdicts.map((each) => each.verdict.t))

// ── Messages ──

/** The items of `roots` that stand (not removed). */
const liveItems = (state: State, roots: ReadonlySet<string>): ReadonlyArray<Item> =>
  [...state.items.values()].flatMap((each: Item | ItemGone) => Arr.filter(Option.toArray(itemOf(each)), (item) => roots.has(item.root)))

const itemOf = (each: Item | ItemGone): Option.Option<Item> => Option.liftPredicate(each, (kept): kept is Item => kept._tag === "Item")

/** A message before the read marks: what the view knows of it from the state. */
type Draft = Message

const itemKind = (item: Item): Kind => {
  if (item.state === "needs-you") return "needs"
  if (item.state === "done") return "shipped"
  return "stuck"
}

const itemLevel = (item: Item): MessageLevel => {
  if (Option.contains(item.level, "red")) return "red"
  if (item.state === "needs-you") return "need"
  if (item.state === "done" || Option.contains(item.level, "green")) return "ok"
  return "none"
}

const itemMessage = (item: Item, units: ReadonlyArray<UnitView>): Draft => ({
  id: `item:${item.root}:${item.id}`,
  src: `item:${item.id}`,
  kind: itemKind(item),
  level: itemLevel(item),
  ...splitSubject(item.text),
  t: item.t,
  units,
  ask: Option.none(),
  decided: Option.none(),
  open: item.state === "needs-you",
  root: item.root,
})

const askedMessage = (asked: Asked): Draft => ({
  id: `question:${asked.session}:${asked.id}`,
  src: `question:${asked.id}`,
  kind: "needs",
  level: "need",
  ...splitSubject(asked.question),
  t: asked.t,
  units: [],
  ask: Option.some({ ref: asked.id, options: asked.options, assume: Option.some(asked.assume) }),
  decided: Option.none(),
  open: true,
  root: asked.root,
})

/** The answers of one submit (one root, one time) as one message. */
const decidedMessage = (answers: ReadonlyArray<Answered>, asked: State["asked"]): ReadonlyArray<Draft> =>
  Option.toArray(
    Option.map(Arr.head(answers), (first) => {
      const decided = answers.map((answer) => {
        const question = Option.orElse(answer.question, () => Option.map(Option.fromUndefinedOr(asked.get(keyOf(answer.session, answer.id))), (each) => each.question))
        const assume = Option.orElse(answer.assume, () => Option.map(Option.fromUndefinedOr(asked.get(keyOf(answer.session, answer.id))), (each) => each.assume))
        return { q: Option.getOrElse(question, () => answer.id), assumed: Option.getOrElse(assume, () => ""), said: answer.answer, matches: answer.matches }
      })
      const differ = decided.filter((each) => !each.matches).length
      const draft: Draft = {
        id: `decided:${first.root}:${first.t}`,
        src: `question:${answers.map((each) => each.id).join(",")}`,
        kind: "decided",
        level: "none",
        subject: decidedSubject(decided),
        body: Arr.match(Arr.filter([differ], (count) => count > 0), {
          onEmpty: () => "Each answer is what the run assumed.",
          onNonEmpty: () => `${differ} of them differ from what the run assumed.`,
        }),
        t: first.t,
        units: [],
        ask: Option.none(),
        decided: Option.some(decided),
        open: false,
        root: first.root,
      }
      return draft
    }),
  )

const decidedSubject = (decided: ReadonlyArray<Decision>): string => {
  return Option.match(
    Option.filter(Arr.head(decided), () => decided.length === 1),
    { onNone: () => `You answered ${decided.length} questions`, onSome: (only) => `You answered: ${splitSubject(only.q).subject}` },
  )
}

/** The verdict a round-trip reads as done. */
const isAccepted = (verdict: string): boolean => verdict === "accepted"

/** A batch's verdict as a message, holding the units it claimed. */
const verdictMessage = (verdict: Verdict, units: ReadonlyArray<UnitView>): Draft => {
  const words = Option.getOrElse(Option.map(verdict.digest, splitSubject), () => ({ subject: `${verdict.batch} ${verdict.verdict}`, body: "" }))
  return {
    id: `verdict:${verdict.root}:${verdict.batch}:${verdict.round}`,
    src: `verdict:${verdict.batch}`,
    kind: kindOfVerdict(verdict.verdict),
    level: levelOfVerdict(verdict.verdict),
    ...words,
    t: verdict.t,
    units,
    ask: Option.none(),
    decided: Option.none(),
    open: false,
    root: verdict.root,
  }
}

const kindOfVerdict = (verdict: string): Kind => {
  if (isAccepted(verdict)) return "shipped"
  return "stuck"
}

const levelOfVerdict = (verdict: string): MessageLevel => {
  if (isAccepted(verdict)) return "ok"
  return "none"
}

/** What happened to a unit last, in plain words, when its run wrote no `Digest:` line. */
const unitWords = (facts: UnitFacts, view: UnitView): string => {
  const what = Option.getOrElse(view.purpose, () => facts.name)
  const last = Arr.last(view.rounds)
  const verdict = Option.flatMap(last, (round) => round.verdict)
  if (Option.isSome(verdict)) return `${what}: round ${Option.getOrElse(Option.map(last, (round) => round.n), () => 1)} ${verdict.value}`
  if (Option.isSome(Option.flatMap(last, (round) => round.handed))) return `${what}: handed back`
  return `${what}: in work`
}

/** A unit no item or verdict names, as its own message: its newest `Digest:` line, else its purpose and state. */
const unitMessage = (root: string, facts: UnitFacts, view: UnitView): Draft => {
  const digest = Arr.last(Arr.sort(facts.handBacks.flatMap((back) => Option.toArray(Option.map(back.digest, (said) => ({ said, t: back.t })))), Order.mapInput(Order.Number, (each: { readonly t: number }) => each.t)))
  const last = Option.flatMap(Arr.last(view.rounds), (round) => round.verdict)
  return {
    id: `unit:${root}:${facts.name}`,
    src: `unit:${facts.name}`,
    kind: Option.match(last, { onNone: () => "stuck" as const, onSome: kindOfVerdict }),
    level: Option.match(last, { onNone: () => "none" as const, onSome: levelOfVerdict }),
    ...Option.getOrElse(Option.map(digest, (each) => splitSubject(each.said)), () => ({ subject: unitWords(facts, view), body: "" })),
    t: unitTime(facts),
    units: [view],
    ask: Option.none(),
    decided: Option.none(),
    open: false,
    root,
  }
}

// ── A project's messages ──

/** Which message each unit of a project sits under: the newest item naming it, else the newest verdict holding it, else its own. */
type Claim = { readonly item: Item } | { readonly verdict: Verdict } | { readonly own: string }

const byTime = <A extends { readonly t: number }>(values: ReadonlyArray<A>): ReadonlyArray<A> => Arr.sort(values, Order.mapInput(Order.Number, (each: A) => each.t))

const claimOf = (name: string, facts: UnitFacts, items: ReadonlyArray<Item>, root: string): Claim => {
  const item = Arr.last(byTime(items.filter((each) => Option.contains(each.unit, name))))
  if (Option.isSome(item)) return { item: item.value }
  const verdict = Arr.last(byTime(facts.verdicts.map((each) => each.verdict).filter((each) => each.units.length > 0)))
  if (Option.isSome(verdict)) return { verdict: verdict.value }
  return { own: Option.getOrElse(Option.map(Arr.head(facts.starts), (start) => start.root), () => Option.getOrElse(Option.map(facts.lane, (lane) => lane.root), () => root)) }
}

/** The messages of one project, before the read marks, and the message each unit sits under. */
export interface Drafted {
  readonly messages: ReadonlyArray<Draft>
  /** The message each unit (by name) and item (by root and id) sits under. */
  readonly unitMessage: ReadonlyMap<string, string>
}

const draftsOf = (state: State, group: Group): Drafted => {
  const roots = new Set(group.runs.map((run) => run.root))
  const main = Option.getOrElse(Option.map(Arr.head(group.runs), (run) => run.root), () => group.id)
  const items = liveItems(state, roots)
  const units = unitsOf(state, roots)
  const views = new Map([...units].map(([name, facts]) => [name, unitViewOf(facts)]))
  const claims = [...units].map(([name, facts]) => ({ name, facts, claim: claimOf(name, facts, items, main) }))
  const underItem = (item: Item) => claims.flatMap((each) => Arr.filter(Option.toArray(Option.fromUndefinedOr(views.get(each.name))), () => "item" in each.claim && each.claim.item === item))
  const verdicts = Arr.dedupe(claims.flatMap((each) => claimedVerdict(each.claim)))
  const underVerdict = (verdict: Verdict) => claims.flatMap((each) => Arr.filter(Option.toArray(Option.fromUndefinedOr(views.get(each.name))), () => "verdict" in each.claim && each.claim.verdict === verdict))
  const own = claims.flatMap((each) => ownMessage(each.claim, each.facts, Option.fromUndefinedOr(views.get(each.name))))
  const messages: Array<Draft> = [
    ...items.map((item) => itemMessage(item, underItem(item))),
    ...verdicts.map((verdict) => verdictMessage(verdict, underVerdict(verdict))),
    ...own,
    ...questionDrafts(state, roots),
    ...checkDrafts(state, roots),
    ...installDrafts(state, group),
  ]
  return { messages, unitMessage: new Map(messages.flatMap((message) => message.units.map((unit) => [unit.name, message.id] as const))) }
}

/** The verdict a claim names, when it names one. */
const claimedVerdict = (claim: Claim): ReadonlyArray<Verdict> => {
  if ("verdict" in claim) return [claim.verdict]
  return []
}

/** A unit's own message, when its claim is its own. */
const ownMessage = (claim: Claim, facts: UnitFacts, view: Option.Option<UnitView>): ReadonlyArray<Draft> => {
  if (!("own" in claim)) return []
  return Option.toArray(Option.map(view, (each) => unitMessage(claim.own, facts, each)))
}

/** The open questions of `roots`, and their answered ones by submit. */
const questionDrafts = (state: State, roots: ReadonlySet<string>): ReadonlyArray<Draft> => {
  const open = [...state.asked.values()].filter(
    (asked) => roots.has(asked.root) && !state.answered.has(keyOf(asked.session, asked.id)) && !state.closed.has(keyOf(asked.session, asked.id)),
  )
  const answered = Arr.groupBy(
    [...state.answered.values()].filter((answer) => roots.has(answer.root)),
    (answer) => keyOf(answer.root, answer.t),
  )
  return [...open.map(askedMessage), ...Object.values(answered).flatMap((answers) => decidedMessage(answers, state.asked))]
}

/** A failed land check of `roots` as a red message; a passed one is no message. */
const checkDrafts = (state: State, roots: ReadonlySet<string>): ReadonlyArray<Draft> =>
  state.checks
    .values()
    .filter((check) => roots.has(check.root) && !check.ok)
    .map((check): Draft => ({
      id: `check:${check.root}:${check.t}`,
      src: "check",
      kind: "stuck",
      level: "red",
      ...splitSubject(check.text),
      t: check.t,
      units: [],
      ask: Option.none(),
      decided: Option.none(),
      open: false,
      root: check.root,
    }))
    .toArray()

/** An install on the project's host of its repository, as a message. */
const installDrafts = (state: State, group: Group): ReadonlyArray<Draft> =>
  Option.match(Arr.head(group.runs), {
    onNone: () => [],
    onSome: (run) =>
      state.installs
        .values()
        .filter((install) => install.host === run.host && Option.contains(install.repo, run.repo))
        .map((install): Draft => ({
          id: `install:${install.host}:${install.t}`,
          src: "install",
          kind: installKind(install.outcome),
          level: "none",
          subject: `Install on ${hostWords(install.host)}: ${install.outcome}${Option.getOrElse(Option.map(install.build, (build) => ` (${build})`), () => "")}`,
          body: Option.getOrElse(install.said, () => ""),
          t: install.t,
          units: [],
          ask: Option.none(),
          decided: Option.none(),
          open: false,
          root: run.root,
        }))
        .toArray(),
  })

const installKind = (outcome: string): Kind => {
  if (outcome === "proven") return "shipped"
  return "stuck"
}

// ── The project's line and colour ──

/** Whether a root's newest land check failed and no land came after it. */
const checkRed = (state: State, roots: ReadonlySet<string>): Option.Option<string> => {
  const checks = byTime([...state.checks.values()].filter((check) => roots.has(check.root)))
  const lands = [...state.lands.values()].filter((land) => roots.has(land.root))
  return Option.map(
    Option.filter(Arr.last(checks), (check) => !check.ok && !lands.some((land) => land.t > check.t)),
    (check) => splitSubject(check.text).subject,
  )
}

/** The project's colour: red when an open item is red or its last check failed; need when something waits on him. */
const levelOf = (messages: ReadonlyArray<Draft>, red: Option.Option<string>): ProjectLevel => {
  if (Option.isSome(red) || messages.some((message) => message.level === "red" && message.kind !== "shipped" && message.src !== "check")) return "red"
  if (messages.some((message) => message.open)) return "need"
  return "none"
}

/** The project's one line: its root's newest item with a level, else its newest `Digest:` line. */
const headlineOf = (state: State, roots: ReadonlySet<string>, red: Option.Option<string>): string => {
  const leveled = Arr.last(byTime(liveItems(state, roots).filter((item) => Option.isSome(item.level))))
  const digests = byTime([
    ...[...state.handBacks.values()].filter((back) => roots.has(back.root)).flatMap((back) => Option.toArray(Option.map(back.digest, (said) => ({ said, t: back.t })))),
    ...[...state.verdicts.values()].filter((verdict) => roots.has(verdict.root)).flatMap((verdict) => Option.toArray(Option.map(verdict.digest, (said) => ({ said, t: verdict.t })))),
  ])
  return Option.getOrElse(
    Option.firstSomeOf([
      Option.map(leveled, (item) => splitSubject(item.text).subject),
      red,
      Option.map(Arr.last(digests), (each) => splitSubject(each.said).subject),
    ]),
    () => "",
  )
}

/** Newest first. */
const newestFirst = Order.mapInput(Order.flip(Order.Number), (message: Message) => message.t)

// ── The page ──

/** A project with its messages, and the message each unit sits under. */
export interface ProjectView {
  readonly project: Project
  readonly unitMessage: ReadonlyMap<string, string>
}

/** The projects' default names: the repository, with the run's name added when two projects share it. */
const defaultNames = (groups: ReadonlyArray<Group>): ReadonlyMap<string, string> => {
  const repoOf = (group: Group) => Option.getOrElse(Option.map(Arr.head(group.runs), (run) => run.repo), () => group.id)
  const counts = Arr.groupBy(groups, repoOf)
  return new Map(
    groups.map((group) => [group.id, Arr.match(Arr.filter([repoOf(group)], (repo) => (counts[repo]?.length ?? 0) > 1), { onEmpty: () => repoOf(group), onNonEmpty: () => `${repoOf(group)} · ${group.id}` })]),
  )
}

/** Every project of the state, with its messages, as the owner reads it at `reader.now`. */
export const projectsOf = (state: State, reader: Reader): ReadonlyArray<ProjectView> => {
  const groups = groupsOf(state)
  const names = defaultNames(groups)
  return groups.map((group) => {
    const roots = new Set(group.runs.map((run) => run.root))
    const drafted = draftsOf(state, group)
    const red = checkRed(state, roots)
    const messages = Arr.sort(drafted.messages, newestFirst)
    const run = Arr.head(group.runs)
    const host = Option.getOrElse(Option.map(run, (each) => each.host), () => "")
    const repo = Option.getOrElse(Option.map(run, (each) => each.repo), () => group.id)
    return {
      project: {
        id: group.id,
        name: Option.getOrElse(Option.orElse(Option.fromUndefinedOr(reader.names.get(group.id)), () => Option.fromUndefinedOr(names.get(group.id))), () => group.id),
        where: `${repo} · ${hostWords(host)}`,
        host,
        repo,
        roots: [...roots],
        level: levelOf(drafted.messages, red),
        headline: headlineOf(state, roots, red),
        messages,
      },
      unitMessage: drafted.unitMessage,
    }
  })
}

/** The page: every project, newest change first. */
export const pageOf = (state: State, reader: Reader): Page => {
  const projects = projectsOf(state, reader).map((each) => each.project)
  const newest = (project: Project) => Math.max(0, ...project.messages.map((message) => message.t))
  return {
    projects: Arr.sort(projects, Order.mapInput(Order.flip(Order.Number), newest)),
    evidence: {},
  }
}

/** The page as JSON, its absent fields left out. */
export const encodePage = Schema.encodeSync(Schema.fromJsonString(Page))
