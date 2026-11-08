// The memory each arm offers, over one store an episode's two sessions share.
//
// - ours: the real memory model (mods/memory/model.ts) on its real SQLite store
//   in a scratch file, wired as cmd/memory/server.ts wires it: the three tools
//   with their real names, descriptions, inputs and answers (notebook.ts), and
//   the session's digest (`MemoryModel.digest`, which is digest.ts `digestOf`
//   under `HEADING`) last in the system prompt, nothing when there are no
//   notes. The composition root itself is not imported: it pulls in the fork's
//   plugin package, whose sources the root project cannot typecheck.
// - native: Anthropic's memory tool (`memory_20250818`), the six commands over
//   a scratch directory mapped to /memories; a path outside it is refused.
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, normalize, relative } from "node:path"
import * as Model from "../../mods/memory/model.ts"
import {
  explain,
  FORGET,
  FORGET_DESCRIPTION,
  ForgetInput,
  forgotText,
  foundText,
  type Rejection,
  SAVE,
  SAVE_DESCRIPTION,
  savedText,
  SaveInput,
  SEARCH,
  SEARCH_DESCRIPTION,
  SearchInput,
} from "../../mods/memory/notebook.ts"
import * as OpenCodeSessions from "../../mods/memory/opencode/sessions.ts"
import type { MemoryStoreFailed, SessionUnreadable } from "../../mods/memory/service.ts"
import * as SqliteStore from "../../mods/memory/sqlite/store.ts"
import { Effect, Layer, Schema } from "./effect.ts"

export interface Answer {
  readonly text: string
  readonly error: boolean
}

/** One stored unit graded for junk: a note, or a line of a memory file. */
export interface Stored {
  readonly units: ReadonlyArray<string>
  /** What a fact is matched against: each note, or each whole file. */
  readonly documents: ReadonlyArray<string>
}

export interface MemoryArm {
  /** The API tool entries this memory adds. */
  readonly tools: ReadonlyArray<unknown>
  readonly names: ReadonlySet<string>
  /** System blocks this memory adds for a session, after the arm's own. */
  readonly system: (sessionID: string) => Promise<ReadonlyArray<string>>
  readonly call: (sessionID: string, name: string, input: Record<string, unknown>) => Promise<Answer>
  readonly stored: () => Stored
  readonly close: () => Promise<void>
}

// ---------------------------------------------------------------- ours

type Failure = Rejection | MemoryStoreFailed | SessionUnreadable

/** What the agent reads when a call fails, as cmd/memory/server.ts words it. */
const messageOf = (failure: Failure): string => {
  if (failure._tag === "MemoryStoreFailed") return `Memory could not be read or written: ${failure.message}`
  if (failure._tag === "SessionUnreadable") return `The session could not be read: ${failure.message}`
  return explain(failure)
}

interface OurTool {
  readonly name: string
  readonly description: string
  readonly input: Schema.Top
  readonly run: (memory: Model.MemoryModel["Service"], sessionID: string, input: never) => Effect.Effect<string, Failure>
}

/** The three tools as cmd/memory/server.ts registers them. */
const OUR_TOOLS: ReadonlyArray<OurTool> = [
  { name: SAVE, description: SAVE_DESCRIPTION, input: SaveInput, run: (memory, sessionID, input: SaveInput) => memory.save(sessionID, input).pipe(Effect.map(savedText)) },
  {
    name: SEARCH,
    description: SEARCH_DESCRIPTION,
    input: SearchInput,
    run: (memory, sessionID, input: SearchInput) => memory.search(sessionID, input).pipe(Effect.map((notes) => foundText(input.query, notes))),
  },
  { name: FORGET, description: FORGET_DESCRIPTION, input: ForgetInput, run: (memory, sessionID, input: ForgetInput) => memory.forget(sessionID, input).pipe(Effect.map(forgotText)) },
]

const PROJECT = "eval-project"

/** A tool's input schema as JSON Schema, as the fork's tool runtime (core/src/tool/runtime.ts) makes it. */
const jsonSchemaOf = (schema: Schema.Top): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  const root = { ...(document.schema as Record<string, unknown>) }
  if (Object.keys(document.definitions).length > 0) root["$defs"] = document.definitions
  return root
}

