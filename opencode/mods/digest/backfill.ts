// The digest's events from what runs wrote before the digest had a log: each root's inbox (its subagents' hand-backs,
// the land notices, the owner's answers), its children (the steps it started), its queue file, its unit folders (the
// findings and their verdict tables) and each host's install log. It gives the very events the writers write now, so
// the fold and the page read old and new days alike. Pure: `filestore/stores.ts` reads the files, this parses them.
//
// What an old store does not say stays unsaid: an item has no `level` (nothing is red from its words), and an item
// names a unit only when its id is that unit's name.
import { Array as Arr, Option, Schema } from "effect"
import { DigestEvent, type UnitVerdict, VERSION } from "./event.ts"
import { isStep } from "./fold.ts"

/** A file of a unit folder: its name, text and when it was last written (epoch ms). */
export interface UnitFile {
  readonly name: string
  readonly text: string
  readonly mtime: number
}

/** A run dir's folder: a unit's, or a verify's. */
export interface UnitDir {
  readonly name: string
  readonly files: ReadonlyArray<UnitFile>
}

/** One run's stores, as read. */
export interface RunStores {
  readonly id: string
  readonly host: string
  readonly session: string
  readonly repo: Option.Option<string>
  /** The root's queue file's text. */
  readonly queue: Option.Option<string>
  /** The root's inbox: one JSON message per line. */
  readonly inbox: string
  /** The root's child sessions: one JSON session per line. */
  readonly children: string
  readonly units: ReadonlyArray<UnitDir>
}

/** Every store of a host or a frozen day. */
export interface Stores {
  readonly runs: ReadonlyArray<RunStores>
  /** Each host's install log: `<ISO> <host> <step>: …` per line. */
  readonly updates: ReadonlyArray<{ readonly host: string; readonly text: string }>
}

// ── The stores' shapes, as much as the backfill reads ──

const Answer = Schema.Struct({
  id: Schema.String,
  question: Schema.optional(Schema.String),
  assume: Schema.optional(Schema.String),
  answer: Schema.String,
  matches: Schema.optional(Schema.Boolean),
})

const InboxMessage = Schema.Struct({
  type: Schema.String,
  t: Schema.Finite,
  text: Schema.optional(Schema.String),
  metadata: Schema.optional(
    Schema.Struct({
      source: Schema.optional(Schema.String),
      rift: Schema.optional(Schema.String),
      childID: Schema.optional(Schema.String),
      agent: Schema.optional(Schema.String),
      answers: Schema.optional(Schema.Array(Answer)),
    }),
  ),
})
type InboxMessage = typeof InboxMessage.Type

const Child = Schema.Struct({ id: Schema.String, title: Schema.String, agent: Schema.String, c: Schema.Finite, u: Schema.Finite })

const QueueItem = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  state: Schema.String,
  owner: Schema.String,
  who: Schema.optional(Schema.String),
  doneAt: Schema.optional(Schema.Finite),
})
const QueueFile = Schema.Struct({ items: Schema.Array(QueueItem), touched: Schema.optional(Schema.Record(Schema.String, Schema.Finite)) })

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(InboxMessage))
const decodeChild = Schema.decodeUnknownOption(Schema.fromJsonString(Child))
const decodeQueue = Schema.decodeUnknownOption(Schema.fromJsonString(QueueFile))

const linesOf = <A>(text: string, decode: (line: string) => Option.Option<A>): ReadonlyArray<A> =>
  text.split("\n").flatMap((line) => Option.toArray(decode(line)))

// ── Steps, from the children and the hand-backs ──

/** A step's call description or hand-back line: `<role> <unit> r<N>`, as the skill writes it. */
const STEP = /^(planner|implementor|verifier) ([a-z0-9][a-z0-9._-]*) r(\d+)\b/

/** The hand-back line: `<role> <unit> r<N>: <verdict> <path>`. */
const HAND_BACK = /^[`*\s]*(planner|implementor|verifier) ([a-z0-9][a-z0-9._-]*) r(\d+):\s*(ready|blocked|accepted|changes|stuck)\b[`*]*\s*([^\s`*]*)/i

const startsOf = (run: RunStores): ReadonlyArray<DigestEvent> =>
  linesOf(run.children, decodeChild).flatMap((child) =>
    Option.toArray(
      Option.map(Option.fromNullishOr(STEP.exec(child.title)), (step) =>
        DigestEvent.cases.Start.make({ v: VERSION, t: child.c, root: run.session, session: child.id, role: step[1] ?? "", unit: step[2] ?? "", round: Number(step[3]) }),
      ),
    ),
  )

/** A findings file's verdict table, one row per unit: `| <unit> (…) | r<N> or <N> | <verdict> … |`. */
export const rowsOf = (findings: string): ReadonlyArray<UnitVerdict> =>
  findings.split("\n").flatMap((line) =>
    Option.toArray(
      Option.map(Option.fromNullishOr(/^\|\s*`?([a-z0-9][a-z0-9._-]*)`?[^|]*\|\s*r?(\d+)\s*\|\s*[*_`]*(accepted|changes|stuck)\b/i.exec(line)), (row) => ({
        unit: row[1] ?? "",
        round: Number(row[2]),
        verdict: (row[3] ?? "").toLowerCase(),
      })),
    ),
  )

