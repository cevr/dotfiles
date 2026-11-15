// rexm against generated hc layouts and an in-memory Rex (1), its parts (2) and a scratch Rex server with a
// scratch hc core (3). Nothing here reaches the owner's hc session or Rex server.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  NO_TERMINAL,
  emptyState,
  isShell,
  openIn,
  plan,
  readDoc,
  reconcile,
  resume,
  rexBinary,
  sessionsIn,
  verify,
  type Foreground,
  type Hc,
  type HcSpace,
  type HcTerminal,
  type HcView,
  type Rex,
  type RexSession,
  type State,
  type Store,
} from "./rexm.ts"

// ── fakes ──

const SHELL: Foreground = { name: "-zsh", argv: ["-zsh"] }

interface Block {
  fg: Foreground | null
}

/** An in-memory Rex: sessions of windows of blocks, each block's foreground, and a log of what was typed. */
class FakeRex implements Rex {
  sessionsById = new Map<string, { label: string; windows: Map<string, { label: string; blocks: Map<string, Block> }> }>()
  typed: Array<{ block: string; text: string }> = []
  made = 0
  serial = 0
  /** Foreground reads that answer null first (a shell still starting). */
  starting = new Map<string, number>()
  failType = false
  id(kind: string) {
    return `${kind}:${(++this.serial).toString(16).padStart(8, "0")}`
  }
  async endpoint() {
    return "unix:///fake"
  }
  async sessions(): Promise<RexSession[]> {
    return [...this.sessionsById].map(([id, s]) => ({ id, label: s.label, windows: [...s.windows].map(([wid, w]) => ({ id: wid, label: w.label, blocks: [...w.blocks.keys()] })) }))
  }
  private block() {
    this.made++
    const id = this.id("block")
    return { id, block: { fg: SHELL } as Block }
  }
  async newSession(label: string, _cwd: string, window: string) {
    const session = this.id("session")
    const wid = this.id("window")
    const { id, block } = this.block()
    this.sessionsById.set(session, { label, windows: new Map([[wid, { label: window, blocks: new Map([[id, block]]) }]]) })
    return { session, window: wid, block: id }
  }
  async newWindow(session: string, label: string) {
    const s = this.sessionsById.get(session)
    if (s === undefined) throw new Error(`no session ${session}`)
    const wid = this.id("window")
    const { id, block } = this.block()
    s.windows.set(wid, { label, blocks: new Map([[id, block]]) })
    return { window: wid, block: id }
  }
  async split(session: string, window: string, anchor: string) {
    const w = this.sessionsById.get(session)?.windows.get(window)
    if (w === undefined || !w.blocks.has(anchor)) throw new Error(`no anchor ${anchor} in ${window}`)
    const { id, block } = this.block()
    w.blocks.set(id, block)
    return { block: id }
  }
  find(block: string): Block | undefined {
    for (const s of this.sessionsById.values()) for (const w of s.windows.values()) if (w.blocks.has(block)) return w.blocks.get(block)
    return undefined
  }
  async foreground(_session: string, block: string) {
    const left = this.starting.get(block) ?? 0
    if (left > 0) {
      this.starting.set(block, left - 1)
      return null
    }
    return this.find(block)?.fg ?? null
  }
  async type(_session: string, block: string, text: string) {
    if (this.failType) throw new Error("the server went away")
    const b = this.find(block)
    if (b === undefined) throw new Error(`no block ${block}`)
    if (!isShell(b.fg)) throw new Error(`typed into ${block} while it runs ${b.fg?.name}`)
    this.typed.push({ block, text })
    const m = text.match(/^(\S+) -s (ses_[A-Za-z0-9_-]+)\r$/)
    if (m) b.fg = { name: "opencode", argv: [`${m[1]} -s ${m[2]}`] }
  }
  /** Every place a session is open in Rex. */
  open(): Map<string, number> {
    const n = new Map<string, number>()
    for (const s of this.sessionsById.values())
      for (const w of s.windows.values()) for (const b of w.blocks.values()) for (const id of sessionsIn([b.fg?.name, ...(b.fg?.argv ?? [])].join(" "))) n.set(id, (n.get(id) ?? 0) + 1)
    return n
  }
  allBlocks(): Array<[string, Block]> {
    return [...this.sessionsById.values()].flatMap((s) => [...s.windows.values()].flatMap((w) => [...w.blocks]))
  }
}

