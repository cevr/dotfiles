// cutover.ts against a reference model (1), a generated property (2), a scratch hc core (3) and its runbook (4).
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FROM,
  MARK,
  PROJECT,
  RESUME,
  STEPS,
  fromLive,
  labels,
  preReport,
  readSnapshot,
  resume,
  sessionFromArgv,
  settling,
  unsafe,
  verify,
  withSave,
  type Ports,
  type Saved,
  type Terminal,
} from "./cutover.ts"

const HERE = import.meta.dir
const fixture = (name: string) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"))

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
const ID_CHARS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"]
let serial = 0
/** A session id with any allowed characters, unique by its last part. */
const freshId = (r: Rng) => `ses_${Array.from({ length: int(r, 0, 20) }, () => pick(r, ID_CHARS)).join("")}${(serial++).toString(36)}`

const opencodePane = (cwd: string, session: string | null) => ({
  cwd,
  ...(session === null ? {} : { agent_resume: { source: "dotfiles:opencode", agent: "opencode", argv: ["opencode", "-s", session] } }),
})

interface GenOptions {
  readonly maxWorkspaces: number
  readonly maxTabs: number
  /** Workspace ids that repeat (tabs hcm cannot tell apart) and session ids two panes share. */
  readonly collisions: boolean
}

const genSnapshot = (r: Rng, o: GenOptions) => {
  const folders = ["/home/exedev", "/w/a", "/w/b", "/w/a/sub", "/w/c"]
  const names = [null, "", "alpha", "beta", "alpha", "  spaced  ", "manna - apps"]
  const ids: string[] = []
  const sessions: string[] = []
  return {
    version: 3,
    workspaces: Array.from({ length: int(r, 1, o.maxWorkspaces) }, (_, i) => {
      const id = o.collisions && ids.length > 0 && r() < 0.12 ? pick(r, ids) : `w${i.toString(32).toUpperCase()}`
      ids.push(id)
      const folder = pick(r, folders)
      return {
        id,
        custom_name: pick(r, names),
        identity_cwd: folder,
        tabs: Array.from({ length: int(r, 1, o.maxTabs) }, (_, k) => {
          const session = r() < 0.55 ? (o.collisions && sessions.length > 0 && r() < 0.08 ? pick(r, sessions) : freshId(r)) : null
          if (session !== null) sessions.push(session)
          return { custom_name: pick(r, names), layout: { Pane: k + 1 }, panes: { [String(k + 1)]: opencodePane(r() < 0.8 ? folder : pick(r, folders), session) } }
        }),
      }
    }),
  }
}

// ── the system the code acts on: a fake hc with hcm's behavior, and a fake herdr ──

const SHELL = { name: "zsh", argv: ["/bin/zsh", "-l"] }
const isShell = (fg: { name: string; argv: ReadonlyArray<string> }) => fg.name === "zsh" && fg.argv.length === 2

interface FakeTerminal {
  address: string
  labels: Record<string, string>
  fg: { name: string; argv: string[] }
  reported: boolean
  keep: boolean
  opened: string | null
}

class Fake implements Ports {
  herdrUp = true
  herdrOpen = new Map<string, string | null>()
  terms: FakeTerminal[] = []
  typed: Array<{ address: string; text: string; fresh: boolean }> = []
  resumed = new Set<string>()
  changes = 0
  next = 1
  /** New shells start with no foreground until `shellsStart`. */
  slow = false
  serviceUp = true
  herdrRunning() {
    return this.herdrUp
  }
  terminals(): Terminal[] {
    return this.terms.map((t) => ({
      address: t.address,
      state: "live",
      labels: { ...t.labels },
      // A login shell still starting has no foreground yet.
      foreground: t.fg.name === "" ? null : { name: t.fg.name, argv: [...t.fg.argv] },
      reported: t.reported,
      status: t.fg.name === "opencode" ? { state: "idle", app: "opencode" } : null,
      keep: t.keep,
    }))
  }
  find(address: string) {
    const t = this.terms.find((x) => x.address === address)
    if (t === undefined) throw new Error(`no terminal ${address}`)
    return t
  }
  label(address: string, kv: Record<string, string>) {
    this.changes++
    const t = this.find(address)
    for (const [k, v] of Object.entries(kv)) {
      if (v === "") delete t.labels[k]
      else t.labels[k] = v
    }
  }
  keep(address: string) {
    this.changes++
    this.find(address).keep = true
  }
  /** hcm resume (src/migrate.rs): types every non-empty migrate.resume, then removes it. */
  hcmResume() {
    const lines: string[] = []
    for (const t of this.terms) {
      const text = t.labels[RESUME] ?? ""
      if (text === "") continue
      this.typed.push({ address: t.address, text, fresh: isShell(t.fg) && !t.reported })
      lines.push(`${t.address}: ${text}`)
      // A starting shell reads what was typed once it is up (measured on a scratch core).
      if (isShell(t.fg) || t.fg.name === "") {
        if (t.fg.name === "") t.fg = { ...SHELL, argv: [...SHELL.argv] }
        // `opencode -s <id>` with the service down exits at once, having reported nothing.
        if (this.serviceUp) this.open(t, sessionFromArgv(text.split(" "))!)
        this.resumed.add(t.address)
      }
      delete t.labels[RESUME]
    }
    return lines.length === 0 ? "no panes are waiting to resume" : lines.join("\n")
  }
  open(t: FakeTerminal, id: string) {
    t.fg = { name: "opencode", argv: ["opencode", "-s", id] }
    t.reported = true
    t.opened = id
  }
  /** hcm apply: a kept shell per tab not moved yet, labelled with the tab it came from. */
  apply(snapshot: any) {
    const moved = new Set(this.terms.map((t) => t.labels[FROM]).filter((x) => x !== undefined))
    for (const ws of snapshot.workspaces) {
      ws.tabs.forEach((_: unknown, n: number) => {
        const from = `${ws.id}/${n}`
        if (moved.has(from)) return
        this.terms.push({
          address: `t${this.next++}`,
          labels: { "herdr.space": `sp${ws.id}`, "herdr.tab": `tb${this.next}`, "herdr.seen": "0", [FROM]: from },
          fg: this.slow ? { name: "", argv: [] } : { ...SHELL, argv: [...SHELL.argv] },
          reported: false,
          keep: true,
          opened: null,
        })
      })
    }
  }
  add(t: Omit<FakeTerminal, "address">) {
    this.terms.push({ ...t, address: `t${this.next++}` })
  }
}

