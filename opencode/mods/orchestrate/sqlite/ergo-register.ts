// Ergo's register (`register.sql`: commitment, event, prerequisite) read from a copy of its SQLite file and mapped
// table to table into the record's `import` command: nothing parsed from prose. A row that does not map is refused by
// its id and column, and the import's counts in equal its counts out, by state. `mapRegister` is pure; `readRegister`
// opens the file read-only.
import { Database } from "bun:sqlite"
import { Array as Arr, Effect, Option, Order, Result, Schema } from "effect"
import { Command, type ImportRow, isoOf, msOf, type PrerequisiteKind, RANKS, REVIEW_MS, SOURCE_KINDS, type State } from "../record.ts"
import { RecordFailed } from "../service.ts"

/** The import's name, its events' actor. */
export const ERGO_REGISTER = "ergo-register"

const Text = Schema.OptionFromNullOr(Schema.String)

export const ErgoCommitment = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  source_kind: Schema.String,
  source_ref: Schema.String,
  plan: Text,
  part: Text,
  rank: Schema.String,
  owner_lane: Text,
  owner_session: Text,
  state: Schema.String,
  trigger_kind: Schema.String,
  trigger_ref: Text,
  head: Text,
  request_path: Text,
  created_at: Schema.String,
  updated_at: Schema.String,
  /** Ergo fills it for landed rows before an import; its own table has none. */
  landed_commit: Schema.optionalKey(Text),
})
export interface ErgoCommitment extends Schema.Schema.Type<typeof ErgoCommitment> {}

export const ErgoEvent = Schema.Struct({ seq: Schema.Int, commitment_id: Schema.String, at: Schema.String, actor: Schema.String, from_state: Text, to_state: Schema.String, note: Schema.String })
export interface ErgoEvent extends Schema.Schema.Type<typeof ErgoEvent> {}

export const ErgoPrerequisite = Schema.Struct({ commitment_id: Schema.String, kind: Schema.String, ref: Schema.String })
export interface ErgoPrerequisite extends Schema.Schema.Type<typeof ErgoPrerequisite> {}

export interface Register {
  readonly commitments: ReadonlyArray<ErgoCommitment>
  readonly events: ReadonlyArray<ErgoEvent>
  readonly prerequisites: ReadonlyArray<ErgoPrerequisite>
}

/** Ergo's states, and the record's each becomes. */
export const STATE_MAP: ReadonlyMap<string, State> = new Map([
  ["open", "open"],
  ["started", "open"],
  ["ready", "open"],
  ["queued", "open"],
  ["landed", "landed"],
  ["closed", "decided"],
  ["dropped-by-decision", "decided"],
])

/** Ergo's waits, and the record's kind each becomes (`none` is no wait). */
const KIND_MAP: ReadonlyMap<string, PrerequisiteKind> = new Map([
  ["commit-on-main", "commit-on-main"],
  ["unit-landed", "commitment-closed"],
  ["date", "date"],
  ["manual", "manual"],
])

/** Ergo's root lane, and the record's. */
const ROOT_LANES: ReadonlyMap<string, string> = new Map([["ORCH", "root"]])

const CLOSING = ["closed", "dropped-by-decision"]


const oneOf = <A extends string>(values: ReadonlyArray<A>, value: string): Option.Option<A> => Arr.findFirst(values, (each) => each === value)

