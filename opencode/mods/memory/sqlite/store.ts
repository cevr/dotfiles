// NoteStore over one SQLite file per host (bun:sqlite): the notes, a full-text
// index over their text and tags (FTS5, porter stemming, kept by triggers), and
// each session's digest. WAL and a busy timeout let every OpenCode server on
// the host, each copy of the plugin and the CLI share the file.
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect"
import type { Bucket, Note } from "../note.ts"
import { MemoryStoreFailed, NoteStore, type Reading } from "../service.ts"

/** The host's memory file: `$XDG_STATE_HOME/opencode-memory/memory.db`, `~/.local/state` when unset. */
export const defaultPath = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  join(env["XDG_STATE_HOME"] || join(TuiDirs.dirs().home, ".local/state"), "opencode-memory", "memory.db")

/** How long a session's kept digest stays, in ms; older ones are dropped as new ones are kept. */
const DIGEST_DAYS = 30 * 86_400_000

const SCHEMA = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project TEXT NOT NULL,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    shown INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0,
    session TEXT NOT NULL,
    place TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS notes_bucket ON notes (scope, project, updated)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, tags, content = 'notes', content_rowid = 'id', tokenize = 'porter unicode61')",
  `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts (notes_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF text, tags ON notes BEGIN
    INSERT INTO notes_fts (notes_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    INSERT INTO notes_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END`,
  "CREATE TABLE IF NOT EXISTS digests (session TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL)",
]

interface Row {
  readonly id: number
  readonly scope: Note["scope"]
  readonly project: string
  readonly text: string
  readonly tags: string
  readonly created: number
  readonly updated: number
  readonly uses: number
  readonly shown: number
  readonly used: number
  readonly session: string
  readonly place: string
}

const tagsOf = (raw: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : []
  } catch {
    return []
  }
}

const noteOf = (row: Row): Note => ({ ...row, tags: tagsOf(row.tags) })

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The SQL that keeps a row to `within`, and its bindings. */
const bucketClause = (within: ReadonlyArray<Bucket>) => ({
  sql: within.map(() => "(notes.scope = ? AND notes.project = ?)").join(" OR "),
  bindings: within.flatMap((bucket) => [bucket.scope, bucket.project]),
})

/** The store on an open database. */
export const make = (db: Database): NoteStore["Service"] => {
  const run = <A>(name: string, body: () => A) =>
    Effect.try({ try: body, catch: (cause) => new MemoryStoreFailed({ message: `${name}: ${messageOf(cause)}` }) })
  const getRow = (id: number) => db.query<Row, [number]>("SELECT * FROM notes WHERE id = ?").get(id)

  return NoteStore.of({
    add: (draft) =>
      run("add", () => {
        const row = db
          .query<Row, Array<string | number>>(
            "INSERT INTO notes (scope, project, text, tags, created, updated, uses, shown, used, session, place) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
          )
          .get(draft.scope, draft.project, draft.text, JSON.stringify(draft.tags), draft.created, draft.updated, draft.uses, draft.shown, draft.used, draft.session, draft.place)
        if (row === null) throw new Error("the insert returned no row")
        return noteOf(row)
      }),
    put: (note) =>
      run("put", () => {
        db.query(
          "UPDATE notes SET scope = ?, project = ?, text = ?, tags = ?, created = ?, updated = ?, uses = ?, shown = ?, used = ?, session = ?, place = ? WHERE id = ?",
        ).run(note.scope, note.project, note.text, JSON.stringify(note.tags), note.created, note.updated, note.uses, note.shown, note.used, note.session, note.place, note.id)
      }),
    get: (id) =>
      run("get", () => {
        const row = getRow(id)
        return row === null ? undefined : noteOf(row)
      }),
    remove: (id) => run("remove", () => db.query("DELETE FROM notes WHERE id = ?").run(id).changes > 0),
    match: (query, within, limit) =>
      run("match", () => {
        if (within.length === 0 || query.trim() === "") return []
        const clause = bucketClause(within)
        return db
          .query<Row, Array<string | number>>(
            `SELECT notes.* FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ? AND (${clause.sql}) ORDER BY bm25(notes_fts), notes.id LIMIT ?`,
          )
          .all(query, ...clause.bindings, limit)
          .map(noteOf)
      }),
    list: ({ within, limit }) =>
      run("list", () => {
        if (within !== undefined && within.length === 0) return []
        const clause = within === undefined ? undefined : bucketClause(within)
        return db
          .query<Row, Array<string | number>>(
            `SELECT * FROM notes ${clause === undefined ? "" : `WHERE ${clause.sql}`} ORDER BY updated DESC, id DESC LIMIT ?`,
          )
          .all(...(clause?.bindings ?? []), limit ?? -1)
          .map(noteOf)
      }),
    read: (ids, reading: Reading, now) =>
      run("read", () => {
        if (ids.length === 0) return
        const column = reading === "uses" ? "uses" : "shown"
        db.query(`UPDATE notes SET ${column} = ${column} + 1, used = ? WHERE id IN (${ids.map(() => "?").join(", ")})`).run(now, ...ids)
      }),
    keepDigest: (sessionID, text, now) =>
      run("keepDigest", () =>
        db.transaction(() => {
          const fresh = db.query("INSERT OR IGNORE INTO digests (session, text, created) VALUES (?, ?, ?)").run(sessionID, text, now).changes > 0
          if (fresh) db.query("DELETE FROM digests WHERE created < ?").run(now - DIGEST_DAYS)
          const kept = db.query<{ text: string }, [string]>("SELECT text FROM digests WHERE session = ?").get(sessionID)
          return { text: kept?.text ?? text, fresh }
        })(),
      ),
  })
}

/** Opens (and creates) the database at `path`; `:memory:` for one that lives with the scope. */
export const open = (path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
        const db = new Database(path, { create: true, strict: true })
        for (const statement of SCHEMA) db.run(statement)
        return db
      },
      catch: (cause) => new MemoryStoreFailed({ message: `open ${path}: ${messageOf(cause)}` }),
    }),
    (db) => Effect.sync(() => db.close()),
  )

/** The store on the file at `path`, open for the layer's life. */
export const layer = (path: string) => Layer.effect(NoteStore, Effect.map(open(path), make))
