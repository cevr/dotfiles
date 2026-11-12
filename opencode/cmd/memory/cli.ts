/**
 * The memory CLI: read and edit this host's memory file from a shell, for a
 * reviewer (the weekly dream) or the owner. It opens the file the plugin uses
 * (`$XDG_STATE_HOME/opencode-memory/memory.db`, or `--db`), so a running
 * OpenCode sees each change at its next session. Reading here never counts as
 * a use: only the agent's searches and the digests do.
 *
 *   bun opencode/cmd/memory/cli.ts <command> [--db <file>] [--json]
 *
 *   list [--scope global|project] [--project <id>] [--limit <n>]
 *   search <words…> [--project <id>] [--limit <n>]   the project's notes and the global ones; every note without --project
 *   show <id>
 *   add <text…> --scope global|project [--project <id>] [--tags a,b]
 *   edit <id> [--text <text>] [--tags a,b] [--scope global|project] [--project <id>]
 *   merge <keep> <drop> [--text <text>]   keep one note: the uses and showings add up, the tags join, <drop> goes
 *   forget <id>
 *   projects                              each project's id, notes and the directories they were saved in
 *   stats [--stale-days <n>]              each note's readings, the stale ones, near pairs, each digest's fill
 *
 * Exit 0 on success, 1 when a note is missing or a value is refused, 2 on a usage error.
 */
import { parseArgs } from "node:util"
import { Data, Effect } from "effect"
import { auditOf, statOf } from "@dotfiles/opencode-memory/audit"
import { LIMITS } from "@dotfiles/opencode-memory/digest"
import { bucketOf, type Bucket, matchQuery, mergeTags, type Note, type Scope, tagsOf, textOf, visible } from "@dotfiles/opencode-memory/note"
import { NoteStore } from "@dotfiles/opencode-memory/service"
import * as SqliteStore from "@dotfiles/opencode-memory/sqlite/store"

export const USAGE = `usage: bun opencode/cmd/memory/cli.ts <command> [--db <file>] [--json]
  list [--scope global|project] [--project <id>] [--limit <n>]
  search <words...> [--project <id>] [--limit <n>]
  show <id>
  add <text...> --scope global|project [--project <id>] [--tags a,b]
  edit <id> [--text <text>] [--tags a,b] [--scope global|project] [--project <id>]
  merge <keep> <drop> [--text <text>]
  forget <id>
  projects
  stats [--stale-days <n>]`

/** Who the CLI records as a note's saver. */
const SAVER = "cli"

export interface Outcome {
  readonly code: 0 | 1 | 2
  readonly out: string
}

/** A command the CLI will not run: 1 for a missing note or a refused value, 2 for a usage error. */
class Refused extends Data.TaggedError("Refused")<{ readonly code: 1 | 2; readonly message: string }> {}

const usage = (message: string) => new Refused({ code: 2, message: `${message}\n${USAGE}` })

const idOf = (raw: string | undefined): Effect.Effect<number, Refused> => {
  const id = Number(raw)
  return raw === undefined || !Number.isInteger(id) || id <= 0 ? Effect.fail(usage(`not a note id: ${raw ?? "(none)"}`)) : Effect.succeed(id)
}

const scopeOf = (raw: string | undefined): Effect.Effect<Scope | undefined, Refused> => {
  if (raw === undefined) return Effect.succeed(undefined)
  if (raw === "global" || raw === "project") return Effect.succeed(raw)
  return Effect.fail(usage(`--scope is global or project, not ${raw}`))
}

const countOf = (raw: string | undefined, name: string): Effect.Effect<number | undefined, Refused> => {
  if (raw === undefined) return Effect.succeed(undefined)
  const value = Number(raw)
  return !Number.isInteger(value) || value <= 0 ? Effect.fail(usage(`--${name} is a whole number above 0, not ${raw}`)) : Effect.succeed(value)
}

const tagList = (raw: string | undefined): ReadonlyArray<string> | undefined => (raw === undefined ? undefined : tagsOf(raw.split(",")))

const checkedText = (raw: string): Effect.Effect<string, Refused> => {
  const text = textOf(raw)
  if (typeof text === "string") return Effect.succeed(text)
  return Effect.fail(
    new Refused({ code: 1, message: text._tag === "EmptyNote" ? "the note is empty" : `the note is ${text.length} characters; the limit is ${text.limit}` }),
  )
}

