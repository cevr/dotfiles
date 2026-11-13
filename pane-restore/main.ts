#!/usr/bin/env bun
// pane-restore: carry each Herdr pane's OpenCode session across a move to
// herdr-core (hc). `save` reads herdr's live panes and the session each
// OpenCode TUI has open; `check` asks the OpenCode server that every saved
// session still opens; `restore` labels each moved pane's hc terminal with
// `migrate.resume`, so `hcm resume` types `opencode --session <id>` there once.
// See README.md.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

const USAGE = `usage: pane-restore save [--machine <herdr machine> | --session <herdr session>] [--herdr-state <session.json>]
       pane-restore check [<saved file>]
       pane-restore restore [<saved file>]
       pane-restore restore --herdr [--machine <herdr machine>] [<saved file>]

save     record every herdr pane: workspace, tab, cwd and the OpenCode session
         its TUI has open, in $XDG_STATE_HOME/pane-restore/<host>-<time>.json
check    ask the OpenCode server that every saved session still opens
restore  after \`hcm apply\`, label each saved OpenCode pane's hc terminal with
         migrate.resume=opencode --session <id>; \`hcm resume\` then types it once.
         It never types into a terminal itself.
restore --herdr
         after a herdr restart, run \`opencode --session <id>\` (herdr pane run)
         in each saved pane that is back as an idle shell, in the herdr the
         save read (its --machine or --session). A pane that runs anything, or
         a session already open in another pane, is skipped.
With no file, check and restore use the newest save of this host (or of
--machine).`

/** hcm's label: the command \`hcm resume\` types into the terminal, then empties. */
const RESUME = "migrate.resume"
/** hcm's label: the Herdr tab a terminal was moved from, `<workspace id>/<tab index>`. */
const FROM = "migrate.from"
const SESSION_ID = /^ses_[A-Za-z0-9]+$/
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "nu", "tcsh"])

export interface SavedPane {
  readonly workspace: { readonly id: string; readonly label: string }
  readonly tab: { readonly id: string; readonly label: string; readonly index: number }
  /** hcm's `migrate.from` for the pane's tab. */
  readonly from: string
  readonly pane: string
  readonly cwd: string
  readonly session: string | null
  /** Where the session id came from: herdr's own record, or the TUI's arguments. */
  readonly source: "herdr-state" | "argv" | null
}

export interface Saved {
  readonly version: 1
  readonly host: string
  readonly machine: string | null
  /** The named herdr session the save read (`--session`), when not the default. */
  readonly session?: string | null
  readonly time: string
  readonly panes: ReadonlyArray<SavedPane>
}

// ── processes ──

const exec = (argv: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

const json = (argv: ReadonlyArray<string>): any => {
  const result = exec(argv)
  if (result.code !== 0) throw new Error(`${argv.join(" ")} exited ${result.code}: ${result.stderr.trim()}`)
  return JSON.parse(result.stdout)
}

// ── save ──

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** herdr's public number as it appears in an id: Crockford base 32 (54 is `1P`). */
export const publicNumber = (n: number): string => (n < 32 ? CROCKFORD[n]! : publicNumber(Math.floor(n / 32)) + CROCKFORD[n % 32]!)

const sessionFromArgv = (argv: ReadonlyArray<string>): string | undefined => {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "-s" || argv[i] === "--session") return argv[i + 1]
  }
  const joined = argv.find((arg) => arg.startsWith("--session="))
  return joined?.slice("--session=".length)
}

const isOpencode = (argv: ReadonlyArray<string>) => (argv[0] ?? "").split("/").at(-1)?.startsWith("opencode") === true

/**
 * herdr's own pane → session record, from its session.json (read as a copy):
 * herdr 0.9.5 keeps each pane's reported `agent_resume` argv, and an official
 * integration's `agent_session`. Keyed by public pane id (`wA:p1P`).
 */