/** The file of a unit folder a path names: the folder by its last segment, the file by its name. */
const fileAt = (run: RunStores, path: string): Option.Option<UnitFile> => {
  const parts = path.split("/")
  const [name, dir] = [parts.at(-1), parts.at(-2)]
  return Option.flatMap(Arr.findFirst(run.units, (unit) => unit.name === dir), (unit) => Arr.findFirst(unit.files, (file) => file.name === name))
}

/** A subagent's ending in the root's inbox, as the step's hand-back or the verifier's verdict. */
const handBackOf = (run: RunStores, message: InboxMessage): ReadonlyArray<DigestEvent> => {
  const said = (message.text ?? "").split("\n").slice(1).join("\n")
  const first = Option.getOrElse(Arr.findFirst(said.split("\n"), (line) => line.trim() !== ""), () => "")
  return Option.toArray(
    Option.map(Option.fromNullishOr(HAND_BACK.exec(first)), (back) => {
      const [role, unit, round, verdict] = [back[1] ?? "", back[2] ?? "", Number(back[3]), (back[4] ?? "").toLowerCase()]
      const file = Option.filter(Option.fromNullishOr(back[5]), (path) => path !== "")
      const common = { v: VERSION, t: message.t, root: run.session, session: message.metadata?.childID ?? "", round, verdict, file, digest: Option.none<string>() }
      if (role !== "verifier") return DigestEvent.cases.HandBack.make({ ...common, role, unit })
      const findings = Option.flatMap(file, (path) => fileAt(run, path))
      return DigestEvent.cases.Verdict.make({ ...common, batch: unit, units: Option.getOrElse(Option.map(findings, (each) => rowsOf(each.text)), () => []) })
    }),
  )
}

/** A land notice: the accept check's outcome, or a post-land step that failed; any other notice is none. */
const checkOf = (run: RunStores, message: InboxMessage): ReadonlyArray<DigestEvent> => {
  const line = Option.getOrElse(Arr.head((message.text ?? "").split("\n")), () => "")
  const accept = /the accept check for .* (passed|FAILED)\b/.exec(line)
  const ok = Option.orElse(
    Option.map(Option.fromNullishOr(accept), (found) => found[1] === "passed"),
    () => Option.map(Option.fromNullishOr(/the post-land step .* FAILED\b/.exec(line)), () => false),
  )
  return Option.toArray(
    Option.map(ok, (passed) => DigestEvent.cases.Check.make({ v: VERSION, t: message.t, root: run.session, ok: passed, text: line.replace(/^(?:rift|lane) land: /, "") })),
  )
}

/** The owner's answers in the root's inbox. */
const answersOf = (run: RunStores, message: InboxMessage): ReadonlyArray<DigestEvent> =>
  (message.metadata?.answers ?? []).map((answer) =>
    DigestEvent.cases.Answered.make({
      via: Option.none(),
      v: VERSION,
      t: message.t,
      root: run.session,
      session: run.session,
      id: answer.id,
      answer: answer.answer,
      matches: answer.matches ?? true,
      question: Option.fromNullishOr(answer.question),
      assume: Option.fromNullishOr(answer.assume),
    }),
  )

const isLandNotice = (message: InboxMessage): boolean => message.metadata?.rift === "land" || /^(?:rift|lane) land:/.test(message.text ?? "")

const inboxOf = (run: RunStores): ReadonlyArray<DigestEvent> =>
  linesOf(run.inbox, decodeMessage).flatMap((message) => {
    if (message.metadata?.source === "subagent") return handBackOf(run, message)
    if (isLandNotice(message)) return checkOf(run, message)
    return answersOf(run, message)
  })

// ── Verdicts no hand-back carried: the findings files themselves ──

const VERDICT = /\b(accepted|changes|stuck)\b/i

const verdictOfText = (text: string): Option.Option<string> =>
  Option.map(Option.fromNullishOr(VERDICT.exec(Option.getOrElse(Arr.findFirst(text.split("\n"), (line) => line.trim() !== ""), () => ""))), (found) => (found[1] ?? "").toLowerCase())

