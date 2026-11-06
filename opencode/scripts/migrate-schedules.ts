// Move OpenCode's active schedules onto the wake mod, once. Each schedule
// fires by prompting its session with its whole action, a real user message
// each time; a wake or a monitor fires as a short synthetic notice. For each
// active schedule this plans the equivalent `wake` or `monitor` for its
// session, writes a long prompt to a file the note points at, and, with
// --apply, sets the entry over the wakes' `set` RPC and pauses the schedule
// (`POST /api/experimental/schedule/<id>/pause`), so nothing fires twice and
// nothing is deleted. Without --apply it only prints the plan.
//
//   bun scripts/migrate-schedules.ts [--apply] [--db <opencode.db>] [--rows <rows.json>] [--prompts <dir>]
//
// `--db` (default ~/.local/share/opencode/opencode.db) is read with
// `sqlite3 -readonly -json`; `--rows` reads the same rows from a JSON file
// instead (another machine's, fetched with that query). `--prompts` is where
// the prompt files go (default $XDG_STATE_HOME/opencode-wake/schedules).
// --apply reaches the OpenCode service its service file names, as the
// wakes' OS jobs do (mods/wake/cron/fire.ts).
//
// How a schedule maps (OpenCode's packages/schema/src/schedule.ts):
// - `in`/`at` with no check: wake({ at: its next run }).
// - `every` with no check: wake({ at: its next run, everySeconds }).
// - a shell check in `until` mode: monitor until it passes (`matches`, `is` as
//   an anchored pattern, or exit 0), every period, until `ends` (at most a day).
// - a shell check in `if` mode on `every`: a repeating monitor; `changes`:
//   `repeat: "change"` from the stored stdout as its baseline; otherwise
//   `repeat: "match"`, which fires on each new match where the schedule fired
//   on every passing slot. It ends at `ends`, else in 30 days.
// - cron, a Code Mode check, an `if` check on a one-time schedule, and
//   remaining runs: no equivalent; skipped, and said so.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { serviceFile } from "../mods/wake/cron/fire.ts"
import { DEFAULT_INTERVAL_SECONDS, MAX_NOTE, MAX_REPEAT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MIN_EVERY_SECONDS, type SetAsk, WAKES } from "../mods/wake/wake.ts"

/** One active schedule as the query reads it: the table's columns as text, and its session's directory. */
export interface Row {
  readonly id: string
  readonly session_id: string | null
  readonly name: string | null
  readonly action: string
  readonly when: string
  readonly tz: string
  readonly check: string | null
  readonly next_due_at: number | null
  readonly ends_at: number | null
  readonly remaining_runs: number | null
  readonly state: string | null
  readonly directory: string | null
}

export const QUERY = [
  'select s.id, s.session_id, s.name, s.action, s."when", s.tz, s."check", s.next_due_at, s.ends_at, s.remaining_runs, s.state, v.directory',
  "from schedule s left join session_v2 v on v.id = s.session_id where s.status = 'active' order by s.next_due_at",
].join(" ")

/** What one schedule becomes: an entry for its session, or why it stays a schedule. */
export type Plan =
  | {
      readonly schedule: Row
      readonly sessionID: string
      readonly directory: string
      readonly ask: SetAsk
      /** The prompt file the note points at, when the prompt was too long to carry. */
      readonly prompt?: { readonly file: string; readonly text: string }
      /** Where the entry differs from the schedule. */
      readonly differs: ReadonlyArray<string>
    }
  | { readonly schedule: Row; readonly skip: string }

/** A prompt longer than this goes to a file; the note names the file. */
export const INLINE_PROMPT = 200

const UNITS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }

/** A schedule's duration (`15 minutes`, `90 seconds`, `2 hours`) in seconds, or undefined. */
export const secondsOf = (text: string): number | undefined => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|millis(?:econds?)?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)\s*$/i.exec(text)
  if (match === null) return undefined
  const unit = (match[2] ?? "").toLowerCase()
  const key = unit.startsWith("ms") || unit.startsWith("milli") ? "ms" : unit[0] ?? ""
  const factor = UNITS[key]
  return factor === undefined ? undefined : Number(match[1]) * factor
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

interface Shell {
  readonly type: "shell"
  readonly run: string
  readonly is?: string
  readonly matches?: string
  readonly changes?: boolean
}
interface Check {
  readonly mode: "if" | "until"
  readonly condition: Shell | { readonly type: "code" }
}
type When = { readonly type: "in"; readonly in: string } | { readonly type: "at"; readonly at: string } | { readonly type: "every"; readonly every: string } | { readonly type: "cron"; readonly cron: string }

const parse = <A,>(text: string | null): A | undefined => {
  if (text === null) return undefined
  try {
    return JSON.parse(text) as A
  } catch {
    return undefined
  }
}