class FakeHc implements Hc {
  constructor(public spaces: HcSpace[], public terminals: HcTerminal[]) {}
  async view(): Promise<HcView> {
    return structuredClone({ spaces: this.spaces, terminals: this.terminals })
  }
}

const memoryStore = (): Store & { raw: () => string } => {
  let saved = JSON.stringify(emptyState())
  return { load: () => JSON.parse(saved) as State, save: (s) => void (saved = JSON.stringify(s)), raw: () => saved }
}

const shellTerminal = (address: string, cwd: string): HcTerminal => ({ address, cwd, labels: {}, foreground: { name: "zsh", argv: ["/bin/zsh", "-l"] }, status: null })
/** An OpenCode TUI as the dotfiles' handoff starts it: `sh -c` around `exec '<opencode>' '-s' '<id>'`. */
const opencodeTerminal = (address: string, cwd: string, id: string | null): HcTerminal => ({
  address,
  cwd,
  labels: {},
  foreground:
    id === null
      ? { name: "opencode-2.3.0-prime.x", argv: ["/Users/u/.local/share/opencode-prime/opencode-2.3.0-prime.x"] }
      : { name: "bash", argv: ["/bin/sh", "-c", `slot='/x/43043.next'\n(\nexec '/Users/u/.local/share/opencode-prime/opencode-2.3.0-prime.x' '-s' '${id}'\n)\nstatus=$?`] },
  status: { app: "opencode", state: "idle" },
})

// ── generators ──

type Rng = () => number
const rng = (seed: number): Rng => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
const pick = <T,>(r: Rng, xs: ReadonlyArray<T>): T => xs[int(r, 0, xs.length - 1)]!

interface World {
  hc: FakeHc
  rex: FakeRex
  store: ReturnType<typeof memoryStore>
  next: () => string
  freshId: () => string
}

const world = (r: Rng): World => {
  let t = 0
  let s = 0
  let tabSerial = 0
  const next = () => `t${++t}`
  const freshId = () => `ses_${pick(r, ["a", "B9", "x_y", "q-r"])}${(++s).toString(36)}`
  const folders = ["/w/api", "/w/api", "/w/notes", "/home/u", "/w/a b"]
  const names = ["", "", "api", "notes", "api"]
  const terminals: HcTerminal[] = []
  const ids: string[] = []
  const spaces: HcSpace[] = Array.from({ length: int(r, 1, 5) }, (_, i) => {
    const folder = pick(r, folders)
    return {
      id: `sp${i}`,
      name: pick(r, names),
      folder,
      tabs: Array.from({ length: int(r, 1, 4) }, () => ({
        id: `tb${++tabSerial}`,
        name: pick(r, ["", "", "server", "Dataflare"]),
        terminals: Array.from({ length: int(r, 0, 3) }, () => {
          const roll = r()
          if (roll < 0.08) return `workbox/t${int(r, 1, 9)}`
          const address = next()
          if (roll < 0.15) return address // not live
          let term: HcTerminal
          if (roll < 0.55) term = shellTerminal(address, folder)
          else if (roll < 0.62) term = opencodeTerminal(address, folder, null)
          else {
            // Now and then two terminals name one session.
            const id = ids.length > 0 && r() < 0.1 ? pick(r, ids) : freshId()
            ids.push(id)
            term = opencodeTerminal(address, folder, id)
          }
          terminals.push(term)
          return address
        }),
      })),
    }
  })
  // A terminal in no space.
  if (r() < 0.3) terminals.push(shellTerminal(next(), "/tmp"))
  const rex = new FakeRex()
  // The owner's own Rex session with a planned label, which apply adopts.
  if (r() < 0.3) void rex.newSession(pick(r, ["api", "notes", "u"]), "/", "mine")
  rex.made = 0
  return { hc: new FakeHc(spaces, terminals), rex, store: memoryStore(), next, freshId }
}

const hcOpen = (hc: FakeHc) => {
  const n = new Map<string, number>()
  for (const t of hc.terminals) for (const id of openIn(t)) n.set(id, (n.get(id) ?? 0) + 1)
  return n
}

/** Quit the OpenCode TUI that has `id` open in hc: its terminal is a shell again (hc keep). */
const stopInHc = (hc: FakeHc, id: string) => {
  hc.terminals = hc.terminals.map((t) => (openIn(t).includes(id) ? { ...t, foreground: { name: "zsh", argv: ["/bin/zsh", "-l"] }, status: null } : t))
}