export const herdrStateSessions = (state: any): Map<string, string> => {
  const sessions = new Map<string, string>()
  for (const workspace of state?.workspaces ?? []) {
    const numbers: Record<string, number> = workspace.public_pane_numbers ?? {}
    for (const tab of workspace.tabs ?? []) {
      for (const [raw, pane] of Object.entries<any>(tab.panes ?? {})) {
        const number = numbers[raw]
        if (number === undefined) continue
        const resume = pane?.agent_resume
        const session = pane?.agent_session
        const id =
          resume?.agent === "opencode" && Array.isArray(resume.argv)
            ? sessionFromArgv(resume.argv)
            : session?.agent === "opencode" && session?.kind !== "path"
              ? session.value
              : undefined
        if (typeof id === "string") sessions.set(`${workspace.id}:p${publicNumber(number)}`, id)
      }
    }
  }
  return sessions
}

const readHerdrState = (path: string): any => {
  if (!existsSync(path)) return undefined
  // The owner's data is read only as a copy.
  const scratch = mkdtempSync(join(tmpdir(), "pane-restore-"))
  try {
    const copy = join(scratch, "session.json")
    copyFileSync(path, copy)
    return JSON.parse(readFileSync(copy, "utf8"))
  } catch {
    return undefined
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export const save = (options: { machine?: string; session?: string; herdrState?: string }): { path: string; saved: Saved } => {
  const target = options.machine ? ["--machine", options.machine] : options.session ? ["--session", options.session] : []
  const herdr = (...args: string[]) => json(["herdr", ...target, ...args])
  const snapshot = herdr("api", "snapshot").result.snapshot
  // herdr's state file is on its own host; a --machine save reads only the TUIs' arguments.
  const config = join(process.env.HOME ?? "", ".config/herdr")
  const statePath =
    options.herdrState ?? (options.machine ? undefined : options.session ? join(config, "sessions", options.session, "session.json") : join(config, "session.json"))
  const recorded = statePath ? herdrStateSessions(readHerdrState(statePath)) : new Map<string, string>()

  const workspaces = new Map<string, string>((snapshot.workspaces ?? []).map((w: any) => [w.workspace_id, w.label ?? ""]))
  const tabs = new Map<string, { label: string; index: number }>()
  const seen = new Map<string, number>()
  for (const tab of snapshot.tabs ?? []) {
    const index = seen.get(tab.workspace_id) ?? 0
    seen.set(tab.workspace_id, index + 1)
    tabs.set(tab.tab_id, { label: tab.label ?? "", index })
  }

  const panes: SavedPane[] = (snapshot.panes ?? []).map((pane: any): SavedPane => {
    const tab = tabs.get(pane.tab_id) ?? { label: "", index: 0 }
    const argvs: string[][] = (herdr("pane", "process-info", "--pane", pane.pane_id).result.process_info.foreground_processes ?? []).map((p: any) => p.argv ?? [])
    const fromArgv = argvs.filter(isOpencode).map(sessionFromArgv).find((id) => id !== undefined)
    const fromState = recorded.get(pane.pane_id)
    const [session, source] =
      fromState !== undefined && SESSION_ID.test(fromState)
        ? [fromState, "herdr-state" as const]
        : fromArgv !== undefined && SESSION_ID.test(fromArgv)
          ? [fromArgv, "argv" as const]
          : [null, null]
    return {
      workspace: { id: pane.workspace_id, label: workspaces.get(pane.workspace_id) ?? "" },
      tab: { id: pane.tab_id, label: tab.label, index: tab.index },
      from: `${pane.workspace_id}/${tab.index}`,
      pane: pane.pane_id,
      cwd: pane.cwd ?? "",
      session,
      source,
    }
  })

  const host = options.machine ?? hostname().split(".")[0] ?? "host"
  const time = new Date().toISOString()
  const saved: Saved = { version: 1, host, machine: options.machine ?? null, session: options.machine ? null : (options.session ?? null), time, panes }
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${host}-${time.replace(/[:.]/g, "-")}.json`)
  writeFileSync(path, JSON.stringify(saved, null, 2) + "\n")
  return { path, saved }
}

const stateDir = () => join(process.env.XDG_STATE_HOME || join(process.env.HOME ?? "", ".local/state"), "pane-restore")

const newestSave = (machine?: string): string => {
  const host = machine ?? hostname().split(".")[0] ?? "host"
  const dir = stateDir()
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${host}-`) && f.endsWith(".json")).sort() : []
  const newest = files.at(-1)
  if (newest === undefined) throw new Error(`no save for ${host} in ${dir}: run pane-restore save`)
  return join(dir, newest)
}