/** The plan for each active schedule, at `now`, with long prompts going under `prompts`. */
export const plan = (rows: ReadonlyArray<Row>, now: number, prompts: string): ReadonlyArray<Plan> =>
  rows.map((row): Plan => {
    if (row.session_id === null || row.directory === null) return { schedule: row, skip: "it has no session to wake" }
    const action = parse<{ readonly type: string; readonly prompt?: string }>(row.action)
    if (action?.type !== "prompt" || typeof action.prompt !== "string") return { schedule: row, skip: `its action is not a prompt: ${row.action.slice(0, 60)}` }
    const when = parse<When>(row.when)
    if (when === undefined) return { schedule: row, skip: `its time is unreadable: ${row.when}` }
    if (when.type === "cron") return { schedule: row, skip: `cron (${when.cron}, ${row.tz}) has no wake equivalent; set it again as a wake by hand` }
    if (row.remaining_runs !== null) return { schedule: row, skip: `it has ${row.remaining_runs} remaining runs, which a wake cannot count; set it again by hand` }
    const check = parse<Check>(row.check)
    if (check !== undefined && check.condition.type !== "shell") return { schedule: row, skip: "its check is Code Mode, which a monitor cannot run" }

    const name = row.name ?? "schedule"
    const long = action.prompt.length > INLINE_PROMPT
    const file = join(prompts, `${row.id}.md`)
    const note = (long ? `${name} (was OpenCode schedule ${row.id}): read ${file} and do what it says.` : `${name}: ${action.prompt}`).slice(0, MAX_NOTE)
    const prompt = long ? { prompt: { file, text: `<!-- OpenCode schedule ${row.id} "${name}", moved to the wake mod -->\n${action.prompt}\n` } } : {}
    const differs: Array<string> = []
    const next = row.next_due_at ?? now
    const every = when.type === "every" ? secondsOf(when.every) : undefined
    if (when.type === "every" && every === undefined) return { schedule: row, skip: `its period is unreadable: ${when.every}` }
    const base = { schedule: row, sessionID: row.session_id, directory: row.directory, ...prompt }

    if (check === undefined) {
      const at = next <= now ? { afterSeconds: 0 } : { at: new Date(next).toISOString() }
      if (every !== undefined && every < MIN_EVERY_SECONDS) differs.push(`its period ${when.type === "every" ? when.every : ""} is under a minute; the wake repeats every ${MIN_EVERY_SECONDS}s`)
      if (every !== undefined && row.ends_at !== null) differs.push(`it ended at ${new Date(row.ends_at).toISOString()}; a repeating wake runs until cancelled`)
      return { ...base, ask: { sessionID: row.session_id, wake: { ...at, ...(every === undefined ? {} : { everySeconds: Math.max(every, MIN_EVERY_SECONDS) }), note } }, differs }
    }

    const shell = check.condition as Shell
    const until = shell.matches ?? (shell.is === undefined ? undefined : `^${escape(shell.is.trim())}$`)
    if (shell.is !== undefined) differs.push(`its \`is ${JSON.stringify(shell.is)}\` becomes a pattern matching a whole line, not the whole output`)
    if ((shell.is !== undefined || shell.matches !== undefined || shell.changes === true) && until !== undefined)
      differs.push("a non-zero exit was a check error; the pattern now decides alone")
    const interval = every ?? DEFAULT_INTERVAL_SECONDS
    const left = row.ends_at === null ? undefined : Math.floor((row.ends_at - now) / 1000)
    if (left !== undefined && left <= 0) return { schedule: row, skip: `it ended at ${new Date(row.ends_at ?? 0).toISOString()}` }

    if (check.mode === "until") {
      const timeout = Math.min(left ?? MAX_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
      if ((left ?? 0) > MAX_TIMEOUT_SECONDS) differs.push(`it ran until ${new Date(row.ends_at ?? 0).toISOString()}; a monitor gives up after a day`)
      return {
        ...base,
        ask: { sessionID: row.session_id, monitor: { command: shell.run, cwd: row.directory, intervalSeconds: interval, ...(until === undefined ? {} : { until }), timeoutSeconds: timeout, note } },
        differs,
      }
    }
    if (when.type !== "every") return { schedule: row, skip: "an if check on a one-time schedule has no monitor equivalent; set it again by hand" }
    const timeout = Math.min(left ?? MAX_REPEAT_TIMEOUT_SECONDS, MAX_REPEAT_TIMEOUT_SECONDS)
    if (left === undefined) differs.push("it had no end; the monitor ends in 30 days")
    else if (left > MAX_REPEAT_TIMEOUT_SECONDS) differs.push(`it ran until ${new Date(row.ends_at ?? 0).toISOString()}; the monitor ends in 30 days`)
    const changes = shell.changes === true
    if (!changes) differs.push("it fired on every passing slot; the monitor fires on each new match")
    const stored = parse<{ readonly stdout?: string }>(row.state)?.stdout
    return {
      ...base,
      ask: {
        sessionID: row.session_id,
        monitor: {
          command: shell.run,
          cwd: row.directory,
          intervalSeconds: interval,
          ...(until === undefined ? {} : { until }),
          timeoutSeconds: timeout,
          repeat: changes ? "change" : "match",
          ...(changes && stored !== undefined ? { baseline: stored } : {}),
          note,
        },
      },
      differs,
    }
  })

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The plan as the owner reads it. */
export const render = (plans: ReadonlyArray<Plan>, apply: boolean): string => {
  if (plans.length === 0) return "No active schedules."
  const lines = [`${plans.length} active schedule(s)${apply ? "" : " (dry run: nothing is set, written or paused; --apply does it)"}:`]
  for (const item of plans) {
    const row = item.schedule
    lines.push("", `${row.id} "${row.name ?? ""}" (session ${row.session_id ?? "none"}, ${row.when}${row.check === null ? "" : ", checked"})`)
    if ("skip" in item) {
      lines.push(`  skip: ${item.skip}`)
      continue
    }
    const { sessionID: _, ...ask } = item.ask
    const shown = "wake" in ask ? { wake: ask.wake } : { monitor: { ...ask.monitor, command: cut(ask.monitor.command, 120), ...(ask.monitor.baseline === undefined ? {} : { baseline: `<${ask.monitor.baseline.length} chars>` }) } }
    lines.push(`  in ${item.directory}: ${"wake" in shown ? "wake" : "monitor"}(${JSON.stringify("wake" in shown ? shown.wake : shown.monitor)})`)
    if (item.prompt !== undefined) lines.push(`  prompt (${item.prompt.text.length} chars) -> ${item.prompt.file}`)
    for (const difference of item.differs) lines.push(`  differs: ${difference}`)
    lines.push(`  then: pause ${row.id}`)
  }
  return lines.join("\n")
}

export interface Args {
  readonly apply: boolean
  readonly db: string
  readonly rows?: string
  readonly prompts: string
}

export const parseArgs = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>): Args => {
  const home = env.HOME ?? homedir()
  let apply = false
  let db = join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode", "opencode.db")
  let rows: string | undefined
  let prompts = join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "opencode-wake", "schedules")
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === "--apply") apply = true
    else if (flag === "--db") db = value()
    else if (flag === "--rows") rows = value()
    else if (flag === "--prompts") prompts = value()
    else throw new Error(`unknown flag ${flag}`)
  }
  return { apply, db, prompts, ...(rows === undefined ? {} : { rows }) }
}