// ── the reference model ──

type Fg = "starting" | "shell" | "program" | "opencode"
interface RefTerminal {
  address: string
  from: string | null
  fg: Fg
  reported: boolean
  opened: string | null
  pending: string | null
  owned: string | null
}

class Ref {
  herdrUp = true
  herdrOpen = new Map<string, string | null>()
  terms: RefTerminal[] = []
  next = 1
  slow = false
  serviceUp = true
  /** Each tab's session to resume: the save's, else the snapshot's. */
  constructor(
    readonly froms: ReadonlyArray<string>,
    readonly wanted: ReadonlyMap<string, string | null>,
  ) {}
  fresh = (t: RefTerminal) => t.fg === "shell" && !t.reported
  openAnywhere(id: string, except?: string) {
    return this.terms.some((t) => t.opened === id && t.address !== except) || (this.herdrUp && [...this.herdrOpen.values()].includes(id))
  }
  apply() {
    const moved = new Set(this.terms.map((t) => t.from))
    for (const from of this.froms) {
      if (moved.has(from)) continue
      this.terms.push({ address: `t${this.next++}`, from, fg: this.slow ? "starting" : "shell", reported: false, opened: null, pending: null, owned: null })
    }
  }
  labels() {
    if (this.herdrUp) return
    const count = (xs: ReadonlyArray<string>) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())
    const froms = count(this.froms)
    const sessions = count([...this.wanted.values()].filter((x): x is string => x !== null))
    for (const from of new Set(this.froms)) {
      const id = this.wanted.get(from) ?? null
      const mine = this.terms.filter((t) => t.from === from)
      if (froms.get(from)! > 1 || mine.length !== 1 || id === null || sessions.get(id)! > 1) continue
      const t = mine[0]!
      if (t.owned !== null) continue // labelled already, or resumed
      if (this.openAnywhere(id, t.address) || !this.fresh(t)) continue
      t.pending = id
      t.owned = id
    }
  }
  resume() {
    if (this.herdrUp) return
    const queued = new Set<string>()
    for (const t of this.terms) {
      if (t.pending === null) continue
      if (!this.fresh(t) || this.openAnywhere(t.pending, t.address) || queued.has(t.pending)) {
        t.pending = null
        t.owned = null
      } else queued.add(t.pending)
    }
    for (const t of this.terms) {
      if (t.pending === null) continue
      if (this.serviceUp) Object.assign(t, { fg: "opencode", reported: true, opened: t.pending })
      else t.fg = "shell"
      t.pending = null
    }
  }
  accounted() {
    const opened = this.terms.flatMap((t) => (t.opened === null ? [] : [t.opened]))
    return (
      !this.herdrUp &&
      [...new Set(this.froms)].every((from) => this.terms.filter((t) => t.from === from).length === 1) &&
      this.terms.every((t) => t.pending === null) &&
      this.terms.every((t) => t.owned === null || t.reported) &&
      new Set(opened).size === opened.length
    )
  }
}

const project = (fake: Fake): RefTerminal[] =>
  fake.terms.map((t) => ({
    address: t.address,
    from: t.labels[FROM] ?? null,
    fg: t.fg.name === "" ? "starting" : isShell(t.fg) ? "shell" : t.fg.name === "opencode" ? "opencode" : "program",
    reported: t.reported,
    opened: t.opened,
    pending: t.labels[RESUME] ? sessionFromArgv(t.labels[RESUME]!.split(" "))! : null,
    owned: t.labels[MARK] ?? null,
  }))