const load = (path: string | undefined, machine?: string): Saved => JSON.parse(readFileSync(path ?? newestSave(machine), "utf8"))

// ── check ──

const opens = (session: string) => exec(["opencode", "api", "GET", `/api/session/${session}`]).code === 0

export const check = (saved: Saved): { lines: string[]; ok: boolean } => {
  const withSession = saved.panes.filter((p) => p.session !== null)
  const missing = withSession.filter((p) => !opens(p.session!))
  const lines = missing.map((p) => `missing ${p.session} (${p.pane}, ${p.cwd})`)
  lines.push(`${withSession.length - missing.length} of ${withSession.length} sessions open`)
  return { lines, ok: missing.length === 0 }
}

// ── restore ──

interface Terminal {
  readonly address: string
  readonly state: string
  readonly labels: Record<string, string>
  readonly foreground: { readonly name: string; readonly argv: ReadonlyArray<string> } | null
}

type Outcome = { readonly kind: "restored" | "skipped" | "failed"; readonly line: string }

export const restore = (saved: Saved): Outcome[] => {
  const terminals: Terminal[] = json(["hc", "ls", "--json"]).terminals ?? []
  return saved.panes
    .filter((p) => p.session !== null)
    .map((pane): Outcome => {
      const command = `opencode --session ${pane.session}`
      const terminal = terminals.find((t) => t.labels?.[FROM] === pane.from)
      if (terminal === undefined) return { kind: "failed", line: `failed ${pane.pane}: no hc terminal from ${pane.from} (run hcm apply first)` }
      const at = `${pane.pane} → ${terminal.address}`
      const label = terminal.labels[RESUME] ?? ""
      if (label === command) return { kind: "skipped", line: `skipped ${at}: already labelled` }
      if (label !== "") return { kind: "skipped", line: `skipped ${at}: already resumes ${label}` }
      if (terminal.state !== "live") return { kind: "failed", line: `failed ${at}: terminal finished` }
      const running = terminal.foreground?.name.replace(/^-/, "") ?? ""
      if (!SHELLS.has(running)) return { kind: "skipped", line: `skipped ${at}: runs ${running || "something unknown"}` }
      if (!opens(pane.session!)) return { kind: "failed", line: `failed ${at}: session ${pane.session} does not open through the server` }
      const result = exec(["hc", "label", terminal.address, `${RESUME}=${command}`, "--json"])
      if (result.code !== 0) return { kind: "failed", line: `failed ${at}: hc label exited ${result.code}: ${result.stderr.trim()}` }
      return { kind: "restored", line: `restored ${at}: ${RESUME}=${command}` }
    })
}

/**
 * Back into herdr itself, after a herdr restart left the panes as plain shells:
 * `herdr pane run <pane> opencode --session <id>` in each saved pane that is an
 * idle shell, on the herdr the save read. Never into a pane that runs anything.
 */