/** Why `row` does not map, by its id and column; none when it does. */
const unmapped = (row: ErgoCommitment, events: ReadonlyArray<ErgoEvent>): Option.Option<string> => {
  const at = (column: string, why: string) => Option.some(`row ${row.id}, column ${column}: ${why}`)
  if (Option.isNone(oneOf(SOURCE_KINDS, row.source_kind))) return at("source_kind", `"${row.source_kind}" is none of ${SOURCE_KINDS.join(", ")}`)
  if (Option.isNone(oneOf(RANKS, row.rank))) return at("rank", `"${row.rank}" is none of A, B, C, D`)
  if (!STATE_MAP.has(row.state)) return at("state", `"${row.state}" is no state of the register`)
  if (row.trigger_kind !== "none" && !KIND_MAP.has(row.trigger_kind)) return at("trigger_kind", `"${row.trigger_kind}" is no wait the record keeps`)
  if (row.state === "landed" && Option.isNone(Option.flatten(Option.fromUndefinedOr(row.landed_commit)))) return at("landed_commit", "a landed row needs the commit on the default branch")
  if (CLOSING.includes(row.state) && Option.isNone(closingNote(row, events))) return at("event.note", "a closed row needs its closing event's note")
  return Option.none()
}

const newestFirst = Order.flip(Order.mapInput(Order.Number, (event: ErgoEvent) => event.seq))

/** The note of the newest event that closed `row` (else its newest event), when it says something. */
const closingNote = (row: ErgoCommitment, events: ReadonlyArray<ErgoEvent>): Option.Option<string> => {
  const sorted = Arr.sort(events, newestFirst)
  const closing = Option.orElse(Arr.findFirst(sorted, (event) => CLOSING.includes(event.to_state)), () => Arr.head(sorted))
  return Option.filter(Option.map(closing, (event) => event.note.trim()), (note) => note !== "")
}

/** When a started row started: its newest event into `started`, else its last change. */
const startedAt = (row: ErgoCommitment, events: ReadonlyArray<ErgoEvent>): Option.Option<string> =>
  Option.liftPredicate(
    Option.getOrElse(Option.map(Arr.findFirst(Arr.sort(events, newestFirst), (event) => event.to_state === "started"), (event) => event.at), () => row.updated_at),
    () => row.state === "started",
  )

const afterOf = (row: ErgoCommitment, prerequisites: ReadonlyArray<ErgoPrerequisite>) => {
  const primary = Option.toArray(Option.zipWith(Option.fromNullishOr(KIND_MAP.get(row.trigger_kind)), row.trigger_ref, (kind, ref) => ({ kind, ref })))
  const more = prerequisites.flatMap((each) => Option.toArray(Option.map(Option.fromNullishOr(KIND_MAP.get(each.kind)), (kind) => ({ kind, ref: each.ref }))))
  return Arr.dedupeWith([...primary, ...more], (a, b) => a.kind === b.kind && a.ref === b.ref)
}

/** One register row as the record imports it; `now` gives an owned open row its review-by time (import time plus 7 days). */
const importOf = (row: ErgoCommitment, events: ReadonlyArray<ErgoEvent>, prerequisites: ReadonlyArray<ErgoPrerequisite>, now: number): ImportRow => {
  const ownerLane = Option.map(row.owner_lane, (lane) => ROOT_LANES.get(lane) ?? lane)
  const state = STATE_MAP.get(row.state) ?? "open"
  return {
    id: row.id,
    row: {
      title: row.title,
      sourceKind: Option.getOrElse(oneOf(SOURCE_KINDS, row.source_kind), () => "plan-part" as const),
      sourceRef: row.source_ref,
      quote: Option.none(),
      plan: row.plan,
      part: row.part,
      rank: oneOf(RANKS, row.rank),
      ownerLane,
      ownerSession: row.owner_session,
      state,
      startedAt: startedAt(row, events),
      reviewBy: Option.as(Option.filter(ownerLane, () => state === "open"), isoOf(now + REVIEW_MS)),
      head: row.head,
      requestPath: row.request_path,
      landedCommit: Option.filter(Option.flatten(Option.fromUndefinedOr(row.landed_commit)), () => state === "landed"),
      decidedWhy: Option.filter(closingNote(row, events), () => state === "decided"),
      createdAt: isoOf(msOf(row.created_at)),
      updatedAt: isoOf(msOf(row.updated_at)),
      after: afterOf(row, prerequisites),
    },
    history: Arr.sort(events, Order.flip(newestFirst)).map((event) => ({ at: event.at, actor: event.actor, fromState: event.from_state, toState: Option.some(event.to_state), note: event.note })),
  }
}

