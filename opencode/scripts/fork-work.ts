// The fork-update work an upstream merge calls for, as a short to-do the orchestrator acts on
// (scripts/post-land.ts puts it in a land's post-land report). It reports and never acts: no fork
// commit is dropped and no one is asked from here.
//
// - Prefer-upstream candidates: fork commits (`upstream..prime-look`, merges left out) whose added
//   lines upstream's new commits (`merge-base..upstream`, the commits this merge brings) also add in
//   the same file (files the fork's .gitattributes marks linguist-generated left out), and upstream's new commits that name an issue or PR `opencode/AGENTS.md` links to
//   a fork change. Each is one to ask the owner about before dropping ours.
// - Linked issues and PRs (AGENTS.md's "Upstream issues for the fork's changes now") that upstream
//   has closed or merged since, read through `lookup` (gh in production).
// - Drop markers: an AGENTS.md sentence naming a fork commit, an upstream PR and "drop ours"; the
//   fork commit is droppable once upstream holds the PR's commit (its subject or body names `#N`).
import { existsSync, readFileSync } from "node:fs"

const decoder = new TextDecoder()
const git = (dir: string, ...args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" })
  return { ok: ran.exitCode === 0, out: decoder.decode(ran.stdout).trim() }
}

/** An upstream issue or PR AGENTS.md links to a fork change. */
export interface Linked {
  readonly number: number
  readonly pr: boolean
  /** The fork change it is filed for, as AGENTS.md words it. */
  readonly what: string
}

/** A fork commit AGENTS.md marks to drop once an upstream PR merges. */
export interface DropMarker {
  readonly commit: string
  readonly pr: number
  readonly what: string
}

/** The issues and PRs of AGENTS.md's "Upstream issues for the fork's changes now: a #1; b #2 and #3 (PR #4)." */
export const linkedIssues = (agents: string): ReadonlyArray<Linked> => {
  const start = agents.indexOf("Upstream issues for the fork's changes now:")
  if (start < 0) return []
  const rest = agents.slice(start).split(":").slice(1).join(":")
  const sentence = rest.split(/\.(?:\s|$)/)[0] ?? ""
  return sentence.split(/;\s*/).flatMap((segment) => {
    const what = segment
      .replace(/\s*\([^)]*\)/g, "")
      .replace(/\s*(?:and\s+)?(?:PR\s+)?#\d+/g, "")
      .trim()
    return [...segment.matchAll(/(PR\s+)?#(\d+)/g)].map((match) => ({ number: Number(match[2]), pr: match[1] !== undefined, what }))
  })
}

/** Each sentence naming a fork commit, an upstream PR and "drop ours". */
export const dropMarkers = (agents: string): ReadonlyArray<DropMarker> =>
  agents
    .split(/(?<=\.)\s+/)
    .filter((sentence) => /drop ours/i.test(sentence))
    .flatMap((sentence) => {
      const commit = /fork commit ([0-9a-f]{7,40})/.exec(sentence)
      const pr = /PR #(\d+)/.exec(sentence)
      if (commit?.[1] === undefined || pr?.[1] === undefined) return []
      const what = /fork commit [0-9a-f]{7,40} \(([^)]*)\)/.exec(sentence)?.[1] ?? ""
      return [{ commit: commit[1], pr: Number(pr[1]), what }]
    })

/** One commit of a `git log -p`: its subject, message and the lines it adds, per file. */
interface Commit {
  readonly hash: string
  readonly subject: string
  readonly message: string
  readonly added: ReadonlyMap<string, ReadonlySet<string>>
}

const COMMIT = "\u0001"
const FIELD = "\u0002"

/** A line worth matching: long enough, and not punctuation alone. */
const significant = (line: string) => line.length >= 8 && /[A-Za-z0-9]{3}/.test(line)

/** The commits of `range`, merges left out, with their added lines. */
const commits = (dir: string, range: string): ReadonlyArray<Commit> => {
  const log = git(dir, "log", "--no-merges", "-p", "--unified=0", "--no-color", "--no-ext-diff", `--format=${COMMIT}%H${FIELD}%s${FIELD}%B${FIELD}`, range)
  if (!log.ok) return []
  return log.out
    .split(COMMIT)
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [hash = "", subject = "", message = "", patch = ""] = chunk.split(FIELD)
      const added = new Map<string, Set<string>>()
      let file: string | undefined
      for (const line of patch.split("\n")) {
        if (line.startsWith("+++ ")) {
          file = line === "+++ /dev/null" ? undefined : line.replace(/^\+\+\+ b\//, "")
          continue
        }
        if (file === undefined || !line.startsWith("+")) continue
        const text = line.slice(1).trim()
        if (!significant(text)) continue
        const lines = added.get(file) ?? new Set<string>()
        lines.add(text)
        added.set(file, lines)
      }
      return { hash, subject, message, added }
    })
}