export const restoreHerdr = (saved: Saved): Outcome[] => {
  const target = saved.machine ? ["--machine", saved.machine] : saved.session ? ["--session", saved.session] : []
  const herdr = (...args: string[]) => exec(["herdr", ...target, ...args])
  const live = new Set<string>((json(["herdr", ...target, "api", "snapshot"]).result.snapshot.panes ?? []).map((p: any) => p.pane_id))
  const foreground = new Map<string, string[][]>()
  for (const pane of live) {
    const info = herdr("pane", "process-info", "--pane", pane)
    if (info.code !== 0) continue
    foreground.set(pane, (JSON.parse(info.stdout).result?.process_info?.foreground_processes ?? []).map((p: any) => p.argv ?? []))
  }
  /** The pane whose OpenCode TUI has `session` open now, from its arguments. */
  const openIn = (session: string) =>
    [...foreground].find(([, argvs]) => argvs.some((argv) => isOpencode(argv) && sessionFromArgv(argv) === session))?.[0]

  return saved.panes
    .filter((p) => p.session !== null)
    .map((pane): Outcome => {
      const session = pane.session!
      const command = `opencode --session ${session}`
      if (!live.has(pane.pane)) return { kind: "failed", line: `failed ${pane.pane}: pane not found` }
      const argvs = foreground.get(pane.pane)
      if (argvs === undefined) return { kind: "failed", line: `failed ${pane.pane}: herdr pane process-info failed` }
      const elsewhere = openIn(session)
      if (elsewhere === pane.pane) return { kind: "skipped", line: `skipped ${pane.pane}: already open` }
      const running = argvs.map((argv) => (argv[0] ?? "").split("/").at(-1)!.replace(/^-/, "")).find((name) => !SHELLS.has(name))
      if (running !== undefined || argvs.length === 0) return { kind: "skipped", line: `skipped ${pane.pane}: runs ${running ?? "nothing herdr can see"}` }
      if (elsewhere !== undefined) return { kind: "skipped", line: `skipped ${pane.pane}: already open in ${elsewhere}` }
      if (!opens(session)) return { kind: "failed", line: `failed ${pane.pane}: session ${session} does not open through the server` }
      const result = herdr("pane", "run", pane.pane, command)
      if (result.code !== 0) return { kind: "failed", line: `failed ${pane.pane}: herdr pane run exited ${result.code}: ${result.stderr.trim()}` }
      foreground.set(pane.pane, [command.split(" ")])
      return { kind: "restored", line: `restored ${pane.pane}: ${command}` }
    })
}

// ── cli ──

const main = (argv: ReadonlyArray<string>): number => {
  const [command, ...rest] = argv
  const flag = (name: string) => {
    const at = rest.indexOf(name)
    return at === -1 ? undefined : rest[at + 1]
  }
  const VALUED = new Set(["--machine", "--session", "--herdr-state"])
  const positional = rest.find((arg, i) => !arg.startsWith("--") && !VALUED.has(rest[i - 1] ?? ""))
  if (command === "save") {
    if (flag("--machine") && flag("--session")) throw new Error("--machine and --session do not combine (herdr refuses them together)")
    const { path, saved } = save({ machine: flag("--machine"), session: flag("--session"), herdrState: flag("--herdr-state") })
    const sessions = saved.panes.filter((p) => p.session !== null).length
    console.log(`${saved.panes.length} panes, ${sessions} with an OpenCode session`)
    console.log(path)
    return 0
  }
  if (command === "check") {
    const { lines, ok } = check(load(positional, flag("--machine")))
    for (const line of lines) console.log(line)
    return ok ? 0 : 1
  }
  if (command === "restore") {
    const intoHerdr = rest.includes("--herdr")
    const saved = load(positional, flag("--machine"))
    const outcomes = intoHerdr ? restoreHerdr(saved) : restore(saved)
    for (const outcome of outcomes) console.log(outcome.line)
    const count = (kind: Outcome["kind"]) => outcomes.filter((o) => o.kind === kind).length
    console.log(`${count("restored")} restored, ${count("skipped")} skipped, ${count("failed")} failed`)
    if (!intoHerdr && count("restored") > 0) console.log("next: hcm resume (after herdr has stopped)")
    return count("failed") === 0 ? 0 : 1
  }
  console.error(USAGE)
  return command === "--help" || command === "-h" ? 0 : 2
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(`pane-restore: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