const COMMANDS = ["apply", "apply", "resume", "resume", "stop", "stop", "addTab", "addSplit", "closeWindow", "busy", "idle", "quitRex", "verify", "plan", "failType"] as const

interface Stats {
  quit: number
  typed: number
  refusedOpen: number
  adopted: number
  closedTyped: number
  splits: number
}

/** One generated run; returns what it saw. Throws on any broken invariant. */
const run = async (seed: number, steps: number, stats: Stats) => {
  const r = rng(seed)
  const w = world(r)
  const typedIds = new Set<string>()
  const closedTyped = new Set<string>()
  const check = (what: string) => {
    const inRex = w.rex.open()
    const inHc = hcOpen(w.hc)
    for (const [id, n] of inRex) {
      if (n > 1) throw new Error(`seed ${seed} after ${what}: ${id} open ${n} times in Rex`)
      if ((inHc.get(id) ?? 0) > 0) throw new Error(`seed ${seed} after ${what}: ${id} open in hc and in Rex`)
    }
    const counts = new Map<string, number>()
    for (const t of w.rex.typed) for (const id of sessionsIn(`opencode ${t.text}`)) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const [id, n] of counts) if (n > 1) throw new Error(`seed ${seed} after ${what}: ${id} typed ${n} times`)
  }
  for (let i = 0; i < steps; i++) {
    const cmd = pick(r, COMMANDS)
    switch (cmd) {
      case "apply": {
        const result = await reconcile(plan(await w.hc.view()), w.rex, w.store, false)
        if (result.lines.some((l) => l.includes("adopted"))) stats.adopted++
        // Idempotent: a second apply right away makes nothing and records nothing.
        const after = w.rex.made
        const saved = w.store.raw()
        await reconcile(plan(await w.hc.view()), w.rex, w.store, false)
        if (w.rex.made !== after) throw new Error(`seed ${seed}: a second apply made ${w.rex.made - after} more`)
        if (w.store.raw() !== saved) throw new Error(`seed ${seed}: a second apply changed the state`)
        // One Rex window per planned tab, each holding a block per planned terminal.
        const state = w.store.load()
        const sessions = await w.rex.sessions()
        const windows = new Map(sessions.flatMap((s) => s.windows.map((win) => [win.id, { session: s.id, blocks: new Set(win.blocks) }] as const)))
        for (const space of plan(await w.hc.view()).spaces)
          for (const tab of space.tabs) {
            const rec = state.tabs[tab.id]
            if (rec === undefined || !windows.has(rec.window)) throw new Error(`seed ${seed}: tab ${tab.id} has no window after apply`)
            for (const t of tab.terminals) if (!windows.get(rec.window)!.blocks.has(rec.blocks[t.key]!)) throw new Error(`seed ${seed}: ${t.key} has no block`)
          }
        const used = Object.values(state.tabs).map((t) => t.window)
        if (new Set(used).size !== used.length) throw new Error(`seed ${seed}: two hc tabs share a Rex window`)
        break
      }
      case "plan": {
        const saved = w.store.raw()
        const made = w.rex.made
        await reconcile(plan(await w.hc.view()), w.rex, w.store, true)
        if (w.store.raw() !== saved || w.rex.made !== made) throw new Error(`seed ${seed}: plan changed something`)
        break
      }
      case "resume": {
        const before = w.rex.typed.length
        const result = await resume(w.hc, w.rex, w.store, "opencode", 0)
        stats.typed += w.rex.typed.length - before
        stats.refusedOpen += result.lines.filter((l) => l.includes("still open in hc")).length
        for (const t of w.rex.typed.slice(before)) for (const id of sessionsIn(`opencode ${t.text}`)) typedIds.add(id)
        break
      }
      case "stop": {
        const open = [...hcOpen(w.hc).keys()]
        if (open.length > 0) stopInHc(w.hc, pick(r, open))
        break
      }
      case "addTab": {
        const space = pick(r, w.hc.spaces)
        const address = w.next()
        const term = r() < 0.5 ? opencodeTerminal(address, space.folder, w.freshId()) : shellTerminal(address, space.folder)
        w.hc.terminals.push(term)
        w.hc.spaces = w.hc.spaces.map((s) => (s === space ? { ...s, tabs: [...s.tabs, { id: `tb-new-${address}`, name: "", terminals: [address] }] } : s))
        break
      }
      case "addSplit": {
        const space = pick(r, w.hc.spaces)
        const tab = pick(r, space.tabs)
        const address = w.next()
        w.hc.terminals.push(r() < 0.5 ? opencodeTerminal(address, space.folder, w.freshId()) : shellTerminal(address, space.folder))
        w.hc.spaces = w.hc.spaces.map((s) => (s === space ? { ...s, tabs: s.tabs.map((t) => (t === tab ? { ...t, terminals: [...t.terminals, address] } : t)) } : s))
        stats.splits++
        break
      }
      case "closeWindow": {
        const all = [...w.rex.sessionsById.values()].flatMap((s) => [...s.windows.keys()].map((wid) => ({ s, wid })))
        if (all.length === 0) break
        const { s, wid } = pick(r, all)
        for (const b of s.windows.get(wid)!.blocks.values()) for (const id of sessionsIn([b.fg?.name, ...(b.fg?.argv ?? [])].join(" "))) closedTyped.add(id)
        s.windows.delete(wid)
        if (s.windows.size === 0) for (const [k, v] of w.rex.sessionsById) if (v === s) w.rex.sessionsById.delete(k)
        break
      }
      case "busy": {
        const shells = w.rex.allBlocks().filter(([, b]) => isShell(b.fg))
        if (shells.length > 0) pick(r, shells)[1].fg = { name: "vim", argv: ["vim notes.md"] }
        break
      }
      case "idle": {
        for (const [, b] of w.rex.allBlocks()) if (b.fg?.name === "vim") b.fg = SHELL
        break
      }
      case "quitRex": {
        // The owner quits a resumed TUI in Rex: its shell is back, and nothing may type the session again.
        const tuis = w.rex.allBlocks().filter(([, b]) => b.fg?.name === "opencode")
        if (tuis.length > 0) {
          const [, b] = pick(r, tuis)
          for (const id of sessionsIn(`opencode ${b.fg?.argv?.join(" ")}`)) closedTyped.add(id)
          b.fg = SHELL
          stats.quit++
        }
        break
      }
      case "verify": {
        const saved = w.store.raw()
        const made = w.rex.made
        const typed = w.rex.typed.length
        await verify(w.hc, w.rex, w.store)
        if (w.store.raw() !== saved || w.rex.made !== made || w.rex.typed.length !== typed) throw new Error(`seed ${seed}: verify changed something`)
        break
      }
      case "failType": {
        // The server drops one typing: the record says failed, and it is never typed again.
        w.rex.failType = true
        const before = w.rex.typed.length
        await resume(w.hc, w.rex, w.store, "opencode", 0)
        w.rex.failType = false
        if (w.rex.typed.length !== before) throw new Error(`seed ${seed}: typed while failing`)
        break
      }
    }
    check(cmd)
  }
  // The happy end: programs in Rex quit, apply, every hc copy stops, resume, verify.
  for (const [, b] of w.rex.allBlocks()) if (b.fg?.name === "vim") b.fg = SHELL
  await reconcile(plan(await w.hc.view()), w.rex, w.store, false)
  const shared = new Set([...hcOpen(w.hc)].filter(([, n]) => n > 1).map(([id]) => id))
  const want = [...hcOpen(w.hc).keys()].filter((id) => !shared.has(id) && !typedIds.has(id))
  for (const id of hcOpen(w.hc).keys()) stopInHc(w.hc, id)
  const before = w.rex.typed.length
  const last = await resume(w.hc, w.rex, w.store, "opencode", 0)
  if (process.env.REXM_DEBUG) console.log(seed, last.lines)
  stats.typed += w.rex.typed.length - before
  check("the final resume")
  const inRex = w.rex.open()
  const failed = new Set(Object.entries(w.store.load().resumes).filter(([, x]) => x.state === "failed").map(([id]) => id))
  for (const id of want) if (!failed.has(id) && inRex.get(id) !== 1) throw new Error(`seed ${seed}: ${id} was open in hc before the cutover and is not open in Rex after it`)
  stats.closedTyped += closedTyped.size
  const v = await verify(w.hc, w.rex, w.store)
  const failures = v.lines.filter((l) => l.startsWith("FAIL"))
  // Only a typing the fake server dropped may be left: verify names it.
  for (const line of failures) if (!line.includes("failed")) throw new Error(`seed ${seed}: verify after the cutover: ${line}`)
  if ((failed.size === 0) !== (v.code === 0)) throw new Error(`seed ${seed}: verify code ${v.code} with ${failed.size} failed`)
}

