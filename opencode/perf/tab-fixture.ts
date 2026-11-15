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
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

const args = process.argv.slice(2)
const opt = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const from = opt("from")
const out = opt("out")
const roots = (opt("roots") ?? "").split(",").filter(Boolean)
if (!from || !out || roots.length === 0) throw new Error("usage: --from <copy of opencode.db> --out <new .db> --roots <id,...>")
if (existsSync(out)) throw new Error(`${out} exists: name a new file`)

// Keys whose string values are structure, not content: kept as they are.
const KEEP = new Set([
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
// Only a word-like value is kept, so a file name or a sentence under such a key is scrubbed all the same.
const keep = (key: string | undefined, value: string) =>
  key !== undefined && (KEEP.has(key) || key === "id" || key.endsWith("ID")) && /^[\w.:-]{1,64}$/.test(value)
const scrubText = (value: string) => value.replace(/\p{L}/gu, "x").replace(/\p{N}/gu, "0")
const scrub = (value: unknown, key?: string): unknown => {
  if (typeof value === "string") {
    if (keep(key, value)) return value
    // A data URI keeps its header; its payload becomes zero bytes of the same length.
    const data = /^data:[^,]*,/.exec(value)
    if (data) return data[0] + "A".repeat(value.length - data[0].length)
    return scrubText(value)
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, key))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]))
  return value
}
const scrubJson = (text: string | null) => (text === null ? null : JSON.stringify(scrub(JSON.parse(text))))

const source = new Database(from, { readonly: true })
const target = new Database(out, { create: true })
target.exec("PRAGMA journal_mode = WAL")
target.exec("PRAGMA foreign_keys = OFF")
// Every table is made, so the server finds its schema whole; rows are copied only into the ones below.
const schema = source
  .query<{ type: string; tbl_name: string; sql: string | null }, []>(
    "select type, tbl_name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by type = 'index'",
  )
  .all()
for (const row of schema) target.exec(row.sql!)

const family = source
  .query<{ id: string }, []>(
    `with recursive tree(id) as (select id from session_v2 where id in (${roots.map(() => "?").join(",")})
       union all select s.id from session_v2 s join tree t on s.parent_id = t.id) select id from tree`,
  )
  .all(...(roots as []))
  .map((row) => row.id)
console.log(`${family.length} sessions under ${roots.length} roots`)

const copy = (table: string, where: string, params: ReadonlyArray<string>, transform: (row: Record<string, unknown>) => void) => {
  const rows = source.query<Record<string, unknown>, []>(`select * from ${table} where ${where}`).all(...(params as []))
  if (rows.length === 0) return 0
  const columns = Object.keys(rows[0]!)
  const insert = target.prepare(`insert into ${table} (${columns.map((c) => `"${c}"`).join(",")}) values (${columns.map(() => "?").join(",")})`)
  target.transaction(() => {
    for (const row of rows) {
      transform(row)
      insert.run(...(columns.map((column) => row[column]) as []))
    }
  })()
  return rows.length
}
copy("migration", "1", [], () => {})
const projects = [
  ...new Set(
    source
      .query<{ project_id: string }, []>(
        `select distinct project_id from session_v2 where id in (${family.map(() => "?").join(",")})`,
      )
      .all(...(family as []))
      .map((row) => row.project_id),
  ),
]
const marks = (values: ReadonlyArray<string>) => values.map(() => "?").join(",")
copy("project", `id in (${marks(projects)})`, projects, (row) => {
  row.name = row.name === null ? null : scrubText(String(row.name))
  row.icon_url = null
  row.icon_url_override = null
  row.commands = null
})
copy("project_directory", `project_id in (${marks(projects)})`, projects, () => {})
copy("workspace", "1", [], (row) => {
  row.binding = null
})
// Sessions in batches: sqlite caps the parameters of one statement.
const batches = <T>(values: ReadonlyArray<T>, size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size))
let messages = 0
let parts = 0
for (const batch of batches(family, 200)) {
  copy("session_v2", `id in (${marks(batch)})`, batch, (row) => {
    row.title = row.title === null ? null : scrubText(String(row.title))
    row.summary_diffs = scrubJson(row.summary_diffs as string | null)
    row.metadata = scrubJson(row.metadata as string | null)
    row.share_url = null
  })
  messages += copy("session_message", `session_id in (${marks(batch)})`, batch, (row) => {
    row.data = scrubJson(row.data as string)
  })
  parts += copy("session_part", `session_id in (${marks(batch)})`, batch, (row) => {
    row.data = scrubJson(row.data as string)
  })
}
target.exec("PRAGMA wal_checkpoint(TRUNCATE)")
target.close()
console.log(`${messages} messages, ${parts} parts → ${out}`)