// ── 1. model-based test ──

type Command =
  | { kind: "pre" | "apply" | "labels" | "stopHerdr" | "resume" | "verify" | "shellsStart" | "startService" }
  | { kind: "paneNewSession"; from: string; id: string }
  | { kind: "personStarts"; address: string; program: "nvim" | "opencode-new" | "opencode-existing"; id: string }
  | { kind: "personQuits"; address: string }

const genCommand = (r: Rng, fake: Fake, froms: ReadonlyArray<string>, ids: ReadonlyArray<string>): Command => {
  const roll = r()
  const address = fake.terms.length > 0 ? pick(r, fake.terms).address : "t1"
  if (roll < 0.1) return { kind: "pre" }
  if (roll < 0.2) return { kind: "apply" }
  if (roll < 0.25) return { kind: "shellsStart" }
  if (roll < 0.42) return { kind: "labels" }
  if (roll < 0.47) return { kind: "stopHerdr" }
  if (roll < 0.52) return { kind: "startService" }
  if (roll < 0.67) return { kind: "resume" }
  if (roll < 0.77) return { kind: "verify" }
  if (roll < 0.83) return { kind: "paneNewSession", from: pick(r, froms), id: freshId(r) }
  if (roll < 0.94) {
    const program = pick(r, ["nvim", "opencode-new", "opencode-existing"] as const)
    return { kind: "personStarts", address, program, id: program === "opencode-existing" && ids.length > 0 ? pick(r, ids) : freshId(r) }
  }
  return { kind: "personQuits", address }
}

const failWith = (seed: number, trace: ReadonlyArray<Command>, what: string): never => {
  throw new Error(`seed ${seed}: ${what}\ncommands:\n${trace.map((c) => JSON.stringify(c)).join("\n")}`)
}

/** How often the runs reached each interesting state, so a generator that drifts into nothing fails. */
const stats = { verifyPassed: 0, verifyFailed: 0, doubleCaught: 0, typed: 0, unlabelled: 0, labelsRefused: 0 }

/** Session ids open in two places: herdr's panes (while it runs) and hc's terminals. */
const doubles = (fake: Fake): string[] => {
  const open = [...(fake.herdrUp ? [...fake.herdrOpen.values()] : []), ...fake.terms.map((t) => t.opened)].filter((x): x is string => x !== null)
  return [...new Set(open.filter((id, i) => open.indexOf(id) !== i))]
}

