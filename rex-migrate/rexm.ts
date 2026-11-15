#!/usr/bin/env bun
// rexm: make Rex sessions from herdr-core (hc) spaces, as hcm made hc spaces from herdr workspaces.
// Each hc space becomes a Rex session, each hc tab a Rex tab (window) with a fresh shell per hc terminal,
// in that terminal's folder. Running programs cannot move; `resume` types each OpenCode terminal's
// `opencode -s <id>` into its new Rex shell once, and only after the hc copy stopped. See README.md.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const USAGE = `usage: rexm [plan|apply|resume|verify] [-S <rex server>]

Make Rex sessions from herdr-core (hc) spaces. Running programs cannot move; each
hc terminal gets a new shell in its folder, and each OpenCode terminal's session
is typed into its new shell once, by resume.

  plan    print the Rex session per hc space and the Rex tab per hc tab that apply
          makes, and which terminals run OpenCode (the default; changes nothing)
  apply   make them on the Rex server; a rerun adds only what is new, and a space
          whose Rex session exists gets the new tabs. Changes nothing in hc
  resume  type \`opencode -s <id>\` into each OpenCode tab's new Rex shell, once;
          refused for a session whose hc copy still runs
  verify  read-only: one Rex tab per hc tab, no resume pending, no session open twice

-S, REX_SERVER  the Rex server (a host label or an address); default the local one
HC_SESSION      the hc session, as for hc itself
State: $XDG_STATE_HOME/rexm/<hc core>-<rex server>.json (what moved, what was typed).`

/** An OpenCode session id that may be typed: `ses_` and characters a shell does not read. */
export const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "nu", "tcsh", "login"])
/** The key of a tab's shell when the hc tab holds no terminal of this machine. */
export const NO_TERMINAL = "-"

// ── hc, as read ──

export interface Foreground {
  readonly name: string
  /** The command line, or null when it cannot be read (Rex gives only the program's name). */
  readonly argv: ReadonlyArray<string> | null
}

export interface HcTerminal {
  readonly address: string
  readonly cwd: string
  readonly labels: Readonly<Record<string, string>>
  readonly foreground: Foreground | null
  readonly status: unknown
  /** The terminal's title, which names a bare OpenCode TUI's session to a person. */
  readonly title?: string
}

export interface HcTab {
  readonly id: string
  readonly name: string
  /** The terminal addresses in the tab's layout, in order. */
  readonly terminals: ReadonlyArray<string>
}

export interface HcSpace {
  readonly id: string
  readonly name: string
  readonly folder: string
  readonly tabs: ReadonlyArray<HcTab>
}

export interface HcView {
  readonly spaces: ReadonlyArray<HcSpace>
  /** The live terminals of this machine (no `machine/` prefix). */
  readonly terminals: ReadonlyArray<HcTerminal>
}

/** The terminal addresses of a herdr-app doc layout node, in order. */
const terminalsOf = (node: any): string[] => {
  if (node === null || typeof node !== "object") return []
  const own = typeof node.content?.terminal === "string" ? [node.content.terminal as string] : []
  const children = Array.isArray(node.children) ? node.children.flatMap(terminalsOf) : []
  return [...own, ...children]
}

/** The spaces of the herdr-app doc (`{spaces: [{id, name, folder, tabs: [{id, name, root}]}]}`). */
export const readDoc = (doc: any): HcSpace[] =>
  (Array.isArray(doc?.spaces) ? doc.spaces : []).map((space: any) => ({
    id: String(space?.id ?? ""),
    name: typeof space?.name === "string" ? space.name.trim() : "",
    folder: String(space?.folder ?? ""),
    tabs: (Array.isArray(space?.tabs) ? space.tabs : []).map((tab: any) => ({
      id: String(tab?.id ?? ""),
      name: typeof tab?.name === "string" ? tab.name.trim() : "",
      terminals: terminalsOf(tab?.root),
    })),
  }))

const text = (fg: Foreground | null) => (fg === null ? "" : [fg.name, ...(fg.argv ?? [])].join(" "))