/** The counts by state: Ergo's in, the record's out. */
export interface Counts {
  readonly in: ReadonlyMap<string, number>
  readonly out: ReadonlyMap<State, number>
}

const counted = <K>(keys: ReadonlyArray<K>): ReadonlyMap<K, number> => {
  const counts = new Map<K, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

/** The register's rows as the record's import, its counts in and out; or the first row that does not map, by id and column. */
export const mapRegister = (register: Register, now: number): Result.Result<{ readonly rows: ReadonlyArray<ImportRow>; readonly counts: Counts }, string> => {
  const eventsOf = Arr.groupBy(register.events, (event) => event.commitment_id)
  const prerequisitesOf = Arr.groupBy(register.prerequisites, (each) => each.commitment_id)
  const refused = Option.firstSomeOf(register.commitments.map((row) => unmapped(row, eventsOf[row.id] ?? [])))
  if (Option.isSome(refused)) return Result.fail(refused.value)
  const rows = register.commitments.map((row) => importOf(row, eventsOf[row.id] ?? [], prerequisitesOf[row.id] ?? [], now))
  return Result.succeed({ rows, counts: { in: counted(register.commitments.map((row) => row.state)), out: counted(rows.map((row) => row.row.state)) } })
}

/** The import command of `rows` into `run`. */
export const importCommandOf = (run: string, rows: ReadonlyArray<ImportRow>) => Command.cases.import.make({ run, rows })

/** The counts as a line: `open 3 (open 1, started 2), landed 1, decided 2`. */
export const countsLine = (counts: Counts): string =>
  [...counts.out].map(([state, n]) => `${state} ${n}`).join(", ") + ` from ${[...counts.in].map(([state, n]) => `${state} ${n}`).join(", ")}`

const decodeAll = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, rows: ReadonlyArray<unknown>, table: string) =>
  Effect.mapError(Schema.decodeUnknownEffect(Schema.Array(schema))(rows), (error) => new RecordFailed({ message: `${ERGO_REGISTER}: table ${table}: ${error.message}` }))

/** The register at `path`, read-only: its commitment, event and prerequisite tables. */
export const readRegister = (path: string) =>
  Effect.acquireUseRelease(
    Effect.try({ try: () => new Database(path, { readonly: true }), catch: (cause) => new RecordFailed({ message: `${ERGO_REGISTER}: open ${path}: ${String(cause)}` }) }),
    (db) =>
      Effect.gen(function* () {
        const all = (table: string) =>
          Effect.try({ try: () => db.query(`SELECT * FROM ${table}`).all(), catch: (cause) => new RecordFailed({ message: `${ERGO_REGISTER}: table ${table}: ${String(cause)}` }) })
        const commitments = yield* decodeAll(ErgoCommitment, yield* all("commitment"), "commitment")
        const events = yield* decodeAll(ErgoEvent, yield* all("event"), "event")
        const prerequisites = yield* decodeAll(ErgoPrerequisite, yield* all("prerequisite"), "prerequisite")
        return { commitments, events, prerequisites } satisfies Register
      }),
    (db) => Effect.sync(() => db.close()),
  )

/**
 * The `import` call's read (commitments-tool.ts `Reads.register`): the register at `from` read and mapped into `run`'s
 * import command, with its counts line; or why not, in words. The plugin and the CLI read the same way.
 */
export const registerReads = (from: string, run: string, now: number) =>
  readRegister(from).pipe(
    Effect.mapError((failed) => failed.message),
    Effect.flatMap((register) =>
      Result.match(mapRegister(register, now), {
        onFailure: (why) => Effect.fail(`${ERGO_REGISTER}: ${why}`),
        onSuccess: (mapped) => Effect.succeed({ command: importCommandOf(run, mapped.rows), counts: countsLine(mapped.counts) }),
      }),
    ),
  )