/** One generated run: a snapshot, a save, a herdr whose panes may have moved on, and hc terminals already there. */
const modelRun = (seed: number, base?: { snapshot: any; save?: Saved }) => {
  const r = rng(seed)
  const raw = base?.snapshot ?? genSnapshot(r, { maxWorkspaces: 4, maxTabs: 3, collisions: false })
  const panes = readSnapshot(raw)
  const froms = panes.map((p) => p.from)
  // The save is newer than the snapshot: some ids moved on between the two, and herdr may have moved on since.
  const save: Saved = base?.save ?? {
    panes: panes.map((p) => ({ from: p.from, session: p.session !== null && r() < 0.3 ? freshId(r) : p.session })),
  }
  const wanted = new Map(withSave(panes, save).panes.map((p) => [p.from, p.session]))
  const fake = new Fake()
  const ref = new Ref(froms, wanted)
  fake.slow = ref.slow = r() < 0.5
  fake.serviceUp = ref.serviceUp = r() < 0.6
  for (const from of froms) {
    const now = wanted.get(from) ?? null
    const truth = now !== null && r() < 0.15 ? freshId(r) : now
    fake.herdrOpen.set(from, truth)
    ref.herdrOpen.set(from, truth)
  }
  // The owner's other hc terminals: a shell, or an OpenCode on a session of its own.
  for (let i = int(r, 0, 2); i > 0; i--) {
    const id = r() < 0.5 ? freshId(r) : null
    fake.add({ labels: {}, fg: id ? { name: "opencode", argv: ["opencode", "-s", id] } : { ...SHELL, argv: [...SHELL.argv] }, reported: id !== null, keep: false, opened: id })
    ref.terms.push({ address: `t${ref.next++}`, from: null, fg: id ? "opencode" : "shell", reported: id !== null, opened: id, pending: null, owned: null })
  }
  fake.next = ref.next
  const ids = [...new Set([...wanted.values(), ...panes.map((p) => p.session)].filter((x): x is string => x !== null))]
  const trace: Command[] = []
  const steps = int(r, 1, 40)
  for (let s = 0; s < steps; s++) {
    const cmd = genCommand(r, fake, froms, ids)
    trace.push(cmd)
    const fail = (what: string) => failWith(seed, trace, what)
    const before = JSON.stringify(fake.terms)
    const doublesBefore = doubles(fake)
    switch (cmd.kind) {
      case "pre": {
        preReport({ herdrVersion: "herdr 0.9.5", hcVersion: "hc 0.1.21", hcm: "/bin/hcm", snapshot: "s", snapshotMs: 2, serverStartMs: 1, fromLive: false, now: 3, panes })
        if (JSON.stringify(fake.terms) !== before) fail("pre changed hc")
        break
      }
      case "apply":
        fake.apply(raw)
        ref.apply()
        break
      case "startService":
        fake.serviceUp = ref.serviceUp = true
        break
      case "shellsStart":
        for (const t of fake.terms) if (t.fg.name === "") t.fg = { ...SHELL, argv: [...SHELL.argv] }
        for (const t of ref.terms) if (t.fg === "starting") t.fg = "shell"
        break
      case "labels": {
        const changes = fake.changes
        const result = labels(fake, panes, save)
        if (fake.herdrUp) stats.labelsRefused++
        if (fake.herdrUp) {
          if (JSON.stringify(fake.terms) !== before || fake.changes !== changes) fail("labels changed hc while herdr runs")
          if (!result.lines.join("\n").includes("herdr still runs")) fail(`labels did not say why: ${result.lines.join(" | ")}`)
        }
        ref.labels()
        const once = JSON.stringify(fake.terms)
        const changesOnce = fake.changes
        labels(fake, panes, save)
        if (JSON.stringify(fake.terms) !== once || fake.changes !== changesOnce) fail("labels twice did more than labels once")
        for (const address of fake.resumed) if (fake.find(address).labels[RESUME]) fail(`labels labelled ${address} again after it resumed`)
        break
      }
      case "stopHerdr":
        fake.herdrUp = false
        ref.herdrUp = false
        for (const from of froms) {
          fake.herdrOpen.set(from, null)
          ref.herdrOpen.set(from, null)
        }
        break
      case "resume": {
        const typedBefore = fake.typed.length
        const result = resume(fake)
        if (fake.herdrUp && fake.typed.length !== typedBefore) fail("resume typed while herdr runs")
        stats.typed += fake.typed.length - typedBefore
        stats.unlabelled += result.lines.filter((l) => l.startsWith("unlabelled")).length
        ref.resume()
        break
      }
      case "verify": {
        const result = verify(fake, panes)
        if (JSON.stringify(fake.terms) !== before) fail("verify changed hc")
        stats[result.code === 0 ? "verifyPassed" : "verifyFailed"]++
        if (result.lines.some((l) => l.startsWith("FAIL sessions"))) stats.doubleCaught++
        if ((result.code === 0) !== ref.accounted()) fail(`verify says ${result.code === 0 ? "pass" : "fail"}, the model says ${ref.accounted() ? "accounted" : "not accounted"}: ${result.lines.join(" | ")}`)
        break
      }
      case "paneNewSession":
        if (fake.herdrUp) {
          fake.herdrOpen.set(cmd.from, cmd.id)
          ref.herdrOpen.set(cmd.from, cmd.id)
        }
        break
      case "personStarts": {
        const ft = fake.terms.find((t) => t.address === cmd.address)
        const rt = ref.terms.find((t) => t.address === cmd.address)
        if (ft === undefined || rt === undefined || !isShell(ft.fg)) break
        // A person may open a session that is open elsewhere already: their double, which verify must catch.
        if (cmd.program === "nvim") {
          ft.fg = { name: "nvim", argv: ["nvim"] }
          rt.fg = "program"
        } else {
          fake.open(ft, cmd.id)
          Object.assign(rt, { fg: "opencode", reported: true, opened: cmd.id })
        }
        break
      }
      case "personQuits": {
        const ft = fake.terms.find((t) => t.address === cmd.address)
        const rt = ref.terms.find((t) => t.address === cmd.address)
        if (ft === undefined || rt === undefined || isShell(ft.fg)) break
        ft.fg = { ...SHELL, argv: [...SHELL.argv] }
        ft.opened = null
        Object.assign(rt, { fg: "shell", opened: null })
        break
      }
    }
    // Invariants after every step. A double open a person made is theirs; one that appears in a step of ours is a bug.
    const twice = doubles(fake).find((id) => !doublesBefore.includes(id))
    if (twice !== undefined && !cmd.kind.startsWith("person")) fail(`${twice} is open in two places`)
    const bad = fake.typed.find((t) => !t.fresh)
    if (bad !== undefined) fail(`typed ${JSON.stringify(bad.text)} into ${bad.address}, which was not a fresh shell`)
    for (const t of fake.terms) {
      const from = t.labels[FROM]
      if (t.labels[RESUME] && from !== undefined && (wanted.get(from) ?? null) === null) fail(`${t.address} (${from}) has no OpenCode resume but got ${t.labels[RESUME]}`)
    }
    const got = JSON.stringify(project(fake))
    const want = JSON.stringify(ref.terms)
    if (got !== want) fail(`code and model differ\n code:  ${got}\n model: ${want}`)
  }
  return { fake, ref, trace }
}