/**
 * The files of `files` that the `.gitattributes` at `source` marks `linguist-generated` (the fork's
 * generated list: packages/protocol/openapi.json, the client's generated types). Both sides regenerate
 * them, so a line they share there says nothing about the change itself.
 */
const generated = (dir: string, source: string, files: ReadonlyArray<string>): ReadonlySet<string> => {
  if (files.length === 0) return new Set()
  const ran = Bun.spawnSync(["git", "-C", dir, "check-attr", "-z", "--stdin", `--source=${source}`, "linguist-generated"], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdin: new TextEncoder().encode(files.join("\0")),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (ran.exitCode !== 0) return new Set()
  const fields = decoder.decode(ran.stdout).split("\0")
  const marked = new Set<string>()
  for (let at = 0; at + 2 < fields.length; at += 3) {
    const [file = "", , value = ""] = fields.slice(at, at + 3)
    if (value === "set" || value === "true") marked.add(file)
  }
  return marked
}

/** The commit with its generated files' lines left out. */
const authored = (commit: Commit, skip: ReadonlySet<string>): Commit => ({ ...commit, added: new Map([...commit.added].filter(([file]) => !skip.has(file))) })

/** Names `#n`, not a longer number starting with it. */
const names = (text: string, number: number) => new RegExp(`#${number}(?!\\d)`).test(text)

/** A fork commit upstream's new commits now also make. */
export interface Candidate {
  readonly fork: { readonly hash: string; readonly subject: string }
  readonly upstream: { readonly hash: string; readonly subject: string }
  /** Why: `<n> of its <m> added lines in <files>`, or the linked issue the upstream commit names. */
  readonly why: string
}

/** The state `lookup` answers for an upstream issue or PR. */
export interface Looked {
  readonly state: "open" | "closed" | "merged"
  readonly title: string
}

/** Reads an upstream issue or PR; nothing when it cannot be read. */
export type Lookup = (number: number) => Promise<Looked | undefined>

export interface ForkWorkInput {
  /** The fork checkout (any worktree of its repository). */
  readonly fork: string
  /** The fork's branch (`prime-look`), as it is now. */
  readonly branch: string
  /** Upstream's tip (`upstream/dev`), as merged or as tried. */
  readonly upstream: string
  /** The fork's branch before the merge: upstream's new commits are those it lacked. */
  readonly before: string
  /** The text of opencode/AGENTS.md. */
  readonly agents: string
  readonly lookup: Lookup
}

export interface ForkWork {
  readonly candidates: ReadonlyArray<Candidate>
  /** Linked issues and PRs upstream has closed or merged. */
  readonly closed: ReadonlyArray<Linked & Looked>
  /** How many linked issues and PRs `lookup` could not read. */
  readonly unread: number
  /** Drop-marked fork commits upstream's PR now covers; `merged` once the fork's branch holds upstream's commit. */
  readonly droppable: ReadonlyArray<DropMarker & { readonly by: string; readonly merged: boolean }>
}

/** Drop-marked fork commits still on the branch whose upstream PR is in `upstream`. Git only, no lookup. */
export const droppable = (input: Pick<ForkWorkInput, "fork" | "branch" | "upstream" | "agents">): ForkWork["droppable"] =>
  dropMarkers(input.agents).flatMap((marker) => {
    if (!git(input.fork, "merge-base", "--is-ancestor", marker.commit, input.branch).ok) return []
    const found = git(input.fork, "log", "--format=%H%x02%B%x01", "--fixed-strings", `--grep=#${marker.pr}`, input.upstream)
    const by = found.out
      .split("\u0001")
      .map((entry) => entry.trim().split("\u0002"))
      .find(([, message = ""]) => names(message, marker.pr))?.[0]
    if (by === undefined || by === "") return []
    return [{ ...marker, by, merged: git(input.fork, "merge-base", "--is-ancestor", by, input.branch).ok }]
  })

export const forkWork = async (input: ForkWorkInput): Promise<ForkWork> => {
  const since = git(input.fork, "merge-base", input.before, input.upstream).out
  const theirs = since === "" ? [] : commits(input.fork, `${since}..${input.upstream}`)
  const mine = commits(input.fork, `${input.upstream}..${input.branch}`)
  const skip = generated(input.fork, input.branch, [...new Set(mine.flatMap((commit) => [...commit.added.keys()]))])
  const fresh = theirs.map((commit) => authored(commit, skip))
  const ours = mine.map((commit) => authored(commit, skip))
  const linked = linkedIssues(input.agents)
  const candidates: Array<Candidate> = []
  for (const fork of ours) {
    const lines = [...fork.added.values()].reduce((sum, set) => sum + set.size, 0)
    if (lines === 0) continue
    let best: { commit: Commit; shared: number; files: ReadonlyArray<string> } | undefined
    for (const commit of fresh) {
      let shared = 0
      const files: Array<string> = []
      for (const [file, added] of fork.added) {
        const theirs = commit.added.get(file)
        if (theirs === undefined) continue
        const both = [...added].filter((line) => theirs.has(line)).length
        if (both > 0) files.push(file)
        shared += both
      }
      if (shared >= Math.min(3, lines) && (best === undefined || shared > best.shared)) best = { commit, shared, files }
    }
    if (best !== undefined)
      candidates.push({
        fork: { hash: fork.hash, subject: fork.subject },
        upstream: { hash: best.commit.hash, subject: best.commit.subject },
        why: `${best.shared} of its ${lines} added lines in ${best.files.join(", ")}`,
      })
  }
  const markers = dropMarkers(input.agents)
  for (const commit of fresh)
    for (const link of linked)
      if (names(commit.message, link.number) && !markers.some((marker) => marker.pr === link.number))
        candidates.push({ fork: { hash: "", subject: link.what }, upstream: { hash: commit.hash, subject: commit.subject }, why: `it names #${link.number}, filed for ${link.what}` })

  const looked = await Promise.all(
    [...new Map(linked.map((link) => [link.number, link])).values()].map(async (link) => ({ link, state: await input.lookup(link.number).catch(() => undefined) })),
  )
  return {
    candidates,
    closed: looked.flatMap(({ link, state }) => (state !== undefined && state.state !== "open" ? [{ ...link, ...state }] : [])),
    unread: looked.filter(({ state }) => state === undefined).length,
    droppable: droppable(input),
  }
}

const short = (hash: string) => hash.slice(0, 10)

/** The to-do lines, one per item; none when there is no fork work. */
export const forkWorkText = (work: ForkWork): ReadonlyArray<string> => [
  ...work.droppable.map((drop) =>
    drop.merged
      ? `- drop fork commit ${short(drop.commit)} (${drop.what || "marked in AGENTS.md"}): upstream PR #${drop.pr} is merged into the fork (${short(drop.by)}). Revert ours in a fork Rift unit, and take its line out of AGENTS.md.`
      : `- fork commit ${short(drop.commit)} (${drop.what || "marked in AGENTS.md"}) is droppable once upstream PR #${drop.pr} (${short(drop.by)}) is merged in: drop ours in the merge.`,
  ),
  ...work.candidates.map((candidate) =>
    candidate.fork.hash === ""
      ? `- prefer upstream? upstream ${short(candidate.upstream.hash)} "${candidate.upstream.subject}": ${candidate.why}. Ask the owner (ask_user_async) before dropping ours.`
      : `- prefer upstream? fork ${short(candidate.fork.hash)} "${candidate.fork.subject}" ~ upstream ${short(candidate.upstream.hash)} "${candidate.upstream.subject}": ${candidate.why}. Ask the owner (ask_user_async) before dropping ours.`,
  ),
  ...work.closed.map(
    (link) =>
      `- prefer upstream? upstream ${link.pr ? "PR" : "issue"} #${link.number} ("${link.title}"), filed for ${link.what}, is ${link.state}. Ask the owner (ask_user_async) before dropping ours, and update its AGENTS.md entry.`,
  ),
  ...(work.unread > 0 ? [`- ${work.unread} linked upstream issues or PRs could not be read (gh); their state is unchecked.`] : []),
]

/** Reads an issue or PR of anomalyco/opencode through gh. */
export const ghLookup =
  (repo = "anomalyco/opencode"): Lookup =>
  async (number) => {
    const child = Bun.spawn(["gh", "api", `repos/${repo}/issues/${number}`, "--jq", "[.state, .title, (.pull_request.merged_at // \"\")] | @tsv"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (code !== 0) return undefined
    const [state = "", title = "", merged = ""] = out.trim().split("\t")
    if (state !== "open" && state !== "closed") return undefined
    return { state: merged !== "" ? "merged" : state, title }
  }

/** AGENTS.md's text, or none. */
export const readAgents = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "")