// ── 1. model-based ──

describe("model-based: generated hc layouts and command sequences", () => {
  test("400 runs of 30 commands: one Rex tab per hc tab, at most once per session, never open twice", async () => {
    const stats: Stats = { quit: 0, typed: 0, refusedOpen: 0, adopted: 0, closedTyped: 0, splits: 0 }
    for (let seed = 1; seed <= 400; seed++) await run(seed, 30, stats)
    // The runs reach the states that matter.
    expect(stats.typed).toBeGreaterThan(200)
    expect(stats.refusedOpen).toBeGreaterThan(50)
    expect(stats.adopted).toBeGreaterThan(10)
    expect(stats.closedTyped).toBeGreaterThan(5)
    expect(stats.splits).toBeGreaterThan(50)
    expect(stats.quit).toBeGreaterThan(20)
  })
})

// ── 2. the parts ──

const DOC = {
  spaces: [
    {
      id: "sp1",
      name: "manna - films",
      folder: "/w/manna",
      tabs: [{ id: "tb1", name: "Workbox continuation", root: { type: "row", id: "tb1", children: [{ type: "block", id: "p1", content: { terminal: "t1" } }] } }],
    },
    {
      id: "sp2",
      name: "",
      folder: "/w/manna",
      tabs: [
        {
          id: "tb2",
          name: "",
          root: { type: "row", id: "tb2", children: [{ type: "block", id: "p2", content: { terminal: "t2" } }, { type: "column", id: "c", children: [{ type: "block", id: "p3", content: { terminal: "t3" } }, { type: "block", id: "p4", content: { mod: "x" } }] }] },
        },
        { id: "tb3", name: "notes", root: { type: "row", id: "tb3", children: [{ type: "block", id: "p5", content: { mod: "notes" } }] } },
      ],
    },
    { id: "sp3", name: "", folder: "/w/manna", tabs: [{ id: "tb4", name: "", root: { type: "row", id: "tb4", children: [{ type: "block", id: "p6", content: { terminal: "workbox/t1" } }] } }] },
  ],
}