/** The OpenCode sessions named on a command line: `-s <id>`, `--session <id>`, `--session=<id>`, quoted or not. */
export const sessionsIn = (line: string): string[] => {
  if (!/opencode/.test(line)) return []
  const ids = new Set<string>()
  for (const m of line.matchAll(/(?:^|[\s'"])(?:-s|--session)(?:['"]?\s+['"]?|=['"]?)(ses_[A-Za-z0-9_-]+)/g)) ids.add(m[1]!)
  return [...ids]
}

/** The sessions an hc terminal has open now: its foreground's command line and the reporter's label. */
export const openIn = (t: HcTerminal): string[] => {
  const ids = new Set(sessionsIn(text(t.foreground)))
  const label = t.labels["opencode.session"]
  if (label && SESSION_ID.test(label)) ids.add(label)
  return [...ids]
}

/** A shell at its prompt: a shell's name, and only flags after it. */
export const isShell = (fg: Foreground | null): boolean => {
  if (fg === null) return false
  const name = (fg.name.split("/").at(-1) ?? "").replace(/^-/, "")
  if (!SHELLS.has(name) || name === "login") return false
  const words = (fg.argv ?? []).flatMap((a) => a.split(/\s+/)).filter(Boolean)
  return words.slice(1).every((w) => w.startsWith("-"))
}

/** Whether the terminal's program is OpenCode (by its command line or the status it reported). */
export const runsOpenCode = (t: HcTerminal): boolean =>
  t.foreground !== null && !isShell(t.foreground) && (/opencode/.test(text(t.foreground)) || (t.status as any)?.app === "opencode")

/** The OpenCode session this terminal stands for: open now, else waiting in hcm's or cutover's labels. */
export const sessionOf = (t: HcTerminal): string | null => {
  const open = openIn(t)
  if (open.length > 0) return open[0]!
  const waiting = sessionsIn(`opencode ${t.labels["migrate.resume"] ?? ""}`)[0]
  if (waiting !== undefined) return waiting
  const mark = t.labels["cutover.session"]
  return mark && SESSION_ID.test(mark) ? mark : null
}

// ── the plan ──

export interface PlannedTerminal {
  /** The hc terminal's address, or NO_TERMINAL for an hc tab with none here. */
  readonly key: string
  readonly cwd: string
  readonly opencode: boolean
  readonly session: string | null
  /** Another hc terminal names the same session, so neither is resumed. */
  readonly shared: boolean
  readonly title: string
}

export interface PlannedTab {
  readonly id: string
  readonly label: string
  readonly terminals: ReadonlyArray<PlannedTerminal>
}

export interface PlannedSpace {
  readonly id: string
  /** The Rex session's label: the space's name, else its folder's; unique in the plan. */
  readonly label: string
  readonly folder: string
  readonly tabs: ReadonlyArray<PlannedTab>
}

export interface Plan {
  readonly spaces: ReadonlyArray<PlannedSpace>
  /** Lines about what does not move. */
  readonly notes: ReadonlyArray<string>
}

const base = (folder: string) => folder.split("/").filter(Boolean).at(-1) ?? folder

export const plan = (view: HcView, isDir: (path: string) => boolean = () => true): Plan => {
  const notes: string[] = []
  const live = new Map(view.terminals.map((t) => [t.address, t]))
  const sessions = new Map<string, number>()
  for (const space of view.spaces)
    for (const tab of space.tabs)
      for (const address of tab.terminals) {
        const t = live.get(address)
        const id = t === undefined ? null : sessionOf(t)
        if (id !== null) sessions.set(id, (sessions.get(id) ?? 0) + 1)
      }
  const used = new Map<string, number>()
  const placed = new Set<string>()
  const spaces = view.spaces.map((space): PlannedSpace => {
    const want = space.name || base(space.folder) || space.id
    const n = (used.get(want.toLowerCase()) ?? 0) + 1
    used.set(want.toLowerCase(), n)
    const label = n === 1 ? want : `${want} ${n}`
    const tabs = space.tabs.map((tab): PlannedTab => {
      const here = tab.terminals.filter((a) => !a.includes("/"))
      for (const a of tab.terminals.filter((a) => a.includes("/"))) notes.push(`${a} (${label}): on another machine, not moved; run rexm there`)
      const terminals = here.map((address): PlannedTerminal => {
        placed.add(address)
        const t = live.get(address)
        const cwd = t !== undefined && t.cwd !== "" && isDir(t.cwd) ? t.cwd : space.folder
        const session = t === undefined ? null : sessionOf(t)
        if (t === undefined) notes.push(`${address} (${label}): not live in hc; its Rex tab gets a shell in ${space.folder}`)
        return {
          key: address,
          cwd,
          opencode: t !== undefined && (runsOpenCode(t) || session !== null),
          session,
          shared: session !== null && (sessions.get(session) ?? 0) > 1,
          title: t?.title ?? "",
        }
      })
      return {
        id: tab.id,
        label: tab.name,
        terminals: terminals.length > 0 ? terminals : [{ key: NO_TERMINAL, cwd: space.folder, opencode: false, session: null, shared: false, title: "" }],
      }
    })
    return { id: space.id, label, folder: space.folder, tabs }
  })
  for (const t of view.terminals) if (!placed.has(t.address)) notes.push(`${t.address} (${t.cwd}): in no hc space, not moved`)
  for (const [id, n] of sessions) if (n > 1) notes.push(`${id}: named by ${n} hc terminals, so none is resumed; open it by hand in one`)
  return { spaces, notes }
}

// ── Rex, behind one interface ──

export interface RexWindow {
  readonly id: string
  readonly label: string
  readonly blocks: ReadonlyArray<string>
}

export interface RexSession {
  readonly id: string
  readonly label: string
  readonly windows: ReadonlyArray<RexWindow>
}

export interface Rex {
  /** The server's endpoint, which names the state file. */
  endpoint(): Promise<string>
  sessions(): Promise<RexSession[]>
  newSession(label: string, cwd: string, window: string): Promise<{ session: string; window: string; block: string }>
  newWindow(session: string, label: string, cwd: string): Promise<{ window: string; block: string }>
  split(session: string, window: string, anchor: string, cwd: string): Promise<{ block: string }>
  /** The block's foreground program, or null while it has none. */
  foreground(session: string, block: string): Promise<Foreground | null>
  /** Type the text into the block, as keys. */
  type(session: string, block: string, text: string): Promise<void>
}

export interface Hc {
  view(): Promise<HcView>
}

// ── what moved: the state file ──

export interface Resume {
  readonly session: string
  readonly block: string
  readonly from: string
  readonly tab: string
  readonly state: "pending" | "typed" | "failed"
  readonly note?: string
}

export interface State {
  readonly version: 1
  /** hc space id → the Rex session made (or adopted) for it. */
  readonly spaces: Record<string, { readonly session: string }>
  /** hc tab id → its Rex window and the block per hc terminal (or NO_TERMINAL). */
  readonly tabs: Record<string, { readonly session: string; readonly window: string; readonly blocks: Record<string, string> }>
  /** OpenCode session id → where it is to be typed, and whether it was. */
  readonly resumes: Record<string, Resume>
}

export const emptyState = (): State => ({ version: 1, spaces: {}, tabs: {}, resumes: {} })

export interface Store {
  load(): State
  save(state: State): void
}

export interface Result {
  readonly lines: string[]
  readonly code: number
}

/** The resume line: the OpenCode command (REXM_OPENCODE, else `opencode`) and the session. */
export const command = (id: string, opencode = "opencode") => `${opencode} -s ${id}`

const short = (id: string) => `…${id.slice(-6)}`

interface Live {
  readonly sessions: Map<string, RexSession>
  readonly windows: Map<string, { session: string; blocks: Set<string> }>
  readonly blocks: Map<string, string>
}

const index = (sessions: ReadonlyArray<RexSession>): Live => {
  const live: Live = { sessions: new Map(), windows: new Map(), blocks: new Map() }
  for (const s of sessions) {
    live.sessions.set(s.id, s)
    for (const w of s.windows) {
      live.windows.set(w.id, { session: s.id, blocks: new Set(w.blocks) })
      for (const b of w.blocks) live.blocks.set(b, s.id)
    }
  }
  return live
}

/**
 * plan (dry) and apply share this walk: for each planned space, its Rex session (recorded, else the one
 * Rex session with its label, else new); for each tab, its window; for each terminal, its block. Only what
 * is missing is made, and the state is saved after each thing made, so a rerun adds only what is new.
 */
export const reconcile = async (planned: Plan, rex: Rex | null, store: Store, dry: boolean): Promise<Result> => {
  const lines: string[] = []
  let code = 0
  const state = store.load()
  const spaces = { ...state.spaces }
  const tabs = { ...state.tabs }
  const resumes = { ...state.resumes }
  const save = () => {
    if (!dry) store.save({ version: 1, spaces, tabs, resumes })
  }
  let live: Live
  try {
    live = index(rex === null ? [] : await rex.sessions())
  } catch (error) {
    if (!dry) throw error
    lines.push(`Rex: ${error instanceof Error ? error.message : String(error)}; showing everything as new`)
    live = index([])
  }
  let made = 0
  let fake = 0
  const fresh = (kind: string) => `(new ${kind} ${++fake})`
  /** Record the resume for an OpenCode terminal's block; returns what changed, for the line. */
  const record = (t: PlannedTerminal, session: string, block: string, tab: string): string => {
    // A pending resume whose Rex shell was closed follows its terminal to the new shell, even after the hc
    // copy stopped (and hc no longer names the session).
    let moved = ""
    for (const [other, r] of Object.entries(resumes))
      if (r.state === "pending" && r.from === t.key && r.tab === tab && r.block !== block && !live.blocks.has(r.block)) {
        resumes[other] = { ...r, session, block }
        moved = `; resume will type ${command(other)} here (its old Rex shell is gone)`
      }
    if (moved !== "") return moved
    const id = t.session
    if (id === null || t.shared || !SESSION_ID.test(id)) return ""
    const had = resumes[id]
    if (had?.block === block) return ""
    if (had === undefined || (had.state === "pending" && !live.blocks.has(had.block))) {
      let note = ""
      // The terminal moved on to another session since: its old pending line is dropped, not typed too.
      for (const [other, r] of Object.entries(resumes))
        if (r.block === block && r.state === "pending") {
          delete resumes[other]
          note = ` (in place of ${other})`
        }
      if (Object.values(resumes).some((r) => r.block === block)) return `; ${id} not recorded: ${short(block)} had a session typed already, open ${id} by hand`
      resumes[id] = { session, block, from: t.key, tab, state: "pending" }
      return `; resume will type ${command(id)}${note}`
    }
    return had.state === "pending" ? `; ${id} waits in ${short(had.block)} already` : `; ${id} was typed in ${short(had.block)} already`
  }
  const taken = new Set(Object.values(spaces).map((s) => s.session))
  for (const space of planned.spaces) {
    let session: string | undefined = spaces[space.id]?.session
    let how = "exists"
    if (session === undefined || !live.sessions.has(session)) {
      const named = [...live.sessions.values()].filter((s) => s.label === space.label && !taken.has(s.id))
      session = named.length === 1 ? named[0]!.id : undefined
      how = named.length === 1 ? "exists, adopted by its label" : "new"
      if (session !== undefined) {
        spaces[space.id] = { session }
        taken.add(session)
        save()
      }
    }
    lines.push(`session "${space.label}" (${session === undefined ? "new" : `${how} ${short(session)}`}) from space ${space.id} in ${space.folder}`)
    for (const tab of space.tabs) {
      const had = tabs[tab.id]
      let window = had !== undefined && had.session === session && live.windows.get(had.window)?.session === session ? had.window : undefined
      const blocks: Record<string, string> = window === undefined ? {} : { ...had!.blocks }
      const inWindow = window === undefined ? new Set<string>() : live.windows.get(window)!.blocks
      const todo = tab.terminals.filter((t) => !(blocks[t.key] !== undefined && inWindow.has(blocks[t.key]!)))
      const name = tab.label === "" ? `${space.tabs.indexOf(tab) + 1}` : `"${tab.label}"`
      const unknown = (t: PlannedTerminal) => `session unknown${t.title ? ` (${JSON.stringify(t.title)})` : ""}: open it by hand`
      const describe = (t: PlannedTerminal) =>
        `${t.key === NO_TERMINAL ? "a shell" : t.key} in ${t.cwd}${t.opencode ? ` [opencode ${t.session ?? unknown(t)}${t.shared ? ", shared: not resumed" : ""}]` : ""}`
      const moved = tab.terminals.filter((t) => !todo.includes(t))
      for (const t of moved) {
        const note = record(t, session!, blocks[t.key]!, tab.id)
        if (note !== "") save()
        lines.push(`  tab ${name}: ${t.key} moved already${note}`)
      }
      for (const t of todo) {
        let block: string
        if (dry) {
          if (session === undefined) session = fresh("session")
          if (window === undefined) window = fresh("window")
          block = fresh("block")
        } else {
          try {
            if (session === undefined) {
              const got = await rex!.newSession(space.label, t.cwd, tab.label)
              session = got.session
              window = got.window
              block = got.block
              spaces[space.id] = { session }
            } else if (window === undefined) {
              const got = await rex!.newWindow(session, tab.label, t.cwd)
              window = got.window
              block = got.block
            } else {
              const anchor = Object.values(blocks).find((b) => inWindow.has(b)) ?? live.windows.get(window)?.blocks.values().next().value ?? Object.values(blocks)[0]!
              block = (await rex!.split(session, window, anchor, t.cwd)).block
            }
          } catch (error) {
            lines.push(`  failed ${name} ${describe(t)}: ${error instanceof Error ? error.message : String(error)}`)
            code = 1
            break
          }
          made++
        }
        blocks[t.key] = block
        inWindow.add(block)
        live.blocks.set(block, session!)
        tabs[tab.id] = { session: session!, window: window!, blocks }
        const resumeNote = record(t, session!, block, tab.id)
        save()
        lines.push(`  ${dry ? "would add" : "added"} tab ${name}: ${describe(t)}${resumeNote}`)
      }
    }
  }
  lines.push(...planned.notes.map((n) => `note: ${n}`))
  const pending = Object.values(resumes).filter((r) => r.state === "pending").length
  lines.push(dry ? `plan: ${planned.spaces.length} spaces; apply makes what says "would add"` : `${made} made; ${pending} resume(s) pending${pending > 0 ? ": quit those sessions in hc, then rexm resume" : ""}`)
  return { lines, code }
}

const fg = (f: Foreground | null) => (f === null ? "nothing yet" : f.argv?.join(" ") || f.name)

/** The sessions each Rex block has open, by its foreground's command line, when it can be read. */
const rexOpen = async (rex: Rex, live: Live, skip: string): Promise<Map<string, string>> => {
  const open = new Map<string, string>()
  for (const [block, session] of live.blocks) {
    if (block === skip) continue
    for (const id of sessionsIn(text(await rex.foreground(session, block)))) open.set(id, block)
  }
  return open
}

/** Type each pending resume once, only where its hc copy stopped and its Rex block is a fresh shell. */
export const resume = async (hc: Hc, rex: Rex, store: Store, opencode = "opencode", settleMs = 15_000): Promise<Result> => {
  const lines: string[] = []
  let code = 0
  const state = store.load()
  const resumes = { ...state.resumes }
  const view = await hc.view()
  const live = index(await rex.sessions())
  const openHc = new Map<string, string[]>()
  for (const t of view.terminals) for (const id of openIn(t)) openHc.set(id, [...(openHc.get(id) ?? []), t.address])
  let typed = 0
  for (const [id, r] of Object.entries(state.resumes)) {
    if (r.state !== "pending") continue
    const at = `${id} → ${short(r.block)}`
    const refuse = (why: string) => {
      lines.push(`refused ${at}: ${why}`)
      code = 1
    }
    if (!SESSION_ID.test(id)) {
      refuse("the id cannot be typed")
      continue
    }
    if (!live.blocks.has(r.block)) {
      refuse("its Rex shell is gone; run rexm apply again")
      continue
    }
    const inHc = openHc.get(id)
    if (inHc !== undefined) {
      refuse(`still open in hc ${inHc.join(", ")}; quit it there first`)
      continue
    }
    const origin = view.terminals.find((t) => t.address === r.from)
    if (origin !== undefined && (origin.foreground === null || runsOpenCode(origin))) {
      refuse(`hc ${origin.address} still runs ${fg(origin.foreground)}; quit it there first`)
      continue
    }
    let here = await rex.foreground(r.session, r.block)
    for (let waited = 0; !isShell(here) && (here === null || here.name.replace(/^-/, "") === "login") && waited < settleMs; waited += 250) {
      await Bun.sleep(250)
      here = await rex.foreground(r.session, r.block)
    }
    if (!isShell(here)) {
      refuse(`its Rex shell runs ${fg(here)}, not its shell; open ${id} there by hand`)
      continue
    }
    const elsewhere = (await rexOpen(rex, live, r.block)).get(id)
    if (elsewhere !== undefined) {
      refuse(`open in Rex ${short(elsewhere)} already`)
      continue
    }
    // At most once: the record says typed before the keys go, so a crash between never types it twice.
    resumes[id] = { ...r, state: "typed" }
    store.save({ ...state, resumes })
    try {
      await rex.type(r.session, r.block, `${command(id, opencode)}\r`)
      typed++
      lines.push(`typed ${at}: ${command(id, opencode)}`)
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error)
      resumes[id] = { ...r, state: "failed", note }
      store.save({ ...state, resumes })
      refuse(`typing failed (${note}); open ${id} there by hand`)
    }
  }
  lines.push(`${typed} typed${code === 0 ? "" : "; fix the refused lines, then run resume again"}`)
  return { lines, code }
}

/** Read-only: one Rex tab per hc tab, no resume pending, no session open twice. */
export const verify = async (hc: Hc, rex: Rex, store: Store): Promise<Result> => {
  const problems: string[] = []
  const state = store.load()
  const view = await hc.view()
  const planned = plan(view)
  const live = index(await rex.sessions())
  for (const space of planned.spaces)
    for (const tab of space.tabs) {
      const record = state.tabs[tab.id]
      const window = record === undefined ? undefined : live.windows.get(record.window)
      const name = `${space.label} / ${tab.label || `tab ${space.tabs.indexOf(tab) + 1}`}`
      if (record === undefined || window === undefined) {
        problems.push(`tabs: ${name} has no Rex tab`)
        continue
      }
      for (const t of tab.terminals) if (!window.blocks.has(record.blocks[t.key] ?? "")) problems.push(`tabs: ${name}: ${t.key} has no Rex shell`)
    }
  for (const [id, r] of Object.entries(state.resumes)) {
    if (r.state === "pending") problems.push(`resumes: ${id} still waits to be typed into ${short(r.block)}`)
    if (r.state === "failed") problems.push(`resumes: typing ${id} into ${short(r.block)} failed (${r.note ?? "?"}); open it there by hand`)
  }
  const where = new Map<string, string[]>()
  for (const t of view.terminals) for (const id of openIn(t)) where.set(id, [...(where.get(id) ?? []), `hc ${t.address}`])
  for (const [block, session] of live.blocks)
    for (const id of sessionsIn(text(await rex.foreground(session, block)))) where.set(id, [...(where.get(id) ?? []), `Rex ${short(block)}`])
  for (const [id, at] of where) if (at.length > 1) problems.push(`sessions: ${id} is open in ${at.join(" and ")}`)
  const lines: string[] = []
  for (const group of ["tabs", "resumes", "sessions"]) {
    const mine = problems.filter((p) => p.startsWith(`${group}:`))
    lines.push(...(mine.length === 0 ? [`ok   ${group}`] : mine.map((p) => `FAIL ${p}`)))
  }
  return { lines, code: problems.length === 0 ? 0 : 1 }
}

// ── the real hosts ──

const decode = (bytes: Uint8Array | undefined) => (bytes === undefined ? "" : new TextDecoder().decode(bytes))

const exec = (argv: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  return { code: result.exitCode, stdout: decode(result.stdout), stderr: decode(result.stderr) }
}

const json = (argv: ReadonlyArray<string>): any => {
  const result = exec(argv)
  if (result.code !== 0) throw new Error(`${argv.join(" ")} exited ${result.code}: ${result.stderr.trim()}`)
  return JSON.parse(result.stdout)
}

/** One request over `hc connect` (JSON-RPC, one message per line). */
const hcCall = async (method: string, params: Record<string, unknown>, ms = 10_000): Promise<any> => {
  const proc = Bun.spawn(["hc", "connect"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), ms)
  try {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`)
    proc.stdin.flush()
    const reader = proc.stdout.getReader()
    let buffer = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`hc connect ended before answering ${method}: ${(await new Response(proc.stderr).text()).trim()}`)
      buffer += new TextDecoder().decode(value)
      for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (line.trim() === "") continue
        const message = JSON.parse(line)
        if (message.id !== 1) continue
        if (message.error) throw new Error(`hc ${method}: ${message.error.message ?? JSON.stringify(message.error)}`)
        return message.result
      }
    }
  } finally {
    clearTimeout(timer)
    proc.stdin.end()
    proc.kill()
  }
}

export const realHc = (): Hc => ({
  view: async () => {
    if (Bun.which("hc") === null) throw new Error("hc is not on the PATH")
    const doc = await hcCall("doc.get", { name: "herdr-app" })
    const listed = (json(["hc", "ls", "--json"]).terminals ?? []).filter((row: any) => !String(row.address).includes("/") && row.state === "live")
    const terminals = listed.map((row: any): HcTerminal => {
      const t = json(["hc", "get", row.address, "--json"])
      return {
        address: String(t.address),
        cwd: String(t.cwd ?? row.cwd ?? ""),
        labels: t.labels ?? {},
        foreground: t.foreground ? { name: String(t.foreground.name ?? ""), argv: Array.isArray(t.foreground.argv) ? t.foreground.argv.map(String) : [] } : null,
        status: t.status ?? null,
        title: typeof t.title === "string" ? t.title : "",
      }
    })
    return { spaces: readDoc(doc?.value), terminals }
  },
})

/** The rex CLI: REXM_REX, else `rex` on the PATH, else the one inside the Mac app. */
export const rexBinary = (): string | undefined => {
  const named = process.env.REXM_REX
  if (named) return named
  const onPath = Bun.which("rex")
  if (onPath !== null) return onPath
  const mac = "/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"
  return existsSync(mac) ? mac : undefined
}

export const realRex = (server: string | undefined): Rex => {
  const bin = rexBinary()
  // Never start a server: a rex call with none running would start one with the owner's state.
  const rex = (...args: string[]) => {
    if (bin === undefined) throw new Error("rex is not on the PATH (or set REXM_REX)")
    return [bin, "--autostart=false", ...(server ? ["-S", server] : []), ...args]
  }
  let endpoint: string | undefined
  const local = async () => (endpoint ?? (await self.endpoint())).startsWith("unix://")
  const self: Rex = {
    endpoint: async () => (endpoint ??= String(json(rex("server", "status", "--json")).endpoint ?? server ?? "default")),
    sessions: async () =>
      (json(rex("ls", "--json")).sessions ?? []).map((s: any): RexSession => {
        const view = json(rex("window", "ls", "-s", s.session_id, "--json"))
        return {
          id: String(s.session_id),
          label: String(s.label ?? ""),
          windows: (view.windows ?? []).map((w: any) => ({
            id: String(w.window_id),
            label: String(w.label ?? ""),
            blocks: (w.layers ?? []).flatMap((l: any) => (l.blocks ?? []).map((b: any) => String(b.block_id))),
          })),
        }
      }),
    newSession: async (label, cwd, window) => {
      const got = json(rex("new", label, "--cwd", cwd, ...(window ? ["--window", window] : []), "--json"))
      const first = got.initial_windows?.[0]
      return { session: String(got.session_id), window: String(first?.window_id), block: String(first?.block_ids?.[0]) }
    },
    newWindow: async (session, label, cwd) => {
      const got = json(rex("window", "new", "-s", session, ...(label ? [label] : []), "--cwd", cwd, "--focus=false", "--json"))
      return { window: String(got.window_id), block: String(got.block_ids?.[0]) }
    },
    split: async (session, window, anchor, cwd) => {
      const got = json(rex("split", "-s", session, "-w", window, "-b", anchor, "--cwd", cwd, "--focus=false", "--json"))
      return { block: String(got.block_ids?.[0]) }
    },
    foreground: async (session, block) => {
      const result = exec(rex("block", "call", "-s", session, "-b", block, "process"))
      if (result.code !== 0) return null
      const f = JSON.parse(result.stdout).foreground
      if (!f) return null
      // Rex gives only argv0; on this machine ps gives the rest.
      let argv: string[] | null = null
      if (typeof f.pid === "number" && (await local())) {
        const ps = exec(["ps", "-o", "args=", "-p", String(f.pid)])
        if (ps.code === 0 && ps.stdout.trim() !== "") argv = [ps.stdout.trim()]
      }
      return { name: String(f.argv0 ?? f.name ?? ""), argv: argv ?? (f.argv0 ? [String(f.argv0)] : null) }
    },
    type: async (session, block, data) => {
      json(rex("block", "call", "-s", session, "-b", block, "write", JSON.stringify({ data })))
    },
  }
  return self
}

export const fileStore = (path: string): Store => ({
  load: () => (existsSync(path) ? { ...emptyState(), ...JSON.parse(readFileSync(path, "utf8")) } : emptyState()),
  save: (state) => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(tmp, path)
  },
})

const stateDir = () => process.env.REXM_STATE_DIR || join(process.env.XDG_STATE_HOME || join(process.env.HOME ?? "", ".local/state"), "rexm")

/** The state file for this hc core and Rex server. */
export const statePath = (hcCore: string, endpoint: string) =>
  join(stateDir(), `${hcCore.replace(/[^A-Za-z0-9_-]/g, "_")}-${createHash("sha256").update(endpoint).digest("hex").slice(0, 12)}.json`)

const hcCore = () => {
  const status = json(["hc", "server", "status", "--json"])
  return `${process.env.HC_SESSION || "default"}-${String(status.core?.id ?? "core")}`
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  const rest = [...argv]
  let server: string | undefined
  const at = rest.findIndex((a) => a === "-S" || a === "--server")
  if (at !== -1) {
    server = rest[at + 1]
    rest.splice(at, 2)
  }
  const step = rest[0] ?? "plan"
  if (step === "--help" || step === "-h" || step === "help") {
    console.log(USAGE)
    return 0
  }
  if (!["plan", "apply", "resume", "verify"].includes(step) || rest.length > 1) {
    console.error(USAGE)
    return 2
  }
  const print = (result: Result) => {
    for (const line of result.lines) console.log(line)
    return result.code
  }
  const hc = realHc()
  const rex = realRex(server)
  const opencode = process.env.REXM_OPENCODE || "opencode"
  const store = async () => fileStore(statePath(hcCore(), await rex.endpoint()))
  switch (step) {
    case "plan": {
      const view = await hc.view()
      let target: Store
      let reachable: Rex | null = rex
      try {
        target = await store()
      } catch {
        reachable = null
        target = { load: emptyState, save: () => {} }
      }
      return print(await reconcile(plan(view, isDir), reachable, target, true))
    }
    case "apply":
      return print(await reconcile(plan(await hc.view(), isDir), rex, await store(), false))
    case "resume":
      return print(await resume(hc, rex, await store(), opencode))
    case "verify":
      return print(await verify(hc, rex, await store()))
  }
  return 2
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (error) {
    console.error(`rexm: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
