// Builds the tab bench's database: the shape of real sessions without their content. From a copy of
// an OpenCode database, it copies the named root sessions and every session under them (their
// messages and parts), their projects and the migrations, into a new database, and scrubs every
// string a person or a model wrote: letters become x, digits 0, and whitespace, punctuation and
// length stay, so markdown, code fences, tables and line counts render as they did. Ids, enums
// (types, tool names, states) and timestamps stay. Credentials, accounts, events and every other
// table are left out.
//
// bun perf/tab-fixture.ts --from <copy of opencode.db> --out <new .db> --roots <id,id,...>
//
// Run it on a copy (`/bin/cp` the database and its -wal first): it opens --from read-only.
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { Array as Arr, Console, Data, Effect, FileSystem, Match, Number as Num, Option, Predicate, Record as Rec, Schema } from "effect"
import { Command, Flag } from "effect/cli"

/** The fixture cannot be built: the arguments, the output path or a database step said no. */
class FixtureFailed extends Data.TaggedError("FixtureFailed")<{ readonly message: string }> {}

// Keys whose string values are structure, not content: kept as they are.
const KEEP: ReadonlySet<string> = new Set([
  "type",
  "name",
  "tool",
  "status",
  "state",
  "mime",
  "agent",
  "finish",
  "rawFinish",
  "outcome",
  "reason",
  "kind",
  "mode",
  "source",
  "notice",
  "variant",
  "providerID",
  "format",
  "action",
  "scope",
  "include",
  "delivery",
  "role",
  "start",
  "end",
])
const WORD = /^[\w.:-]{1,64}$/
const DATA_URI = /^data:[^,]*,/

// Only a word-like value is kept, so a file name or a sentence under such a key is scrubbed all the same.
const keeps = (key: Option.Option<string>, value: string): boolean =>
  Option.exists(key, (name) => KEEP.has(name) || name === "id" || name.endsWith("ID")) && WORD.test(value)
const scrubText = (value: string): string => value.replace(/\p{L}/gu, "x").replace(/\p{N}/gu, "0")
// A data URI keeps its header; its payload becomes zero bytes of the same length.
const scrubString = (value: string): string =>
  Option.match(Option.fromNullishOr(DATA_URI.exec(value)), {
    onNone: () => scrubText(value),
    onSome: ([header]) => header + "A".repeat(value.length - header.length),
  })

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Arr.isArray(value)
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value) && !Arr.isArray(value)

const scrub = (value: Schema.Json, key: Option.Option<string>): Schema.Json =>
  Match.value(value).pipe(
    Match.when(Predicate.isString, (text) =>
      Option.match(Option.liftPredicate(text, (kept) => keeps(key, kept)), { onNone: () => scrubString(text), onSome: (kept) => kept }),
    ),
    Match.when(isJsonArray, (items): Schema.Json => Arr.map(items, (item) => scrub(item, key))),
    Match.when(isJsonObject, (record): Schema.Json => Rec.map(record, (item, name) => scrub(item, Option.some(name)))),
    Match.orElse((other): Schema.Json => other),
  )

const JsonText = Schema.fromJsonString(Schema.Json)
const decodeJson = Schema.decodeUnknownOption(JsonText)
const encodeJson = Schema.encodeSync(JsonText)

/** A JSON text scrubbed value by value; text that does not parse is scrubbed as plain text. */
const scrubJsonText = (text: string): string =>
  Option.match(decodeJson(text), { onNone: () => scrubText(text), onSome: (parsed) => encodeJson(scrub(parsed, Option.none())) })

/** A text cell scrubbed by `how`; any other cell (a null, a number) is left as it is. */
const scrubCell = (cell: SQLQueryBindings, how: (text: string) => string): SQLQueryBindings =>
  Option.match(Option.liftPredicate(cell, Predicate.isString), { onNone: () => cell, onSome: how })

type Row = Record<string, SQLQueryBindings>
/** How one table's rows are copied: which text columns are scrubbed (as JSON or as plain text) and which are dropped (made null by SQL). */
interface Copy {
  readonly table: string
  readonly where: string
  readonly params: ReadonlyArray<string>
  readonly text: ReadonlyArray<string>
  readonly json: ReadonlyArray<string>
  readonly cleared: ReadonlyArray<string>
}
const NONE = { text: [], json: [], cleared: [] }

const marks = (values: ReadonlyArray<string>): string => Arr.map(values, () => "?").join(",")

const transform = (row: Row, copy: Copy): Row =>
  Rec.map(row, (cell, column) =>
    Match.value(column).pipe(
      Match.when((name: string) => Arr.contains(copy.json, name), () => scrubCell(cell, scrubJsonText)),
      Match.when((name: string) => Arr.contains(copy.text, name), () => scrubCell(cell, scrubText)),
      Match.orElse(() => cell),
    ),
  )

const attempt = <A>(step: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new FixtureFailed({ message: `${step}: ${String(cause)}` }) })