/** The active schedules: from the rows file, else the database, read only. */
export const readRows = (args: Args): ReadonlyArray<Row> => {
  if (args.rows !== undefined) return JSON.parse(readFileSync(args.rows, "utf8")) as ReadonlyArray<Row>
  const ran = Bun.spawnSync(["sqlite3", "-readonly", "-json", args.db, QUERY], { stdout: "pipe", stderr: "pipe" })
  if (ran.exitCode !== 0) throw new Error(`sqlite3 ${args.db}: ${ran.stderr.toString().trim()}`)
  const text = ran.stdout.toString().trim()
  return text === "" ? [] : (JSON.parse(text) as ReadonlyArray<Row>)
}

/** Set each planned entry and pause its schedule, through the service; one line per schedule. */
const applyPlans = async (plans: ReadonlyArray<Plan>, env: Readonly<Record<string, string | undefined>>): Promise<ReadonlyArray<string>> => {
  const service = JSON.parse(readFileSync(serviceFile({ ...(env.HOME === undefined ? {} : { HOME: env.HOME }), ...(env.XDG_STATE_HOME === undefined ? {} : { XDG_STATE_HOME: env.XDG_STATE_HOME }) }), "utf8")) as {
    readonly url: string
    readonly password?: string
  }
  const headers = { "content-type": "application/json", ...(service.password === undefined ? {} : { authorization: `Basic ${btoa(`opencode:${service.password}`)}` }) }
  const url = service.url.replace(/\/$/, "")
  const said: Array<string> = []
  for (const item of plans) {
    if ("skip" in item) {
      said.push(`${item.schedule.id}: skipped (${item.skip})`)
      continue
    }
    if (item.prompt !== undefined) {
      mkdirSync(join(item.prompt.file, ".."), { recursive: true })
      writeFileSync(item.prompt.file, item.prompt.text)
    }
    const location = new URLSearchParams({ "location[directory]": item.directory }).toString()
    const set = await fetch(`${url}/api/rpc/${encodeURIComponent(WAKES.id)}/set?${location}`, { method: "POST", headers, body: JSON.stringify({ input: item.ask }) })
    const answer = (await set.json().catch(() => undefined)) as { readonly output?: { readonly outcome: string; readonly id?: string; readonly reason?: string } } | undefined
    if (answer?.output?.outcome !== "set") {
      said.push(`${item.schedule.id}: not set (${answer?.output?.reason ?? `HTTP ${set.status}`}); the schedule stays active`)
      continue
    }
    const paused = await fetch(`${url}/api/experimental/schedule/${encodeURIComponent(item.schedule.id)}/pause?${location}`, { method: "POST", headers })
    said.push(`${item.schedule.id}: set ${answer.output.id ?? ""}; ${paused.ok ? "paused" : `NOT paused (HTTP ${paused.status}): pause it by hand, or both fire`}`)
  }
  return said
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2), process.env)
    const plans = plan(readRows(args), Date.now(), args.prompts)
    console.log(render(plans, args.apply))
    if (args.apply) console.log(["", ...(await applyPlans(plans, process.env))].join("\n"))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