/** The bucket a scope and project name; a project note needs its project. */
const bucketFrom = (scope: Scope, project: string | undefined): Effect.Effect<Bucket, Refused> =>
  scope === "project" && (project === undefined || project === "")
    ? Effect.fail(usage("a project note needs --project <id> (see `projects`)"))
    : Effect.succeed(bucketOf(scope, project ?? ""))

const line = (note: Note) => {
  const where = note.scope === "global" ? "global" : `project ${note.project}`
  return `#${note.id} [${where}] ${note.text}${note.tags.length === 0 ? "" : ` [${note.tags.join(", ")}]`} · uses ${note.uses} · shown ${note.shown}`
}

const COMMANDS = new Set(["list", "search", "show", "add", "edit", "merge", "forget", "projects", "stats"])

const OPTIONS = {
  db: { type: "string" },
  json: { type: "boolean", default: false },
  scope: { type: "string" },
  project: { type: "string" },
  limit: { type: "string" },
  tags: { type: "string" },
  text: { type: "string" },
  "stale-days": { type: "string" },
} as const

/** Runs one command against the file at `--db`, else `db`. `now` is the clock, epoch ms. */
export const main = async (argv: ReadonlyArray<string>, context: { readonly db: string; readonly now: number }): Promise<Outcome> => {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; args: Array<string> }>>
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true })
  } catch (error) {
    return { code: 2, out: `${error instanceof Error ? error.message : String(error)}\n${USAGE}` }
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  // A usage error never opens (or creates) the file.
  if (command === undefined || !COMMANDS.has(command)) return { code: 2, out: `${command === undefined ? "no command" : `unknown command: ${command}`}\n${USAGE}` }
  const now = context.now
  const json = values.json === true
  const print = (human: string, data: unknown) => (json ? JSON.stringify(data, null, 2) : human)

  const program = Effect.gen(function* () {
    const store = yield* NoteStore
    const found = Effect.fn("MemoryCli.found")(function* (id: number) {
      const note = yield* store.get(id)
      if (note === undefined) return yield* new Refused({ code: 1, message: `no note #${id}` })
      return note
    })
    switch (command) {
      case "list": {
        const scope = yield* scopeOf(values.scope)
        const within = scope === undefined ? (values.project === undefined ? undefined : visible(values.project)) : [yield* bucketFrom(scope, values.project)]
        const notes = yield* store.list({ ...(within === undefined ? {} : { within }), ...(values.limit === undefined ? {} : { limit: (yield* countOf(values.limit, "limit"))! }) })
        return print(notes.length === 0 ? "no notes" : notes.map(line).join("\n"), notes.map((note) => statOf(note, now)))
      }
      case "search": {
        const query = matchQuery(rest.join(" "))
        if (query === "") return yield* usage("search needs words to look for")
        const projects = values.project === undefined ? (yield* store.list({})).map((note) => ({ scope: note.scope, project: note.project })) : visible(values.project)
        const within = [...new Map(projects.map((bucket) => [`${bucket.scope}:${bucket.project}`, bucket])).values()]
        const notes = yield* store.match(query, within, (yield* countOf(values.limit, "limit")) ?? 20)
        return print(notes.length === 0 ? "no note matches" : notes.map(line).join("\n"), notes.map((note) => statOf(note, now)))
      }
      case "show": {
        const note = yield* found(yield* idOf(rest[0]))
        const stat = statOf(note, now)
        return print(
          [line(note), `created ${stat.created} · updated ${stat.updated} · last used ${stat.used ?? "never"} · saved by ${note.session} in ${note.place || "?"}`].join("\n"),
          { ...stat, session: note.session, place: note.place },
        )
      }
      case "add": {
        const scope = yield* scopeOf(values.scope)
        if (scope === undefined) return yield* usage("add needs --scope global or --scope project")
        const bucket = yield* bucketFrom(scope, values.project)
        const note = yield* store.add({
          ...bucket,
          text: yield* checkedText(rest.join(" ")),
          tags: tagList(values.tags) ?? [],
          created: now,
          updated: now,
          uses: 0,
          shown: 0,
          used: 0,
          session: SAVER,
          place: "",
        })
        return print(`added ${line(note)}`, statOf(note, now))
      }
      case "edit": {
        const note = yield* found(yield* idOf(rest[0]))
        const scope = yield* scopeOf(values.scope)
        const bucket = scope === undefined ? (values.project === undefined ? note : yield* bucketFrom(note.scope, values.project)) : yield* bucketFrom(scope, values.project ?? note.project)
        const edited: Note = {
          ...note,
          scope: bucket.scope,
          project: bucket.project,
          text: values.text === undefined ? note.text : yield* checkedText(values.text),
          tags: tagList(values.tags) ?? note.tags,
          updated: now,
          session: SAVER,
        }
        yield* store.put(edited)
        return print(`edited ${line(edited)}\nwas    ${line(note)}`, { now: statOf(edited, now), was: statOf(note, now) })
      }
      case "merge": {
        const keep = yield* found(yield* idOf(rest[0]))
        const drop = yield* found(yield* idOf(rest[1]))
        if (keep.id === drop.id) return yield* usage("merge needs two different notes")
        const merged: Note = {
          ...keep,
          text: values.text === undefined ? keep.text : yield* checkedText(values.text),
          tags: mergeTags(keep.tags, drop.tags),
          created: Math.min(keep.created, drop.created),
          updated: now,
          uses: keep.uses + drop.uses,
          shown: keep.shown + drop.shown,
          used: Math.max(keep.used, drop.used),
          session: SAVER,
        }
        yield* store.put(merged)
        yield* store.remove(drop.id)
        return print(`merged #${drop.id} into ${line(merged)}`, { kept: statOf(merged, now), dropped: statOf(drop, now) })
      }
      case "forget": {
        const note = yield* found(yield* idOf(rest[0]))
        yield* store.remove(note.id)
        return print(`forgot ${line(note)}`, statOf(note, now))
      }
      case "projects": {
        const notes = yield* store.list({})
        const projects = new Map<string, { notes: number; places: Set<string>; updated: number }>()
        for (const note of notes) {
          if (note.scope !== "project") continue
          const entry = projects.get(note.project) ?? { notes: 0, places: new Set<string>(), updated: 0 }
          entry.notes += 1
          if (note.place !== "") entry.places.add(note.place)
          entry.updated = Math.max(entry.updated, note.updated)
          projects.set(note.project, entry)
        }
        const rows = [...projects].map(([project, entry]) => ({
          project,
          notes: entry.notes,
          places: [...entry.places].sort(),
          updated: new Date(entry.updated).toISOString(),
        }))
        const global = notes.filter((note) => note.scope === "global").length
        return print(
          [`global: ${global} notes`, ...rows.map((row) => `${row.project}: ${row.notes} notes · ${row.places.join(", ") || "?"}`)].join("\n"),
          { global, projects: rows },
        )
      }
      case "stats": {
        const audit = auditOf(yield* store.list({}), now, {
          ...(values["stale-days"] === undefined ? {} : { staleDays: (yield* countOf(values["stale-days"], "stale-days"))! }),
          limits: LIMITS,
        })
        const human = [
          `${audit.total} notes · ${audit.global} global · ${Object.keys(audit.projects).length} projects`,
          `stale (idle ${audit.staleDays}+ days): ${audit.stale.map((id) => `#${id}`).join(" ") || "none"}`,
          `near pairs: ${audit.near.map((pair) => `#${pair.a}~#${pair.b} ${pair.similarity}`).join(", ") || "none"}`,
          ...audit.digests.map(
            (fill) => `digest ${fill.project || "(global only)"}: holds ${fill.holds} of ${fill.visible} · ${fill.chars} chars (lines capped at ${fill.limits.chars})`,
          ),
          ...audit.notes.map((stat) => `#${stat.id} uses ${stat.uses} · shown ${stat.shown} · idle ${stat.idleDays}d · ${stat.text}`),
        ].join("\n")
        return print(human, audit)
      }
      default:
        return yield* usage(`unknown command: ${command}`)
    }
  })

  return Effect.runPromise(
    program.pipe(
      Effect.provide(SqliteStore.layer(values.db ?? context.db)),
      Effect.map((out): Outcome => ({ code: 0, out })),
      Effect.catch((failure) =>
        Effect.succeed<Outcome>(failure._tag === "Refused" ? { code: failure.code, out: failure.message } : { code: 1, out: `memory: ${failure.message}` }),
      ),
    ),
  )
}

if (import.meta.main) {
  const outcome = await main(process.argv.slice(2), { db: SqliteStore.defaultPath(), now: Date.now() })
  ;(outcome.code === 0 ? console.log : console.error)(outcome.out)
  process.exit(outcome.code)
}