describe("model-based: generated command sequences against the reference model", () => {
  test("generated snapshots, 600 runs", () => {
    for (let seed = 1; seed <= 600; seed++) modelRun(seed)
  })
  test("the runs reach every interesting state", () => {
    for (let seed = 3001; seed <= 3600; seed++) modelRun(seed)
    for (const [what, n] of Object.entries(stats)) expect({ [what]: n > 10 }).toEqual({ [what]: true })
  })
  test("the Mac fixture, 200 runs", () => {
    for (let seed = 1001; seed <= 1200; seed++) modelRun(seed, { snapshot: fixture("mac.json") })
  })
  test("the workbox fixture with its save, 200 runs", () => {
    for (let seed = 2001; seed <= 2200; seed++) modelRun(seed, { snapshot: fixture("workbox.json"), save: fixture("workbox-save.json") })
  })
  test("the happy order accounts for every pane", () => {
    const fake = new Fake()
    const raw = fixture("mac.json")
    const panes = readSnapshot(raw)
    fake.apply(raw)
    expect(labels(fake, panes).code).toBe(1) // herdr still runs
    fake.herdrUp = false
    expect(labels(fake, panes).code).toBe(0)
    expect(verify(fake, panes).code).toBe(1) // labels still wait
    resume(fake)
    const result = verify(fake, panes)
    expect(result.lines.join("\n")).not.toContain("FAIL")
    expect(result.code).toBe(0)
    expect(fake.typed.map((t) => t.text).sort()).toEqual(["opencode -s ses_fixtureBudget02", "opencode -s ses_fixtureDotfiles03", "opencode -s ses_fixtureMannaApps01"])
    const again = labels(fake, panes)
    expect(again.lines.filter((l) => l.includes("already resumed")).length).toBe(3)
    expect(again.code).toBe(0)
  })
  test("a resume typed while the OpenCode service was down is named, not typed again", () => {
    const fake = new Fake()
    const raw = fixture("workbox.json")
    const panes = readSnapshot(raw)
    fake.herdrUp = false
    fake.serviceUp = false
    fake.apply(raw)
    labels(fake, panes)
    resume(fake)
    expect(verify(fake, panes).lines.filter((l) => l.startsWith("FAIL status")).length).toBe(5)
    const again = labels(fake, panes)
    expect(again.code).toBe(1)
    expect(again.lines[0]).toContain("was typed there once and never reported a status")
    expect(fake.terms.some((t) => t.labels[RESUME])).toBe(false)
  })
  test("two tabs hcm cannot tell apart are refused even when one of their terminals is gone", () => {
    const fake = new Fake()
    const raw = fixture("workbox.json")
    raw.workspaces[1].id = "w1R"
    fake.herdrUp = false
    fake.apply(raw)
    fake.terms.splice(1, 1)
    const result = labels(fake, readSnapshot(raw))
    expect(result.lines.filter((l) => l.startsWith("refused w1R/0 ")).length).toBe(2)
    expect(fake.terms.filter((t) => t.labels[FROM] === "w1R/0" && t.labels[RESUME])).toEqual([])
  })
  test("resume drops a label whose shell started a program since, and types nothing there", () => {
    const fake = new Fake()
    const raw = fixture("workbox.json")
    fake.herdrUp = false
    fake.apply(raw)
    labels(fake, readSnapshot(raw))
    fake.terms[0]!.fg = { name: "nvim", argv: ["nvim", "notes.md"] }
    const result = resume(fake)
    expect(result.lines[0]).toContain("unlabelled t1: it runs nvim notes.md")
    expect(fake.typed.map((t) => t.address)).toEqual(["t2", "t3", "t4", "t5"])
    expect(fake.terms[0]!.labels[MARK]).toBeUndefined()
  })
  test("resume refuses while herdr runs, even with labels waiting", () => {
    const fake = new Fake()
    fake.apply(fixture("workbox.json"))
    fake.terms[0]!.labels[RESUME] = "opencode -s ses_x"
    expect(resume(fake)).toEqual({ lines: [expect.stringContaining("herdr still runs")], code: 1 })
    expect(fake.typed).toEqual([])
  })
})

// ── 2. generated property: one pane, one terminal ──