describe("the parts", () => {
  test("the herdr-app doc: spaces, tabs and the terminals of a split layout, in order", () => {
    const spaces = readDoc(DOC)
    expect(spaces.map((s) => s.tabs.map((t) => t.terminals))).toEqual([[["t1"]], [["t2", "t3"], []], [["workbox/t1"]]])
    expect(readDoc(null)).toEqual([])
  })

  test("plan: unique session labels, a shell for a tab with no terminal, remote and loose terminals named", () => {
    const view: HcView = {
      spaces: readDoc(DOC),
      terminals: [shellTerminal("t1", "/w/manna"), opencodeTerminal("t2", "/w/manna/sub", "ses_A1"), { ...opencodeTerminal("t3", "/gone", null), title: "OC | slides" }, shellTerminal("t9", "/tmp")],
    }
    const p = plan(view, (path) => path !== "/gone")
    expect(p.spaces.map((s) => s.label)).toEqual(["manna - films", "manna", "manna 2"])
    expect(p.spaces[1]!.tabs[0]!.terminals.map((t) => [t.key, t.cwd, t.session, t.opencode])).toEqual([
      ["t2", "/w/manna/sub", "ses_A1", true],
      ["t3", "/w/manna", null, true],
    ])
    expect(p.spaces[1]!.tabs[1]!.terminals.map((t) => t.key)).toEqual([NO_TERMINAL])
    expect(p.notes.join("\n")).toContain("workbox/t1 (manna 2): on another machine")
    expect(p.notes.join("\n")).toContain("t9 (/tmp): in no hc space")
  })

  test("sessions come from the TUI's arguments, the handoff's sh -c script, and hc-reporter's label", () => {
    expect(sessionsIn("opencode -s ses_a")).toEqual(["ses_a"])
    expect(sessionsIn("/x/opencode --session=ses_b")).toEqual(["ses_b"])
    expect(sessionsIn("/bin/sh -c exec '/x/opencode-2.3.0' '-s' 'ses_c'\n exec '/x/opencode-2.2' '-s' 'ses_c'")).toEqual(["ses_c"])
    expect(sessionsIn("claude --resume ses_d -s ses_d")).toEqual([])
    expect(openIn({ ...shellTerminal("t1", "/"), labels: { "opencode.session": "ses_e" } })).toEqual(["ses_e"])
  })

  test("a shell at its prompt is a shell; a shell running a script, or login still starting, is not", () => {
    expect(isShell({ name: "-zsh", argv: ["-zsh"] })).toBe(true)
    expect(isShell({ name: "zsh", argv: ["/bin/zsh -l"] })).toBe(true)
    expect(isShell({ name: "bash", argv: ["/bin/sh", "-c", "exec x"] })).toBe(false)
    expect(isShell({ name: "login", argv: ["login -pf u"] })).toBe(false)
    expect(isShell(null)).toBe(false)
  })

  const single = () => {
    const hc = new FakeHc(
      [{ id: "sp", name: "api", folder: "/w/api", tabs: [{ id: "tb", name: "", terminals: ["t1", "t2"] }] }],
      [opencodeTerminal("t1", "/w/api", "ses_one"), shellTerminal("t2", "/w/api")],
    )
    return { hc, rex: new FakeRex(), store: memoryStore() }
  }

  test("resume refuses while the hc copy runs, and says where; after it stops, types once", async () => {
    const { hc, rex, store } = single()
    const applied = await reconcile(plan(await hc.view()), rex, store, false)
    expect(applied.lines.join("\n")).toContain("resume will type opencode -s ses_one")
    const early = await resume(hc, rex, store, "opencode", 0)
    expect(early.code).toBe(1)
    expect(early.lines[0]).toContain("still open in hc t1; quit it there first")
    expect(rex.typed).toEqual([])
    stopInHc(hc, "ses_one")
    const late = await resume(hc, rex, store, "/opt/oc", 0)
    expect(late.code).toBe(0)
    expect(rex.typed.map((t) => t.text)).toEqual(["/opt/oc -s ses_one\r"])
    expect((await resume(hc, rex, store, "opencode", 0)).lines).toEqual(["0 typed"])
    expect((await verify(hc, rex, store)).code).toBe(0)
  })

  test("resume waits for a starting shell, and refuses a shell that runs a program", async () => {
    const { hc, rex, store } = single()
    await reconcile(plan(await hc.view()), rex, store, false)
    stopInHc(hc, "ses_one")
    const block = store.load().resumes.ses_one!.block
    rex.find(block)!.fg = { name: "vim", argv: ["vim"] }
    const busy = await resume(hc, rex, store, "opencode", 0)
    expect(busy.lines[0]).toContain("its Rex shell runs vim")
    rex.find(block)!.fg = SHELL
    rex.starting.set(block, 3)
    expect((await resume(hc, rex, store, "opencode", 2_000)).code).toBe(0)
    expect(rex.typed.length).toBe(1)
  })

  test("a session already open in another Rex block is refused", async () => {
    const { hc, rex, store } = single()
    await reconcile(plan(await hc.view()), rex, store, false)
    stopInHc(hc, "ses_one")
    const other = await rex.newSession("mine", "/", "")
    rex.find(other.block)!.fg = { name: "opencode", argv: ["opencode -s ses_one"] }
    const result = await resume(hc, rex, store, "opencode", 0)
    expect(result.lines[0]).toContain("open in Rex")
    expect(rex.typed).toEqual([])
    expect((await verify(hc, rex, store)).lines).toContain("FAIL resumes: ses_one still waits to be typed into …" + store.load().resumes.ses_one!.block.slice(-6))
  })

  test("a terminal that moved on to another session before resume: the new one replaces the old", async () => {
    const { hc, rex, store } = single()
    await reconcile(plan(await hc.view()), rex, store, false)
    hc.terminals = hc.terminals.map((t) => (t.address === "t1" ? opencodeTerminal("t1", "/w/api", "ses_two") : t))
    const again = await reconcile(plan(await hc.view()), rex, store, false)
    expect(again.lines.join("\n")).toContain("resume will type opencode -s ses_two (in place of ses_one)")
    expect(Object.keys(store.load().resumes)).toEqual(["ses_two"])
  })

  test("a space whose Rex session exists gets only the new tabs; a closed Rex tab comes back", async () => {
    const { hc, rex, store } = single()
    await reconcile(plan(await hc.view()), rex, store, false)
    expect(rex.made).toBe(2)
    hc.terminals.push(shellTerminal("t3", "/w/api"))
    hc.spaces = [{ ...hc.spaces[0]!, tabs: [...hc.spaces[0]!.tabs, { id: "tb2", name: "logs", terminals: ["t3"] }] }]
    const more = await reconcile(plan(await hc.view()), rex, store, false)
    expect(rex.made).toBe(3)
    expect(more.lines.join("\n")).toContain('added tab "logs": t3 in /w/api')
    const [session] = [...rex.sessionsById.values()]
    expect([...session!.windows.values()].map((w) => w.label)).toEqual(["", "logs"])
    session!.windows.delete(store.load().tabs.tb2!.window)
    await reconcile(plan(await hc.view()), rex, store, false)
    expect(rex.made).toBe(4)
    expect(rex.sessionsById.size).toBe(1)
  })

  test("plan changes nothing and works with no Rex server", async () => {
    const { hc, store } = single()
    const result = await reconcile(plan(await hc.view()), null, store, true)
    expect(result.lines.join("\n")).toContain('session "api" (new)')
    expect(result.lines.join("\n")).toContain("would add tab 1: t1 in /w/api [opencode ses_one]")
    expect(store.raw()).toBe(JSON.stringify(emptyState()))
  })
})

