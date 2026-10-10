// The append-only log every run keeps, in one SQLite file shared by every
// baton process on the machine. `seq` orders all events; a write reads, decides
// and appends inside one `BEGIN IMMEDIATE` transaction, so two processes never
// decide from the same stale log.
import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { Event } from "../domain/event.js"
import type { Entry } from "../domain/event.js"

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `the baton log failed: ${String(this.cause)}`
  }
}

const EventJson = Schema.fromJsonString(Event)
const decodeEvent = Schema.decodeUnknownEffect(EventJson)
const encodeEvent = Schema.encodeEffect(EventJson)

const Row = Schema.Struct({ seq: Schema.Int, at: Schema.Int, payload: Schema.String })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))
const RunRow = Schema.Struct({ run: Schema.String })
const decodeRunRows = Schema.decodeUnknownEffect(Schema.Array(RunRow))

export interface JournalService {
  /** Every run's name, most recently written first. */
  readonly runs: Effect.Effect<ReadonlyArray<string>, JournalError>
  readonly read: (run: string) => Effect.Effect<ReadonlyArray<Entry>, JournalError>
  /**
   * Reads the run's log, asks `decide` what to record, and appends it, all
   * in one transaction. Returns what was appended.
   */
  readonly write: <E>(
    run: string,
    decide: (entries: ReadonlyArray<Entry>, now: number) => Result.Result<ReadonlyArray<Event>, E>,
  ) => Effect.Effect<ReadonlyArray<Entry>, E | JournalError>
}

export class Journal extends Context.Service<Journal, JournalService>()(
  "baton/src/services/Journal",
) {
  /** The journal over whichever SqlClient is provided. */
  static layerSql: Layer.Layer<Journal, JournalError, SqlClient.SqlClient> = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const fail = Effect.mapError((cause: unknown) => JournalError.make({ cause }))
      yield* sql`CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run TEXT NOT NULL,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      )`.pipe(fail)
      yield* sql`CREATE INDEX IF NOT EXISTS events_run ON events (run, seq)`.pipe(fail)

      const read = Effect.fn("Journal.read")(function* (run: string) {
        const rows = yield* sql`SELECT seq, at, payload FROM events WHERE run = ${run} ORDER BY seq`
        const decoded = yield* decodeRows(rows)
        return yield* Effect.forEach(decoded, (row) =>
          Effect.map(decodeEvent(row.payload), (event): Entry => ({
            seq: row.seq,
            at: row.at,
            event,
          })),
        )
      }, fail)

      const runs = Effect.gen(function* () {
        const rows = yield* sql`SELECT run FROM events GROUP BY run ORDER BY MAX(seq) DESC`
        const decoded = yield* decodeRunRows(rows)
        return decoded.map((row) => row.run)
      }).pipe(fail, Effect.withSpan("Journal.runs"))

      const append = Effect.fn("Journal.append")(function* (run: string, at: number, event: Event) {
        const payload = yield* encodeEvent(event)
        const rows =
          yield* sql`INSERT INTO events ${sql.insert({ run, at, payload })} RETURNING seq`
        const [row] = yield* decodeRunSeq(rows)
        return Option.match(Option.fromUndefinedOr(row), {
          onNone: () => ({ seq: 0, at, event }),
          onSome: ({ seq }) => ({ seq, at, event }),
        })
      }, fail)

      const write = Effect.fn("Journal.write")(
        function* <E>(
          run: string,
          decide: (
            entries: ReadonlyArray<Entry>,
            now: number,
          ) => Result.Result<ReadonlyArray<Event>, E>,
        ) {
          const entries = yield* read(run)
          const now = yield* Clock.currentTimeMillis
          const events = yield* Result.match(decide(entries, now), {
            onFailure: (error) => Effect.fail(error),
            onSuccess: (decided) => Effect.succeed(decided),
          })
          return yield* Effect.forEach(events, (event) => append(run, now, event))
        },
        sql.withTransaction,
        Effect.catchTag("SqlError", (cause) => Effect.fail(JournalError.make({ cause }))),
      )

      return Journal.of({ runs, read, write })
    }),
  )

  /** The journal at `$BATON_DB`, or `~/.local/state/baton/baton.db`. */
  static layer = Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* Config.String("HOME").pipe(Config.withDefault("."))
      const state = yield* Config.String("XDG_STATE_HOME").pipe(
        Config.withDefault(path.join(home, ".local/state")),
      )
      const filename = yield* Config.String("BATON_DB").pipe(
        Config.withDefault(path.join(state, "baton/baton.db")),
      )
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true })
      return Journal.layerSql.pipe(Layer.provide(SqliteClient.layer({ filename })))
    }),
  )
}

const SeqRow = Schema.Struct({ seq: Schema.Int })
const decodeRunSeq = Schema.decodeUnknownEffect(Schema.Array(SeqRow))