/** Copies the rows `copy` selects from `source` into `target`, scrubbed; the number of rows copied. */
const copyRows = Effect.fn("tab-fixture.copy")(function* (source: Database, target: Database, copy: Copy) {
  const rows = yield* attempt(`read ${copy.table}`, () => source.query<Row, Array<string>>(`select * from ${copy.table} where ${copy.where}`).all(...copy.params))
  const first = Arr.head(rows)
  if (Option.isNone(first)) return 0
  const columns = Rec.keys(first.value)
  const insert = yield* attempt(`prepare ${copy.table}`, () =>
    target.prepare<void, Array<SQLQueryBindings>>(`insert into ${copy.table} (${Arr.map(columns, (c) => `"${c}"`).join(",")}) values (${marks(columns)})`),
  )
  yield* attempt(`write ${copy.table}`, () =>
    // Rec.map keeps a row's key order, the order `columns` was read in.
    target.transaction(() => Arr.forEach(rows, (row) => insert.run(...Rec.values(transform(row, copy)))))(),
  )
  if (Arr.isReadonlyArrayNonEmpty(copy.cleared))
    yield* attempt(`clear ${copy.table}`, () =>
      target.run(`update ${copy.table} set ${Arr.map(copy.cleared, (c) => `"${c}" = null`).join(", ")} where ${copy.where}`, [...copy.params]),
    )
  return rows.length
})

// Sessions in batches: sqlite caps the parameters of one statement.
const BATCH = 200

const build = Effect.fn("tab-fixture.build")(function* (input: { readonly from: string; readonly out: string; readonly roots: ReadonlyArray<string> }) {
  const fs = yield* FileSystem.FileSystem
  if (yield* fs.exists(input.out)) return yield* new FixtureFailed({ message: `${input.out} exists: name a new file` })
  const source = yield* Effect.acquireRelease(attempt("open --from", () => new Database(input.from, { readonly: true })), (db) => Effect.sync(() => db.close()))
  const target = yield* Effect.acquireRelease(attempt("open --out", () => new Database(input.out, { create: true })), (db) => Effect.sync(() => db.close()))
  yield* attempt("pragmas", () => target.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF"))
  // Every table is made, so the server finds its schema whole; rows are copied only into the ones below.
  const schema = yield* attempt("read the schema", () =>
    source
      .query<{ sql: string }, []>("select sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by type = 'index'")
      .all(),
  )
  yield* attempt("write the schema", () => Arr.forEach(schema, (row) => target.exec(row.sql)))

  const family = yield* attempt("walk the families", () =>
    source
      .query<{ id: string }, Array<string>>(
        `with recursive tree(id) as (select id from session_v2 where id in (${marks(input.roots)})
           union all select s.id from session_v2 s join tree t on s.parent_id = t.id) select id from tree`,
      )
      .all(...input.roots),
  ).pipe(Effect.map(Arr.map((row) => row.id)))
  yield* Console.log(`${family.length} sessions under ${input.roots.length} roots`)

  const projects = yield* attempt("read the projects", () =>
    source.query<{ project_id: string }, Array<string>>(`select distinct project_id from session_v2 where id in (${marks(family)})`).all(...family),
  ).pipe(Effect.map(Arr.map((row) => row.project_id)))

  yield* copyRows(source, target, { ...NONE, table: "migration", where: "1", params: [] })
  yield* copyRows(source, target, { ...NONE,
    table: "project",
    where: `id in (${marks(projects)})`,
    params: projects,
    text: ["name"],
    cleared: ["icon_url", "icon_url_override", "commands"],
  })
  yield* copyRows(source, target, { ...NONE, table: "project_directory", where: `project_id in (${marks(projects)})`, params: projects })
  yield* copyRows(source, target, { ...NONE, table: "workspace", where: "1", params: [], cleared: ["binding"] })

  const counts = yield* Effect.forEach(Arr.chunksOf(family, BATCH), (batch) =>
    Effect.gen(function* () {
      const where = `session_id in (${marks(batch)})`
      yield* copyRows(source, target, { ...NONE,
        table: "session_v2",
        where: `id in (${marks(batch)})`,
        params: batch,
        text: ["title"],
        json: ["summary_diffs", "metadata"],
        cleared: ["share_url"],
      })
      const messages = yield* copyRows(source, target, { ...NONE, table: "session_message", where, params: batch, json: ["data"] })
      const parts = yield* copyRows(source, target, { ...NONE, table: "session_part", where, params: batch, json: ["data"] })
      return { messages, parts }
    }),
  )
  yield* attempt("checkpoint", () => target.exec("PRAGMA wal_checkpoint(TRUNCATE)"))
  yield* Console.log(
    `${Num.sumAll(Arr.map(counts, (count) => count.messages))} messages, ${Num.sumAll(Arr.map(counts, (count) => count.parts))} parts → ${input.out}`,
  )
}, Effect.scoped)

const command = Command.make(
  "tab-fixture",
  {
    from: Flag.String("from").pipe(Flag.withDescription("A copy of an OpenCode database (opened read-only)")),
    out: Flag.String("out").pipe(Flag.withDescription("The new fixture database (must not exist)")),
    roots: Flag.String("roots").pipe(Flag.withDescription("The root session ids, comma-separated")),
  },
  (input) => build({ from: input.from, out: input.out, roots: Arr.filter(input.roots.split(","), (id) => id.length > 0) }),
).pipe(Command.withDescription("Build the tab bench's scrubbed fixture database"))

if (import.meta.main) Command.run(command, { version: "1.0.0" }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