// ── 3. scratch drive: a scratch Rex server and a scratch hc core ──

const rexBin = rexBinary()
const missing = [...(Bun.which("hc") === null ? ["hc"] : []), ...(rexBin === undefined ? ["rex"] : [])]
if (missing.length > 0) console.log(`scratch drive skipped: ${missing.join(" and ")} not found`)

describe.skipIf(missing.length > 0)("scratch drive: rexm on a scratch Rex server from a scratch hc core", () => {
  const root = join(tmpdir(), `rexm-${process.pid}`)
  // Socket paths must stay under 104 bytes.
  const runtime = `/tmp/rxm${process.pid}`
  const socket = `unix://${runtime}/rex.sock`
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HC_") && !k.startsWith("REX_") && !k.startsWith("REXM_")) as [string, string][])
  Object.assign(env, {
    HC_SESSION: `rxm${process.pid}`,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: runtime,
    REX_SERVER: socket,
    REXM_REX: rexBin ?? "rex",
    REXM_OPENCODE: join(root, "bin/opencode"),
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
  })
  const run = (argv: string[], timeout = 30_000) => {
    const result = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe", timeout })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const rexm = (...args: string[]) => run(["bun", join(import.meta.dir, "rexm.ts"), ...args])
  const rex = (...args: string[]) => run([rexBin!, "--autostart=false", "-S", socket, ...args])
  let server: ReturnType<typeof Bun.spawn> | undefined
  let hcStarted = false
  const cleanup = () => {
    if (hcStarted) run(["hc", "server", "stop", "--json"])
    hcStarted = false
    if (server !== undefined) {
      // The server runs in its own process group; end the group (its shells too).
      try {
        process.kill(-server.pid, "SIGTERM")
      } catch {}
      server = undefined
    }
    rmSync(root, { recursive: true, force: true })
    rmSync(runtime, { recursive: true, force: true })
  }
  afterAll(cleanup)
  const until = async (what: string, done: () => boolean, ms = 20_000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (done()) return
      await Bun.sleep(200)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const hcCall = async (method: string, params: unknown) => {
    const proc = Bun.spawn(["hc", "connect"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`)
    proc.stdin.flush()
    const reader = proc.stdout.getReader()
    let buffer = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`hc connect ended: ${await new Response(proc.stderr).text()}`)
        buffer += new TextDecoder().decode(value)
        const line = buffer.split("\n").find((l) => l.includes('"id":1'))
        if (line !== undefined) return JSON.parse(line)
      }
    } finally {
      proc.stdin.end()
      proc.kill()
    }
  }

  test(
    "plan, apply twice, resume refused then typed once, verify; the owner's hc and Rex untouched",
    async () => {
      const ownerHc = JSON.parse(Bun.spawnSync(["hc", "server", "status", "--json"], { stdout: "pipe", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "HC_SESSION")) as Record<string, string> }).stdout.toString() || "{}").pid
      for (const dir of ["home", "config", "state", "data", "cache", "bin", "rex-state", "w/api", "w/notes"]) mkdirSync(join(root, dir), { recursive: true })
      mkdirSync(runtime, { recursive: true })
      const log = join(root, "opencode.log")
      // The stub: logs its arguments and stays in the foreground with them, as a TUI does (`read`, a builtin,
      // keeps the shell itself in front, not a `sleep` child).
      writeFileSync(join(root, "bin/opencode"), `#!/bin/sh\necho "$*" >> '${log}'\nwhile :; do read -r _ || sleep 1; done\n`)
      chmodSync(join(root, "bin/opencode"), 0o755)
      writeFileSync(join(root, "init.lua"), "-- scratch\n")
      server = Bun.spawn([rexBin!, "server", "run", "--listen", socket, "--state-dir", join(root, "rex-state"), "--config", join(root, "init.lua"), "--restore=false"], {
        env,
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      })
      await until("the scratch Rex server", () => rex("ls", "--json").code === 0)

      // The scratch hc: an OpenCode stub in api's first tab, a shell beside it, a shell in notes.
      hcStarted = true
      const api = join(root, "w/api")
      const notes = join(root, "w/notes")
      const started = (args: string[]) => JSON.parse(run(["hc", "run", "--bg", "--json", "--no-parent", ...args]).out).address as string
      const t1 = started(["--cwd", api, join(root, "bin/opencode"), "-s", "ses_scratchOne1"])
      const t2 = started(["--cwd", api])
      const t3 = started(["--cwd", notes])
      const block = (id: string, terminal: string) => ({ type: "block", id, content: { terminal } })
      const doc = {
        spaces: [
          { id: "spA", name: "", folder: api, tabs: [{ id: "tbA", name: "agent", root: { type: "row", id: "tbA", children: [block("p1", t1), block("p2", t2)] } }] },
          { id: "spB", name: "notes", folder: notes, tabs: [{ id: "tbB", name: "", root: { type: "row", id: "tbB", children: [block("p3", t3)] } }] },
        ],
      }
      const set = await hcCall("doc.set", { name: "herdr-app", value: doc, version: 0 })
      expect(set.error).toBeUndefined()
      const foreground = () => JSON.stringify(JSON.parse(run(["hc", "get", t1, "--json"]).out).foreground ?? null)
      await until(`hc to see the stub's arguments in ${t1}`, () => foreground().includes("ses_scratchOne1"), 10_000).catch(() => {
        throw new Error(`${t1} foreground: ${foreground()}`)
      })

      const planned = rexm("plan")
      expect(planned.code).toBe(0)
      expect(planned.out).toContain('session "api" (new)')
      expect(planned.out).toContain(`would add tab "agent": ${t1} in ${api} [opencode ses_scratchOne1]`)
      expect(rex("ls", "--json").out).toContain('"sessions": []')

      const applied = rexm("apply")
      expect(applied.err).toBe("")
      expect(applied.code).toBe(0)
      expect(applied.out).toContain("3 made; 1 resume(s) pending")
      const sessions = JSON.parse(rex("ls", "--json").out).sessions
      expect(sessions.map((s: any) => s.label).sort()).toEqual(["api", "notes"])
      const again = rexm("apply")
      expect(again.out).toContain("0 made")
      expect(JSON.parse(rex("ls", "--json").out).sessions.length).toBe(2)

      const early = rexm("resume")
      expect(early.code).toBe(1)
      expect(early.out).toContain(`still open in hc ${t1}`)
      // The log has the hc copy's line alone.
      const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])
      expect(lines()).toEqual(["-s ses_scratchOne1"])

      run(["hc", "kill", t1, "--json"])
      let typed = { code: 0, out: "", err: "" }
      await until("resume to type once the hc copy stopped", () => (typed = rexm("resume")).out.includes("1 typed"), 15_000).catch(() => {
        throw new Error(`resume never typed: ${typed.out}`)
      })
      expect(typed.out).toContain(`typed ses_scratchOne1`)
      await until("the stub to start in Rex", () => lines().length === 2, 20_000)
      expect(lines()).toEqual(["-s ses_scratchOne1", "-s ses_scratchOne1"])
      expect(rexm("resume").out).toContain("0 typed")

      let checked = rexm("verify")
      await until("verify to pass", () => (checked = rexm("verify")).code === 0, 10_000).catch(() => {})
      expect(checked.out).toBe("ok   tabs\nok   resumes\nok   sessions\n")
      await Bun.sleep(500)
      expect(lines().length).toBe(2)
      expect(readdirSync(join(root, "state/rexm")).length).toBe(1)

      cleanup()
      const owner = JSON.parse(Bun.spawnSync(["hc", "server", "status", "--json"], { stdout: "pipe", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "HC_SESSION")) as Record<string, string> }).stdout.toString() || "{}").pid
      expect(owner).toBe(ownerHc)
      await Bun.sleep(300)
      const left = Bun.spawnSync(["ps", "-axo", "pid,command"], { stdout: "pipe" }).stdout.toString().split("\n").filter((l) => l.includes(root) || l.includes(runtime))
      expect(left).toEqual([])
    },
    { timeout: 120_000 },
  )
})
