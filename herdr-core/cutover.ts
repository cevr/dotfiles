#!/usr/bin/env bun
// cutover: move this host's herdr panes into herdr-core (hc), resuming each OpenCode pane's session once.
// `hcm apply` makes the hc terminals and `hcm resume` types; this script checks, labels and verifies, and
// types nothing itself. See RUNBOOK.md for the order and README.md for the steps.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

const USAGE = `usage: cutover.ts pre [--session <herdr session>] [--snapshot <file>] [--from-live --save <pane-restore file>]
       cutover.ts labels --snapshot <saved> [--save <pane-restore file>] [--session <herdr session>]
       cutover.ts resume [--session <herdr session>]
       cutover.ts verify --snapshot <saved> [--session <herdr session>]

pre     read-only: versions, snapshot age, splits; saves hcm's plan and a copy of the snapshot in
        $XDG_STATE_HOME/herdr-core-cutover/<host>-<time>/ and prints the pane table
labels  after hcm apply, with herdr stopped: migrate.resume=opencode -s <id> on each OpenCode pane's
        fresh hc shell, project=<workspace name>, hc keep
resume  with herdr stopped: drops any migrate.resume whose terminal is no longer a fresh shell, then hcm resume
verify  read-only: one live terminal per tab, no migrate.resume left, every resumed terminal reports a
        status, no session open twice
<saved> is the folder pre printed, or the snapshot.json in it.`

/** hcm's label: the herdr tab a terminal came from, `<workspace id>/<tab index>`. */
export const FROM = "migrate.from"
/** hcm's label: the line `hcm resume` types into the terminal once, then removes. */
export const RESUME = "migrate.resume"
/** Ours: the session `labels` gave this terminal. With no `migrate.resume` beside it, the terminal was resumed. */
export const MARK = "cutover.session"
export const PROJECT = "project"
/** A session id that may be typed: OpenCode's `ses_` and the characters a shell does not read. */
export const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "nu", "tcsh"])
export const MIN = { herdr: "0.9.5", hc: "0.1.18" }

// ── the snapshot ──

/** One herdr tab (its single pane) as the cutover sees it. */
export interface Pane {
  readonly from: string
  readonly workspace: { readonly id: string; readonly name: string }
  readonly folder: string
  readonly tab: number
  readonly tabName: string
  readonly cwd: string
  /** The OpenCode session to resume, or null. */
  readonly session: string | null
  /** A session field the snapshot had that cannot be typed. */
  readonly odd: string | null
  readonly split: boolean
}

export const sessionFromArgv = (argv: ReadonlyArray<string>): string | undefined => {
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "-s" || argv[i] === "--session") return argv[i + 1]
  return argv.find((a) => a.startsWith("--session="))?.slice("--session=".length)
}