describe("generated property: labels maps each OpenCode pane to exactly one terminal", () => {
  const check = (raw: any, save?: Saved) => {
    const fake = new Fake()
    fake.herdrUp = false
    fake.apply(raw)
    const panes = withSave(readSnapshot(raw), save).panes
    const result = labels(fake, readSnapshot(raw), save)
    const count = (xs: ReadonlyArray<string>) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())
    const froms = count(panes.map((p) => p.from))
    const sessions = count(panes.flatMap((p) => (p.session ? [p.session] : [])))
    const text = result.lines.join("\n")
    for (const pane of panes) {
      const carrying = fake.terms.filter((t) => t.labels[RESUME] === `opencode -s ${pane.session}`)
      if (froms.get(pane.from)! > 1) {
        expect(text).toContain(`refused ${pane.from} `)
        expect(fake.terms.filter((t) => t.labels[FROM] === pane.from && t.labels[RESUME])).toEqual([])
      } else if (pane.session !== null && sessions.get(pane.session)! === 1) {
        expect(carrying.map((t) => t.labels[FROM])).toEqual([pane.from])
        expect(carrying[0]!.labels[MARK]).toBe(pane.session)
      } else if (pane.session !== null) {
        expect(carrying).toEqual([])
        expect(text).toContain(`refused ${pane.from} `)
      }
    }
    // Never two panes to one terminal: each labelled terminal carries the one pane its tab names.
    for (const t of fake.terms.filter((x) => x.labels[RESUME])) {
      const owners = panes.filter((p) => p.from === t.labels[FROM] && `opencode -s ${p.session}` === t.labels[RESUME])
      expect(owners.length).toBe(1)
    }
    const collide = [...froms.values()].some((n) => n > 1) || [...sessions.values()].some((n) => n > 1)
    expect(result.code).toBe(collide ? 1 : 0)
    return { fake, result }
  }
  test("1 to 20 workspaces, 1 to 5 tabs, repeating folders, names and ids, 400 snapshots", () => {
    for (let seed = 1; seed <= 400; seed++) {
      try {
        check(genSnapshot(rng(seed * 7919), { maxWorkspaces: 20, maxTabs: 5, collisions: true }))
      } catch (error) {
        throw new Error(`seed ${seed}: ${error instanceof Error ? error.message : error}`)
      }
    }
  })
  test("the workbox: every folder is the home, and the tab key alone maps them; the save's newer id wins", () => {
    const { fake, result } = check(fixture("workbox.json"), fixture("workbox-save.json"))
    expect(fake.terms.map((t) => [t.labels[FROM], t.labels[RESUME], t.labels[PROJECT]])).toEqual([
      ["w1R/0", "opencode -s ses_fixturePrsNewer01", "prs"],
      ["w1S/0", "opencode -s ses_fixtureErgo02", "ergo"],
      ["w1T/0", "opencode -s ses_fixturePerf03", "perf"],
      ["w1V/0", "opencode -s ses_fixtureSync04", "sync-engine"],
      ["w1W/0", "opencode -s ses_fixtureSentry05", "sentry-factory"],
    ])
    expect(result.lines[0]).toBe("save: w1R/0 has ses_fixturePrsNewer01, the snapshot ses_fixturePrs01; using the save's (it is newer)")
  })
  test("the Mac: 3 OpenCode panes of 7, a project label on each named workspace", () => {
    const { fake } = check(fixture("mac.json"))
    expect(fake.terms.filter((t) => t.labels[RESUME]).length).toBe(3)
    expect(fake.terms.map((t) => t.labels[PROJECT] ?? null)).toEqual(["manna - films", "manna - apps", null, null, null, "ergo macos run", "bite macos run"])
  })
  test("two hc terminals from one tab: refused, with the pane named", () => {
    const fake = new Fake()
    fake.herdrUp = false
    const raw = fixture("workbox.json")
    fake.apply(raw)
    fake.add({ labels: { [FROM]: "w1S/0" }, fg: { ...SHELL, argv: [...SHELL.argv] }, reported: false, keep: true, opened: null })
    const result = labels(fake, readSnapshot(raw))
    expect(result.lines).toContain("refused w1S/0 (ergo, tab 1): 2 hc terminals are from w1S/0 (t2, t6); kill the extra ones")
    expect(fake.terms.filter((t) => t.labels[FROM] === "w1S/0").map((t) => t.labels[RESUME])).toEqual([undefined, undefined])
  })
})

// ── the pieces ──