/** Our memory over a scratch SQLite file in `dir`; every session is a root session of one project. */
export const ours = async (dir: string): Promise<MemoryArm> => {
  const path = join(dir, "memory.db")
  const externals = Layer.merge(
    SqliteStore.layer(path),
    OpenCodeSessions.layer(() => Effect.succeed({ projectID: PROJECT, location: { directory: "/repo" } })),
  )
  // The store's scope stays open for the episode and closes with `close`.
  let release: () => void = () => {}
  const closed = new Promise<void>((resolve) => (release = resolve))
  const ready = Promise.withResolvers<Model.MemoryModel["Service"]>()
  const done = Effect.runPromise(
    Effect.gen(function* () {
      ready.resolve(yield* Model.MemoryModel)
      yield* Effect.promise(() => closed)
    }).pipe(Effect.provide(Model.layer().pipe(Layer.provide(externals)))),
  ).catch((error: unknown) => ready.reject(error))
  const memory = await ready.promise

  return {
    tools: OUR_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: jsonSchemaOf(tool.input) })),
    names: new Set(OUR_TOOLS.map((tool) => tool.name)),
    // The `context` hook: the digest, when there is one, last in the system prompt.
    system: async (sessionID) => {
      const digest = await Effect.runPromise(memory.digest(sessionID))
      return digest === "" ? [] : [digest]
    },
    call: async (sessionID, name, input) => {
      const tool = OUR_TOOLS.find((candidate) => candidate.name === name)!
      return Effect.runPromise(
        Schema.decodeUnknownEffect(tool.input as Schema.Codec<unknown, unknown, never, never>)(input, { errors: "all" }).pipe(
          Effect.matchEffect({
            onFailure: (error) => Effect.succeed({ text: `Invalid arguments for tool "${name}": ${error.message}`, error: true }),
            onSuccess: (decoded) =>
              tool.run(memory, sessionID, decoded as never).pipe(
                Effect.map((text): Answer => ({ text, error: false })),
                Effect.catch((failure: Failure) => Effect.succeed({ text: messageOf(failure), error: true })),
              ),
          }),
        ),
      )
    },
    stored: () => {
      if (!existsSync(path)) return { units: [], documents: [] }
      const db = new Database(path, { readonly: true })
      try {
        const rows = db.query("SELECT text, tags FROM notes ORDER BY id").all() as Array<{ text: string; tags: string }>
        const units = rows.map((row) => `${row.text} ${(JSON.parse(row.tags) as Array<string>).join(" ")}`.trim())
        return { units, documents: units }
      } finally {
        db.close()
      }
    },
    close: async () => {
      release()
      await done
    },
  }
}

// ---------------------------------------------------------------- native

const ROOT = "/memories"