const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Every tab of a herdr session snapshot (hcm's input), in herdr's order. */
export const readSnapshot = (snapshot: any): Pane[] => {
  const workspaces = snapshot?.workspaces
  if (!Array.isArray(workspaces)) throw new Error("no workspaces in the snapshot")
  return workspaces.flatMap((ws: any) => {
    const folder = String(ws?.identity_cwd ?? "")
    return (Array.isArray(ws?.tabs) ? ws.tabs : []).map((tab: any, index: number): Pane => {
      const single = tab?.layout?.Pane
      const split = typeof single !== "number"
      const pane = split ? Object.values<any>(tab?.panes ?? {})[0] : tab?.panes?.[String(single)]
      const resume = pane?.agent_resume
      const official = pane?.agent_session
      const raw =
        resume?.agent === "opencode" && Array.isArray(resume.argv)
          ? sessionFromArgv(resume.argv)
          : official?.agent === "opencode" && official?.kind !== "path"
            ? official?.value
            : undefined
      const id = typeof raw === "string" ? raw : raw === undefined ? undefined : String(raw)
      const ok = id !== undefined && SESSION_ID.test(id)
      return {
        from: `${ws?.id}/${index}`,
        workspace: { id: String(ws?.id), name: trimmed(ws?.custom_name) },
        folder,
        tab: index,
        tabName: trimmed(tab?.custom_name),
        cwd: typeof pane?.cwd === "string" ? pane.cwd : folder,
        session: ok ? id : null,
        odd: id !== undefined && !ok ? id : null,
        split,
      }
    })
  })
}

/** pane-restore's save file (`~/.local/state/pane-restore/<host>-<time>.json`): the fields read here. */
export interface Saved {
  readonly time?: string
  readonly panes: ReadonlyArray<{ readonly from: string; readonly pane?: string; readonly session: string | null }>
}

/** The panes with each session id the save names put in place of the snapshot's, and a line per difference. */
export const withSave = (panes: ReadonlyArray<Pane>, saved: Saved | undefined): { panes: Pane[]; lines: string[] } => {
  if (saved === undefined) return { panes: [...panes], lines: [] }
  const lines: string[] = []
  const byFrom = new Map(saved.panes.filter((p) => typeof p.session === "string").map((p) => [p.from, p.session as string]))
  const out = panes.map((pane) => {
    const newer = byFrom.get(pane.from)
    if (newer === undefined || newer === pane.session) return pane
    if (!SESSION_ID.test(newer)) {
      lines.push(`save: ${pane.from} names ${JSON.stringify(newer)}, which cannot be typed; the snapshot's ${pane.session ?? "none"} stays`)
      return pane
    }
    lines.push(`save: ${pane.from} has ${newer}, the snapshot ${pane.session ?? "none"}; using the save's (it is newer)`)
    return { ...pane, session: newer, odd: null }
  })
  return { panes: out, lines }
}

/** A snapshot-shaped input (hcm's) built from herdr's live API and pane-restore's save, for a herdr that writes no snapshot. */
export const fromLive = (live: any, saved: Saved | undefined): any => {
  const sessions = new Map((saved?.panes ?? []).map((p) => [p.from, p.session]))
  const tabsOf = new Map<string, any[]>()
  for (const tab of live?.tabs ?? []) tabsOf.set(tab.workspace_id, [...(tabsOf.get(tab.workspace_id) ?? []), tab])
  const panesOf = new Map<string, any[]>()
  for (const pane of live?.panes ?? []) panesOf.set(pane.tab_id, [...(panesOf.get(pane.tab_id) ?? []), pane])
  return {
    version: 3,
    source: "cutover.ts pre --from-live",
    workspaces: (live?.workspaces ?? []).map((ws: any) => {
      const tabs = tabsOf.get(ws.workspace_id) ?? []
      const first = panesOf.get(tabs[0]?.tab_id)?.[0]
      const folder = first?.cwd ?? ""
      const base = folder.split("/").filter(Boolean).at(-1) ?? ""
      // The live API gives a label, not whether it was named: a label that is the folder's name is herdr's default.
      const label = trimmed(ws.label)
      return {
        id: ws.workspace_id,
        custom_name: label === "" || label === base ? null : label,
        identity_cwd: folder,
        tabs: tabs.map((tab, index) => {
          const panes = panesOf.get(tab.tab_id) ?? []
          const session = sessions.get(`${ws.workspace_id}/${index}`)
          const body = (pane: any) => ({
            cwd: pane?.cwd ?? folder,
            ...(typeof session === "string" ? { agent_resume: { source: "pane-restore", agent: "opencode", argv: ["opencode", "-s", session] } } : {}),
          })
          return panes.length === 1
            ? { custom_name: trimmed(tab.label) || null, layout: { Pane: 1 }, panes: { "1": body(panes[0]) } }
            : { custom_name: trimmed(tab.label) || null, layout: { Split: panes.length }, panes: Object.fromEntries(panes.map((p, i) => [String(i + 1), body(p)])) }
        }),
      }
    }),
  }
}

// ── pre ──

export const newerOrSame = (have: string | undefined, want: string): boolean => {
  const parse = (v: string) => (v.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
  if (have === undefined) return false
  const [a, b] = [parse(have), parse(want)]
  if (a.length !== 3) return false
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!
  return true
}

export interface PreFacts {
  readonly herdrVersion: string | undefined
  readonly hcVersion: string | undefined
  readonly hcm: string | undefined
  readonly snapshot: string | undefined
  readonly snapshotMs: number | undefined
  /** When the herdr server started, when it runs. */
  readonly serverStartMs: number | undefined
  readonly fromLive: boolean
  readonly now: number
  readonly panes: ReadonlyArray<Pane>
}

const age = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`)

/** pre's checks over facts already read: its lines and whether the cutover may go on. */
export const preReport = (facts: PreFacts): { lines: string[]; ok: boolean } => {
  const lines: string[] = []
  let ok = true
  const check = (pass: boolean, line: string) => {
    lines.push(`${pass ? "ok  " : "FAIL"} ${line}`)
    if (!pass) ok = false
  }
  if (facts.fromLive) lines.push(`ok   ${facts.herdrVersion ?? "herdr missing"} (--from-live reads the live API, so no snapshot-writing herdr is needed)`)
  else check(newerOrSame(facts.herdrVersion, MIN.herdr), `${facts.herdrVersion ?? "herdr missing"} (need ${MIN.herdr} or newer, which writes the snapshot)`)
  check(newerOrSame(facts.hcVersion, MIN.hc), `${facts.hcVersion ?? "hc missing"} (need ${MIN.hc} or newer)`)
  check(facts.hcm !== undefined, `hcm ${facts.hcm ?? "not on the PATH"}`)
  if (facts.snapshot === undefined || facts.snapshotMs === undefined) check(false, "no snapshot (herdr update --handoff writes one; or pre --from-live --save <file>)")
  else {
    const fresh = facts.fromLive || facts.serverStartMs === undefined || facts.snapshotMs >= facts.serverStartMs
    const server = facts.serverStartMs === undefined ? "herdr is not running" : `herdr started ${age(facts.now - facts.serverStartMs)} ago`
    check(fresh, `snapshot ${facts.snapshot}: ${age(facts.now - facts.snapshotMs)} old; ${server}${fresh ? "" : ": older than the server, so it misses this run's panes"}`)
  }
  const splits = facts.panes.filter((p) => p.split)
  check(splits.length === 0, splits.length === 0 ? "no tab has a split" : `split tabs (hcm moves one pane per tab): ${splits.map((p) => p.from).join(", ")}`)
  const odd = facts.panes.filter((p) => p.odd !== null)
  check(odd.length === 0, odd.length === 0 ? "every session id can be typed" : `session ids that cannot be typed: ${odd.map((p) => `${p.from} ${JSON.stringify(p.odd)}`).join(", ")}`)
  lines.push("", table(facts.panes))
  return { lines, ok }
}

export const table = (panes: ReadonlyArray<Pane>): string => {
  const rows = [["workspace", "tab", "folder", "resume"], ...panes.map((p) => [p.workspace.name || `(${p.folder.split("/").filter(Boolean).at(-1) ?? p.workspace.id})`, p.tabName || `tab ${p.tab + 1}`, p.cwd, p.session ?? "none"])]
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)))
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd()).join("\n")
}

// ── the hosts, behind one interface ──

/** One hc terminal, from `hc get <t> --json`. */
export interface Terminal {
  readonly address: string
  readonly state: string
  readonly labels: Readonly<Record<string, string>>
  readonly foreground: { readonly name: string; readonly argv: ReadonlyArray<string> } | null
  /** Whether its program ever reported a status (hc keeps it after the program exits). */
  readonly reported: boolean
  readonly status: unknown
  readonly keep: boolean
}

export interface Ports {
  herdrRunning(): boolean
  /** The live terminals. */
  terminals(): Terminal[]
  /** Set labels; an empty value removes one. */
  label(address: string, labels: Record<string, string>): void
  keep(address: string): void
  /** `hcm resume`: types each non-empty `migrate.resume` into its terminal once. Returns its output. */
  hcmResume(): string
}

const command = (id: string) => `opencode -s ${id}`

/** The sessions a terminal has open: its foreground OpenCode's `-s`, and hc-reporter's label. */
export const openIn = (t: Terminal): string[] => {
  const ids = new Set<string>()
  const argv = t.foreground?.argv ?? []
  const at = argv.findIndex((a) => (a.split("/").at(-1) ?? "").startsWith("opencode"))
  const fromArgv = at === -1 ? undefined : sessionFromArgv(argv.slice(at))
  if (fromArgv !== undefined) ids.add(fromArgv)
  const label = t.labels["opencode.session"]
  if (label) ids.add(label)
  return [...ids]
}

/** Why a line must not be typed into this terminal, or undefined when it is a fresh shell. */
export const unsafe = (t: Terminal): string | undefined => {
  if (t.state !== "live") return "its terminal finished"
  if (t.reported || (t.status !== null && t.status !== undefined)) return "a program reported a status there"
  if (t.foreground === null) return "its shell has not started yet (run labels again in a moment)"
  const name = (t.foreground?.name ?? "").replace(/^-/, "")
  const argv = t.foreground?.argv ?? []
  // A shell at its prompt has only flags (`zsh -l`); `sh script` is a program.
  if (!SHELLS.has(name) || argv.slice(1).some((a) => !a.startsWith("-"))) return `it runs ${argv.join(" ") || name || "something unknown"}, not its shell`
  return undefined
}

export interface Result {
  readonly lines: string[]
  readonly code: number
}

const HERDR_UP = "herdr still runs, so nothing changed: a session herdr has open would open twice. Stop herdr first (RUNBOOK.md)."

/** After `hcm apply`, with herdr stopped: the resume, project and keep labels. Safe to run again. */
export const labels = (ports: Ports, snapshotPanes: ReadonlyArray<Pane>, saved?: Saved): Result => {
  if (ports.herdrRunning()) return { lines: [`labels: ${HERDR_UP}`], code: 1 }
  const { panes, lines } = withSave(snapshotPanes, saved)
  let code = 0
  const fail = (line: string) => {
    lines.push(line)
    code = 1
  }
  const terminals = ports.terminals().filter((t) => t.state === "live")
  const byFrom = new Map<string, Terminal[]>()
  for (const t of terminals) {
    const from = t.labels[FROM]
    if (from !== undefined) byFrom.set(from, [...(byFrom.get(from) ?? []), t])
  }
  const count = (values: ReadonlyArray<string>) => values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())
  const froms = count(panes.map((p) => p.from))
  const sessions = count(panes.flatMap((p) => (p.session ? [p.session] : [])))
  const openElsewhere = new Map<string, string>()
  for (const t of terminals) for (const id of openIn(t)) openElsewhere.set(id, t.address)
  let labelled = 0
  for (const pane of panes) {
    const name = `${pane.from} (${pane.workspace.name || pane.folder}, tab ${pane.tab + 1})`
    if ((froms.get(pane.from) ?? 0) > 1) {
      fail(`refused ${name}: ${froms.get(pane.from)} tabs in the snapshot are ${pane.from}, so their terminals cannot be told apart`)
      continue
    }
    const matches = byFrom.get(pane.from) ?? []
    if (matches.length === 0) {
      fail(`failed ${name}: no live hc terminal from ${pane.from} (run hcm apply first)`)
      continue
    }
    if (matches.length > 1) {
      fail(`refused ${name}: ${matches.length} hc terminals are from ${pane.from} (${matches.map((t) => t.address).join(", ")}); kill the extra ones`)
      continue
    }
    const t = matches[0]!
    const want: Record<string, string> = {}
    if (pane.workspace.name !== "" && t.labels[PROJECT] !== pane.workspace.name) want[PROJECT] = pane.workspace.name
    if (!t.keep) ports.keep(t.address)
    if (pane.odd !== null) fail(`refused ${name}: session id ${JSON.stringify(pane.odd)} cannot be typed`)
    else if (pane.session !== null) {
      const id = pane.session
      const at = `${name} → ${t.address}`
      const pending = t.labels[RESUME] ?? ""
      const mark = t.labels[MARK]
      const why = unsafe(t)
      const open = openElsewhere.get(id)
      if ((sessions.get(id) ?? 0) > 1) fail(`refused ${at}: ${sessions.get(id)} panes name ${id}; resume it by hand in one of them`)
      else if (mark === id && pending === command(id)) lines.push(`skipped ${at}: already labelled`)
      else if (mark !== undefined && pending === "") {
        if (mark === id && why === undefined) fail(`skipped ${at}: ${id} was typed there once and never reported a status (was the OpenCode service up?); open it there by hand`)
        else if (mark === id) lines.push(`skipped ${at}: already resumed ${id}`)
        else fail(`skipped ${at}: it resumed ${mark}, and the newest record says ${id}; open ${id} there by hand`)
      } else if (pending !== "" && mark === undefined) lines.push(`skipped ${at}: already resumes ${pending}`)
      else if (open !== undefined && open !== t.address) fail(`refused ${at}: ${id} is open in ${open} already`)
      else if (why !== undefined) fail(`skipped ${at}: ${why}; open ${id} there by hand`)
      else {
        want[RESUME] = command(id)
        want[MARK] = id
        labelled++
        lines.push(`labelled ${at}: ${RESUME}=${command(id)}`)
      }
    }
    if (Object.keys(want).length > 0) ports.label(t.address, want)
  }
  lines.push(`${labelled} labelled; ${code === 0 ? "next: start the OpenCode service, then cutover.ts resume" : "fix the lines above, then run labels again"}`)
  return { lines, code }
}

/** With herdr stopped: drop every `migrate.resume` that is no longer safe to type, then `hcm resume`. */
export const resume = (ports: Ports): Result => {
  if (ports.herdrRunning()) return { lines: [`resume: ${HERDR_UP}`], code: 1 }
  const lines: string[] = []
  const terminals = ports.terminals().filter((t) => t.state === "live")
  const open = new Map<string, string>()
  for (const t of terminals) for (const id of openIn(t)) open.set(id, t.address)
  const queued = new Map<string, string>()
  for (const t of terminals) {
    const pending = t.labels[RESUME] ?? ""
    if (pending === "") continue
    const id = sessionFromArgv(pending.split(" "))
    const why =
      unsafe(t) ??
      (id !== undefined && open.has(id) && open.get(id) !== t.address ? `${id} is open in ${open.get(id)}` : undefined) ??
      (id !== undefined && queued.has(id) ? `${queued.get(id)} resumes ${id} too` : undefined)
    if (why !== undefined) {
      ports.label(t.address, { [RESUME]: "", ...(t.labels[MARK] !== undefined ? { [MARK]: "" } : {}) })
      lines.push(`unlabelled ${t.address}: ${why}; ${RESUME} was ${pending}`)
    } else if (id !== undefined) queued.set(id, t.address)
  }
  lines.push(ports.hcmResume().trimEnd())
  return { lines, code: 0 }
}

/** Read-only: every snapshot tab accounted for in hc. */
export const verify = (ports: Ports, panes: ReadonlyArray<Pane>): Result => {
  const lines: string[] = []
  const problems: string[] = []
  if (ports.herdrRunning()) problems.push("herdr: still running")
  const terminals = ports.terminals().filter((t) => t.state === "live")
  for (const pane of panes) {
    const n = terminals.filter((t) => t.labels[FROM] === pane.from).length
    if (n !== 1) problems.push(`terminals: ${pane.from} (${pane.workspace.name || pane.folder}) has ${n} live hc terminals`)
  }
  const pending = terminals.filter((t) => (t.labels[RESUME] ?? "") !== "")
  for (const t of pending) problems.push(`labels: ${t.address} still waits to type ${t.labels[RESUME]}`)
  const silent = terminals.filter((t) => t.labels[MARK] !== undefined && (t.labels[RESUME] ?? "") === "" && !t.reported && (t.status === null || t.status === undefined))
  for (const t of silent) problems.push(`status: ${t.address} (${t.labels[MARK]}) has reported no status`)
  const where = new Map<string, string[]>()
  for (const t of terminals) for (const id of openIn(t)) where.set(id, [...(where.get(id) ?? []), t.address])
  for (const [id, at] of where) if (at.length > 1) problems.push(`sessions: ${id} is open in ${at.join(" and ")}`)
  for (const group of ["herdr", "terminals", "labels", "status", "sessions"]) {
    const mine = problems.filter((p) => p.startsWith(`${group}:`))
    lines.push(...(mine.length === 0 ? [`ok   ${group}`] : mine.map((p) => `FAIL ${p}`)))
  }
  return { lines, code: problems.length === 0 ? 0 : 1 }
}

/**
 * Ports whose terminal list waits (up to `ms`) for every shell `hcm apply` made to have a foreground: a login
 * shell takes a moment to start, and until then hc names no foreground.
 */
export const settling = (ports: Ports, ms = 15_000): Ports => ({
  ...ports,
  terminals: () => {
    const deadline = Date.now() + ms
    for (;;) {
      const list = ports.terminals()
      const starting = list.some((t) => t.state === "live" && t.labels[FROM] !== undefined && t.foreground === null)
      if (!starting || Date.now() >= deadline) return list
      Bun.sleepSync(250)
    }
  },
})

// ── the real hosts ──

const exec = (argv: ReadonlyArray<string>, inherit = false) => {
  const which = Bun.which(argv[0]!)
  if (which === null) return { code: 127, stdout: "", stderr: `${argv[0]}: not on the PATH` }
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: inherit ? "inherit" : "pipe" })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr?.toString() ?? "" }
}

const json = (argv: ReadonlyArray<string>): any => {
  const result = exec(argv)
  if (result.code !== 0) throw new Error(`${argv.join(" ")} exited ${result.code}: ${result.stderr.trim()}`)
  return JSON.parse(result.stdout)
}

const herdrArgs = (session: string | undefined) => (session ? ["herdr", "--session", session] : ["herdr"])

export const realPorts = (session: string | undefined): Ports => ({
  herdrRunning: () => {
    const result = exec([...herdrArgs(session), "status", "server", "--json"])
    if (result.code === 127) return false
    if (result.code !== 0) throw new Error(`herdr status server exited ${result.code}: ${result.stderr.trim()}`)
    return JSON.parse(result.stdout).running === true
  },
  terminals: () =>
    (json(["hc", "ls", "--json"]).terminals ?? []).map((row: any): Terminal => {
      const t = json(["hc", "get", row.address, "--json"])
      return {
        address: t.address,
        state: t.state,
        labels: t.labels ?? {},
        foreground: t.foreground ? { name: String(t.foreground.name ?? ""), argv: t.foreground.argv ?? [] } : null,
        reported: t.reported === true,
        status: t.status ?? null,
        keep: t.keep === true,
      }
    }),
  label: (address, labels) => {
    json(["hc", "label", address, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`), "--json"])
  },
  keep: (address) => {
    json(["hc", "keep", address, "--json"])
  },
  hcmResume: () => {
    const result = exec(["hcm", "resume"], true)
    if (result.code !== 0) throw new Error(`hcm resume exited ${result.code}`)
    return result.stdout
  },
})