/** The findings files of the run's folders: a batch's (`batch-*-findings.md`, its table) and a unit's (`round-N-findings.md`). */
const findingsOf = (run: RunStores, dirOf: (unit: UnitDir, file: UnitFile) => string): ReadonlyArray<DigestEvent> =>
  run.units.flatMap((unit) =>
    unit.files.flatMap((file) => {
      const round = /^round-(\d+)-findings\.md$/.exec(file.name)
      const batch = /^(batch-.+)-findings\.md$/.exec(file.name)
      const named = Option.orElse(
        Option.map(Option.fromNullishOr(round), (found) => ({ batch: unit.name, round: Number(found[1]), units: [] })),
        () => Option.map(Option.fromNullishOr(batch), (found) => ({ batch: found[1] ?? "", round: 1, units: rowsOf(file.text) })),
      )
      return Option.toArray(
        Option.flatMap(named, (each) =>
          Option.map(verdictOfText(file.text), (verdict) =>
            DigestEvent.cases.Verdict.make({ v: VERSION, t: file.mtime, root: run.session, session: "", ...each, verdict, file: Option.some(dirOf(unit, file)), digest: Option.none() }),
          ),
        ),
      )
    }),
  )

// ── The queue ──

/** An item the owner must act on, as old queues wrote it: another's, and that other is him. */
const isYours = (item: typeof QueueItem.Type): boolean => item.owner === "other" && /^you\b/i.test(item.who ?? "")

const itemsOf = (run: RunStores, units: ReadonlySet<string>): ReadonlyArray<DigestEvent> =>
  Option.toArray(Option.flatMap(run.queue, decodeQueue)).flatMap((queue) =>
    queue.items.flatMap((item) => {
      const t = Math.max(queue.touched?.[item.id] ?? 0, item.doneAt ?? 0)
      return Arr.filter(
        [
          DigestEvent.cases.Item.make({
            answer: Option.none(),
            choices: Option.none(),
            v: VERSION,
            t,
            root: run.session,
            id: item.id,
            text: item.text.replace(/^\(checked [^)]*\)\s*/, ""),
            state: Option.getOrElse(Option.liftPredicate("needs-you", () => isYours(item) && item.state !== "done"), () => item.state),
            owner: item.owner,
            who: Option.fromNullishOr(item.who),
            level: Option.none(),
            unit: Option.liftPredicate(item.id, (id) => units.has(id)),
          }),
        ],
        () => t > 0,
      )
    }),
  )

// ── Installs ──

const installsOf = (host: string, text: string): ReadonlyArray<DigestEvent> =>
  text.split("\n").flatMap((line) => {
    const found = /^(\S+Z) \S+ handoff: (?:the build is (proven) and recorded as the good build|(rolled-back|gave-up); (.*))$/.exec(line)
    return Option.toArray(
      Option.map(Option.fromNullishOr(found), (parts) =>
        DigestEvent.cases.Install.make({
          v: VERSION,
          t: Date.parse(parts[1] ?? ""),
          host,
          outcome: parts[2] ?? parts[3] ?? "",
          build: Option.none(),
          said: Option.fromNullishOr(parts[4]),
          repo: Option.some("dotfiles"),
        }),
      ),
    )
  })

// ── All of it ──

const runOf = (run: RunStores, events: ReadonlyArray<DigestEvent>): DigestEvent =>
  DigestEvent.cases.Run.make({
    v: VERSION,
    t: Math.min(...events.flatMap((event) => Arr.filter([event.t], (t) => t > 0)), Number.MAX_SAFE_INTEGER),
    root: run.session,
    host: run.host,
    repo: Option.getOrElse(run.repo, () => run.id),
    dir: Option.none(),
    name: Option.some(run.id),
  })

/** The events of one run's stores, its run record first. */
export const runEvents = (run: RunStores, dirOf: (unit: UnitDir, file: UnitFile) => string = (unit, file) => `${unit.name}/${file.name}`): ReadonlyArray<DigestEvent> => {
  const steps = [...startsOf(run), ...inboxOf(run)]
  const named = new Set([...run.units.map((unit) => unit.name), ...steps.flatMap((event) => Option.toArray(Option.map(Option.liftPredicate(event, isStep), (step) => step.unit)))])
  const rest = [...steps, ...findingsOf(run, dirOf), ...itemsOf(run, named)]
  return [runOf(run, rest), ...rest]
}

/** Every event of the stores: each run's, then each host's installs. */
export const backfill = (stores: Stores, dirOf?: (unit: UnitDir, file: UnitFile) => string): ReadonlyArray<DigestEvent> => [
  ...stores.runs.flatMap((run) => runEvents(run, dirOf)),
  ...stores.updates.flatMap((update) => installsOf(update.host, update.text)),
]