/** The scratch path a /memories path maps to; undefined for one outside /memories. */
export const resolveMemoryPath = (base: string, path: unknown): string | undefined => {
  if (typeof path !== "string") return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return undefined
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return undefined
  if (decoded !== ROOT && !decoded.startsWith(ROOT + "/")) return undefined
  if (decoded.split("/").includes("..")) return undefined
  const target = normalize(join(base, decoded.slice(ROOT.length)))
  const rel = relative(base, target)
  if (rel.startsWith("..")) return undefined
  return target
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}K`)

const walk = (dir: string, depth: number): Array<string> =>
  readdirSync(dir)
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .sort()
    .flatMap((name) => {
      const full = join(dir, name)
      return [full, ...(depth > 1 && statSync(full).isDirectory() ? walk(full, depth - 1) : [])]
    })

const files = (dir: string): Array<string> => walk(dir, 99).filter((path) => statSync(path).isFile())

/** The memory tool's commands over `base`, answered as the docs' reference handler answers them. */
export const nativeCommand = (base: string, input: Record<string, unknown>): Answer => {
  const fail = (text: string): Answer => ({ text, error: true })
  const ok = (text: string): Answer => ({ text, error: false })
  const shown = (path: string) => ROOT + (relative(base, path) === "" ? "" : "/" + relative(base, path))
  const command = input["command"]
  if (command === "rename") {
    const from = resolveMemoryPath(base, input["old_path"])
    const to = resolveMemoryPath(base, input["new_path"])
    if (from === undefined || to === undefined) return fail(`Error: paths must stay inside ${ROOT}`)
    if (from === base) return fail(`Error: cannot rename ${ROOT} itself`)
    if (!existsSync(from)) return fail(`Error: The path ${input["old_path"]} does not exist`)
    if (existsSync(to)) return fail(`Error: The destination ${input["new_path"]} already exists`)
    mkdirSync(join(to, ".."), { recursive: true })
    renameSync(from, to)
    return ok(`Successfully renamed ${input["old_path"]} to ${input["new_path"]}`)
  }
  const path = resolveMemoryPath(base, input["path"])
  if (path === undefined) return fail(`Error: the path ${String(input["path"])} is outside ${ROOT}; every memory path starts with ${ROOT}`)
  const isFile = existsSync(path) && statSync(path).isFile()
  switch (command) {
    case "view": {
      if (!existsSync(path)) return fail(`The path ${input["path"]} does not exist. Please provide a valid path.`)
      if (!isFile) {
        const lines = [path, ...walk(path, 2)].map((entry) => `${size(statSync(entry).isFile() ? statSync(entry).size : 4096)}\t${shown(entry)}`)
        return ok(`Here're the files and directories up to 2 levels deep in ${shown(path)}, excluding hidden items and node_modules:\n${lines.join("\n")}`)
      }
      let lines = readFileSync(path, "utf8").replace(/\n$/, "").split("\n")
      let start = 1
      const range = input["view_range"]
      if (Array.isArray(range) && range.length === 2) {
        start = Math.max(1, Number(range[0]))
        const end = Number(range[1]) === -1 ? lines.length : Number(range[1])
        lines = lines.slice(start - 1, end)
      }
      return ok(`Here's the content of ${shown(path)} with line numbers:\n${lines.map((line, index) => `${String(index + start).padStart(6)}\t${line}`).join("\n")}`)
    }
    case "create": {
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, String(input["file_text"] ?? ""))
      return ok(`File created successfully at: ${shown(path)}`)
    }
    case "str_replace": {
      if (!isFile) return fail(`Error: The path ${input["path"]} does not exist. Please provide a valid path.`)
      const text = readFileSync(path, "utf8")
      const oldStr = String(input["old_str"] ?? "")
      const count = oldStr === "" ? 0 : text.split(oldStr).length - 1
      if (count === 0) return fail(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${input["path"]}.`)
      if (count > 1) return fail(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\`. Please ensure it is unique`)
      writeFileSync(path, text.replace(oldStr, () => String(input["new_str"] ?? "")))
      return ok("The memory file has been edited.")
    }
    case "insert": {
      if (!isFile) return fail(`Error: The path ${input["path"]} does not exist`)
      const lines = readFileSync(path, "utf8").split("\n")
      const at = Number(input["insert_line"])
      if (!Number.isInteger(at) || at < 0 || at > lines.length)
        return fail(`Error: Invalid \`insert_line\` parameter: ${input["insert_line"]}. It should be within the range of lines of the file: [0, ${lines.length}]`)
      lines.splice(at, 0, String(input["insert_text"] ?? "").replace(/\n$/, ""))
      writeFileSync(path, lines.join("\n"))
      return ok(`The file ${input["path"]} has been edited.`)
    }
    case "delete": {
      if (path === base) return fail(`Error: cannot delete ${ROOT} itself`)
      if (!existsSync(path)) return fail(`Error: The path ${input["path"]} does not exist`)
      rmSync(path, { recursive: true })
      return ok(`Successfully deleted ${input["path"]}`)
    }
    default:
      return fail(`Error: unknown command ${String(command)}`)
  }
}

/** Anthropic's memory tool over a scratch directory in `dir`. */
export const native = async (dir: string): Promise<MemoryArm> => {
  const base = join(dir, "memories")
  mkdirSync(base, { recursive: true })
  return {
    tools: [{ type: "memory_20250818", name: "memory" }],
    names: new Set(["memory"]),
    system: async () => [],
    call: async (_sessionID, _name, input) => nativeCommand(base, input),
    stored: () => {
      const documents = files(base).map((path) => readFileSync(path, "utf8"))
      const units = documents.flatMap((text) =>
        text
          .split("\n")
          .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim())
          .filter((line) => line !== "" && !line.startsWith("#") && !/^[=\-*_]{3,}$/.test(line)),
      )
      return { units, documents }
    },
    close: async () => {},
  }
}