const stateDir = () => join(process.env.XDG_STATE_HOME || join(process.env.HOME ?? "", ".local/state"), "herdr-core-cutover")
const host = () => hostname().split(".")[0] || "host"

const newestSnapshot = (session: string | undefined): string | undefined => {
  const config = join(process.env.HOME ?? "", ".config/herdr")
  const dir = session ? join(config, "sessions", session, "session-snapshots") : join(config, "session-snapshots")
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ path: join(dir, f), ms: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.ms - b.ms)
  return files.at(-1)?.path
}

const savedSnapshot = (path: string) => (existsSync(join(path, "snapshot.json")) ? join(path, "snapshot.json") : path)
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"))

const pre = (flag: (name: string) => string | undefined, has: (name: string) => boolean): Result => {
  const session = flag("--session")
  const version = (argv: string[]) => {
    const result = exec(argv)
    return result.code === 0 ? result.stdout.trim() : undefined
  }
  const status = (() => {
    try {
      return json([...herdrArgs(session), "status", "server", "--json"])
    } catch {
      return undefined
    }
  })()
  const socket = status?.running ? status.socket : undefined
  const serverStartMs = socket && existsSync(socket) ? (statSync(socket).birthtimeMs || statSync(socket).mtimeMs) : undefined
  const time = new Date().toISOString().replace(/[:.]/g, "-")
  const out = join(stateDir(), `${host()}-${time}`)
  mkdirSync(out, { recursive: true })
  const target = join(out, "snapshot.json")
  const fromLiveFlag = has("--from-live")
  let source: string | undefined
  if (fromLiveFlag) {
    const savePath = flag("--save")
    if (savePath === undefined) throw new Error("--from-live needs --save <pane-restore file>: the live API names no sessions")
    const live = json([...herdrArgs(session), "api", "snapshot"]).result.snapshot
    writeFileSync(target, JSON.stringify(fromLive(live, readJson(savePath)), null, 2) + "\n")
    source = `${target} (from herdr's live API and ${savePath})`
  } else {
    const found = flag("--snapshot") ?? newestSnapshot(session)
    if (found !== undefined) {
      copyFileSync(found, target)
      source = found
    }
  }
  const panes = source === undefined ? [] : readSnapshot(readJson(target))
  const plan = source === undefined ? undefined : exec(["hcm", "plan", "--snapshot", target])
  if (plan !== undefined) writeFileSync(join(out, "hcm-plan.txt"), plan.stdout + plan.stderr)
  const report = preReport({
    herdrVersion: version([...herdrArgs(undefined), "--version"]),
    hcVersion: version(["hc", "--version"]),
    hcm: Bun.which("hcm") ?? undefined,
    snapshot: source,
    snapshotMs: source === undefined ? undefined : fromLiveFlag ? Date.now() : statSync(flag("--snapshot") ?? source).mtimeMs,
    serverStartMs,
    fromLive: fromLiveFlag,
    now: Date.now(),
    panes,
  })
  const lines = [...report.lines]
  if (plan !== undefined && plan.code !== 0) lines.push(`FAIL hcm plan exited ${plan.code}: ${plan.stderr.trim()}`)
  lines.push("", `saved: ${out}`)
  return { lines, code: report.ok && (plan?.code ?? 1) === 0 ? 0 : 1 }
}

const main = (argv: ReadonlyArray<string>): number => {
  const [step, ...rest] = argv
  const flag = (name: string) => {
    const at = rest.indexOf(name)
    return at === -1 ? undefined : rest[at + 1]
  }
  const has = (name: string) => rest.includes(name)
  const print = (result: Result) => {
    for (const line of result.lines) console.log(line)
    return result.code
  }
  const snapshot = () => {
    const path = flag("--snapshot")
    if (path === undefined) throw new Error(`${step} needs --snapshot <saved>: the folder pre printed`)
    return readSnapshot(readJson(savedSnapshot(path)))
  }
  const session = flag("--session")
  switch (step) {
    case "pre":
      return print(pre(flag, has))
    case "labels": {
      const save = flag("--save")
      return print(labels(settling(realPorts(session)), snapshot(), save === undefined ? undefined : readJson(save)))
    }
    case "resume":
      return print(resume(settling(realPorts(session))))
    case "verify":
      return print(verify(realPorts(session), snapshot()))
    default:
      console.error(USAGE)
      return step === "--help" || step === "-h" ? 0 : 2
  }
}

/** The steps `bun herdr-core/cutover.ts <step>` takes. */
export const STEPS = ["pre", "labels", "resume", "verify"] as const

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(`cutover: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