describe("snapshot, save, pre", () => {
  test("a split tab and an id that cannot be typed are named by pre", () => {
    const raw = fixture("mac.json")
    raw.workspaces[0].tabs[0].layout = { Split: {} }
    raw.workspaces[1].tabs[0].panes["2"].agent_resume.argv[2] = "ses_x; rm -rf /nonexistent/loop-probe-x"
    const panes = readSnapshot(raw)
    expect(panes[1]!.session).toBeNull()
    const report = preReport({ herdrVersion: "herdr 0.9.5", hcVersion: "hc 0.1.21", hcm: "/x/hcm", snapshot: "s.json", snapshotMs: 10_000, serverStartMs: 5_000, fromLive: false, now: 70_000, panes })
    expect(report.ok).toBe(false)
    expect(report.lines.join("\n")).toContain("split tabs (hcm moves one pane per tab): w4/0")
    expect(report.lines.join("\n")).toContain('wC/0 "ses_x; rm -rf /nonexistent/loop-probe-x"')
  })
  test("pre fails an old herdr, an old hc, a missing hcm and a snapshot older than the server", () => {
    const report = preReport({ herdrVersion: "herdr 0.9.1", hcVersion: "hc 0.1.17", hcm: undefined, snapshot: "s.json", snapshotMs: 1_000, serverStartMs: 5_000, fromLive: false, now: 70_000, panes: [] })
    expect(report.lines.filter((l) => l.startsWith("FAIL")).length).toBe(4)
    const ok = preReport({ herdrVersion: "herdr 0.10.0", hcVersion: "hc 0.1.21", hcm: "/x/hcm", snapshot: "s.json", snapshotMs: 6_000, serverStartMs: 5_000, fromLive: false, now: 70_000, panes: readSnapshot(fixture("mac.json")) })
    expect(ok.ok).toBe(true)
    const row = ok.lines.join("\n").split("\n").find((l) => l.startsWith("manna - apps"))
    expect(row).toMatch(/^manna - apps +tab 1 +\/Users\/cvr\/Developer\/personal\/manna +ses_fixtureMannaApps01$/)
  })
  test("--from-live builds hcm's input from herdr's live API and the save", () => {
    const live = {
      workspaces: [
        { workspace_id: "w1R", label: "prs" },
        { workspace_id: "w2", label: "exedev" },
      ],
      tabs: [
        { tab_id: "w1R:t1", workspace_id: "w1R", label: "1" },
        { tab_id: "w2:t1", workspace_id: "w2", label: "1" },
      ],
      panes: [
        { pane_id: "w1R:p1", tab_id: "w1R:t1", workspace_id: "w1R", cwd: "/home/exedev" },
        { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", cwd: "/home/exedev" },
        { pane_id: "w2:p2", tab_id: "w2:t1", workspace_id: "w2", cwd: "/home/exedev" },
      ],
    }
    const panes = readSnapshot(fromLive(live, fixture("workbox-save.json")))
    expect(panes.map((p) => [p.from, p.workspace.name, p.session, p.split])).toEqual([
      ["w1R/0", "prs", "ses_fixturePrsNewer01", false],
      ["w2/0", "", null, true],
    ])
  })
  test("a shell running a script is not a fresh shell", () => {
    const t = (argv: string[], reported = false): Terminal => ({ address: "t1", state: "live", labels: {}, foreground: { name: "sh", argv }, reported, status: null, keep: true })
    expect(unsafe(t(["/bin/sh"]))).toBeUndefined()
    expect(unsafe(t(["/bin/sh", "/x/opencode", "-s", "ses_a"]))).toContain("it runs")
    expect(unsafe(t(["-sh"], true))).toContain("reported a status")
    expect(unsafe({ ...t([]), foreground: null })).toBe("its shell has not started yet (run labels again in a moment)")
  })
  test("settling waits for each moved shell to start, then lists", () => {
    const fake = new Fake()
    fake.slow = true
    fake.herdrUp = false
    fake.apply(fixture("workbox.json"))
    let polls = 0
    const ports = settling({ ...fake, herdrRunning: () => false, label: () => {}, keep: () => {}, hcmResume: () => "", terminals: () => {
      if (++polls === 3) for (const x of fake.terms) x.fg = { ...SHELL, argv: [...SHELL.argv] }
      return fake.terminals()
    } }, 5_000)
    expect(ports.terminals().every((x) => x.foreground?.name === "zsh")).toBe(true)
    expect(polls).toBe(3)
  })
})

// ── 3. scratch drive against a real hc core ──

const missing = ["hc", "hcm"].filter((bin) => Bun.which(bin) === null)
if (missing.length > 0) console.log(`scratch drive skipped: ${missing.join(" and ")} not on the PATH`)

describe.skipIf(missing.length > 0)("scratch drive: hcm apply, labels, hcm resume, verify on a scratch hc core", () => {
  const root = join(tmpdir(), `hc-cutover-${process.pid}`)
  // The socket path must stay under 104 bytes, so the runtime folder is short.
  const runtime = `/tmp/hcc${process.pid}`
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_") && !k.startsWith("HC_")) as [string, string][])
  Object.assign(env, {
    HC_SESSION: `hcc${process.pid}`,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: runtime,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
  })
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe" })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const cutover = (...args: string[]) => run(["bun", join(HERE, "cutover.ts"), ...args])
  const ownerPid = () => JSON.parse(Bun.spawnSync(["hc", "server", "status", "--json"], { stdout: "pipe", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "HC_SESSION")) as Record<string, string> }).stdout.toString() || "{}").pid
  let started = false
  const cleanup = () => {
    if (started) run(["hc", "server", "stop", "--json"])
    started = false
    rmSync(root, { recursive: true, force: true })
    rmSync(runtime, { recursive: true, force: true })
  }
  afterAll(cleanup)
  const terminals = () => JSON.parse(run(["hc", "ls", "--json"]).out).terminals.map((t: any) => JSON.parse(run(["hc", "get", t.address, "--json"]).out))
  const until = async (what: string, done: () => boolean, ms = 20_000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (done()) return
      await Bun.sleep(200)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  test(
    "7 terminals, 3 labelled; a second labels changes nothing; each stub gets its own id",
    async () => {
      const owner = ownerPid()
      for (const dir of ["home", "config", "state", "data", "cache", "bin"]) mkdirSync(join(root, dir), { recursive: true })
      mkdirSync(runtime, { recursive: true })
      const log = join(root, "opencode.log")
      // The stub: prints its arguments, reports a status (OSC 7501) and stays.
      writeFileSync(join(root, "bin/opencode"), `#!/bin/sh\necho "$*" >> '${log}'\nprintf '\\033]7501;state=idle:app=opencode\\033\\\\'\nwhile :; do sleep 1; done\n`)
      chmodSync(join(root, "bin/opencode"), 0o755)
      // The Mac fixture, its folders moved under the scratch root.
      const raw = fixture("mac.json")
      const folders = new Map<string, string>()
      const moved = (path: string) => {
        if (!folders.has(path)) folders.set(path, join(root, "w", String(folders.size)))
        mkdirSync(folders.get(path)!, { recursive: true })
        return folders.get(path)!
      }
      for (const ws of raw.workspaces) {
        ws.identity_cwd = moved(ws.identity_cwd)
        for (const tab of ws.tabs) for (const pane of Object.values<any>(tab.panes)) pane.cwd = moved(pane.cwd)
      }
      const snapshot = join(root, "snapshot.json")
      writeFileSync(snapshot, JSON.stringify(raw))

      started = true
      const apply = run(["hcm", "apply", "--snapshot", snapshot])
      expect(apply.code).toBe(0)
      const first = cutover("labels", "--snapshot", snapshot)
      expect(first.out).toContain("3 labelled")
      expect(first.code).toBe(0)
      const after = terminals()
      expect(after.length).toBe(7)
      const waiting = after.filter((t: any) => t.labels[RESUME]?.startsWith("opencode -s ses_"))
      expect(waiting.length).toBe(3)
      expect(after.filter((t: any) => t.labels[PROJECT]).map((t: any) => t.labels[PROJECT])).toEqual(["manna - films", "manna - apps", "ergo macos run", "bite macos run"])

      const second = cutover("labels", "--snapshot", snapshot)
      expect(second.out).toContain("0 labelled")
      expect(terminals().map((t: any) => t.labels)).toEqual(after.map((t: any) => t.labels))

      const resumed = cutover("resume")
      expect(resumed.code).toBe(0)
      await until("three stubs to start", () => existsSync(log) && readFileSync(log, "utf8").trim().split("\n").length === 3)
      expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual(["-s ses_fixtureBudget02", "-s ses_fixtureDotfiles03", "-s ses_fixtureMannaApps01"])

      let result = cutover("verify", "--snapshot", snapshot)
      await until("verify to pass", () => (result = cutover("verify", "--snapshot", snapshot)).code === 0, 10_000).catch(() => {})
      expect(result.out).toContain("ok   labels")
      expect(result.out).toContain("ok   sessions")
      expect(result.out).toContain("ok   terminals")
      expect(result.code).toBe(0)
      expect(cutover("labels", "--snapshot", snapshot).out).toContain("0 labelled")
      await Bun.sleep(500)
      expect(readFileSync(log, "utf8").trim().split("\n").length).toBe(3)

      cleanup()
      expect(ownerPid()).toBe(owner)
      const left = Bun.spawnSync(["ps", "-axo", "pid,command"], { stdout: "pipe" }).stdout.toString().split("\n").filter((l) => l.includes(root) || l.includes(runtime))
      expect(left).toEqual([])
    },
    { timeout: 90_000 },
  )
})

// ── 4. the runbook ──

describe("RUNBOOK.md", () => {
  const text = readFileSync(join(HERE, "RUNBOOK.md"), "utf8")
  test("holds the nine steps of the window, in order", () => {
    const steps = [...text.matchAll(/^## Step (\d+)\b/gm)].map((m) => Number(m[1]))
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
  test("every cutover.ts line names a step the script has", () => {
    const named = [...text.matchAll(/bun herdr-core\/cutover\.ts ([^\s`.,;)]+)/g)].map((m) => m[1]!)
    expect(named.length).toBeGreaterThan(0)
    for (const step of named) expect(STEPS as ReadonlyArray<string>).toContain(step)
  })
  test("names the storage runbooks by file and heading", () => {
    expect(text).toContain("linux/workbox-btrfs/RUNBOOK.md")
    expect(text).toContain("mac/developer-volume/RUNBOOK.md")
    expect(text).toMatch(/^## Rollback/m)
  })
})
