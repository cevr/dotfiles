// The fork-work finder (scripts/fork-work.ts) on fixture repositories: an upstream with new commits
// and a fork branch with its own, never the real fork.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { dropMarkers, forkWork, forkWorkText, linkedIssues, type Lookup } from "./fork-work.ts"

const AGENTS = [
  "# OpenCode mods",
  "",
  "- Each fork change has an upstream issue (anomalyco/opencode). Upstream issues for the fork's changes now: `ui.composerTab` #59650; `rowGap` `messageID`, the layout `gutter` #61697 (PR #61699 does not carry them yet); shell `action` and handles #63364 and #62363 (auto-backgrounding: PR #60707); form actions #63363. Upstream PR #63209 (merged 2026-11-11) does what fork commit FORKWAIT (a subagent waiting on its own background work) does: drop ours at the next merge.",
  "",
].join("\n")

const scratch = mkdtempSync(join(tmpdir(), "fork-work-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const sh = (dir: string, ...args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

/** Writes `files` and commits them; answers the commit. */
const commit = (dir: string, message: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  sh(dir, "add", "-A")
  sh(dir, "commit", "-q", "-m", message)
  return sh(dir, "rev-parse", "HEAD")
}

const WAIT = ["export const waitsOnOwnWork = (job: Job) => job.background.length > 0", "if (waitsOnOwnWork(job)) return yield* awaitBackground(job)", "const pending = job.background.filter((item) => item.running)"]

/**
 * A fork repository: `dev` is upstream, `prime-look` the fork. The fork adds a wait (later made by
 * upstream too) and a theme (upstream never touches); upstream then adds the wait and a fix naming
 * a linked issue and the drop marker's PR.
 */
const fixture = () => {
  const dir = mkdtempSync(join(scratch, "repo-"))
  sh(dir, "init", "-q", "-b", "dev")
  commit(dir, "init", { "src/job.ts": "export {}\n", "src/theme.ts": "export {}\n" })
  sh(dir, "checkout", "-q", "-b", "prime-look")
  const wait = commit(dir, "feat: a subagent waits on its own background work", { "src/job.ts": `export {}\n${WAIT.join("\n")}\n` })
  const theme = commit(dir, "feat: the Prime theme's composer tab hook", { "src/theme.ts": "export {}\nexport const composerTab = (tab: Tab) => registerComposerTab(tab.id, tab)\n" })
  const before = sh(dir, "rev-parse", "HEAD")
  sh(dir, "checkout", "-q", "dev")
  const theirs = commit(dir, "fix(job): wait for background work (#63209)", { "src/job.ts": `export {}\n// upstream's\n${WAIT.join("\n")}\nexport const more = true\n` })
  const forms = commit(dir, "feat(tui): form actions\n\nCloses #63363.", { "src/form.ts": "export const formActions = ['submit', 'cancel', 'retry']\n" })
  commit(dir, "chore: unrelated", { "README.md": "hello upstream readers\n" })
  sh(dir, "checkout", "-q", "prime-look")
  return { dir, wait, theme, before, theirs, forms, agents: AGENTS.replace("FORKWAIT", wait.slice(0, 10)) }
}

const lookup =
  (states: Record<number, "open" | "closed" | "merged">): Lookup =>
  async (number) =>
    states[number] === undefined ? undefined : { state: states[number], title: `title ${number}` }

describe("AGENTS.md's links", () => {
  test("linkedIssues reads each issue and PR with the change it is filed for", () => {
    expect(linkedIssues(AGENTS)).toEqual([
      { number: 59650, pr: false, what: "`ui.composerTab`" },
      { number: 61697, pr: false, what: "`rowGap` `messageID`, the layout `gutter`" },
      { number: 61699, pr: true, what: "`rowGap` `messageID`, the layout `gutter`" },
      { number: 63364, pr: false, what: "shell `action` and handles" },
      { number: 62363, pr: false, what: "shell `action` and handles" },
      { number: 60707, pr: true, what: "shell `action` and handles" },
      { number: 63363, pr: false, what: "form actions" },
    ])
    expect(linkedIssues("# no list here")).toEqual([])
  })

  test("dropMarkers reads the fork commit, the upstream PR and what it does", () => {
    // A marker naming no commit hash is none.
    expect(dropMarkers(AGENTS)).toEqual([])
    expect(dropMarkers(AGENTS.replace("FORKWAIT", "80da76e442"))).toEqual([{ commit: "80da76e442", pr: 63209, what: "a subagent waiting on its own background work" }])
  })
})

describe("forkWork on a fixture fork", () => {
  test("after a merge: the fork commit upstream now makes is a candidate, an untouched one is not; a linked issue an upstream commit names, the closed and merged links, and the drop-marked commit droppable", async () => {
    const made = fixture()
    sh(made.dir, "merge", "-q", "--no-edit", "-X", "theirs", "dev")
    const work = await forkWork({
      fork: made.dir,
      branch: "prime-look",
      upstream: "dev",
      before: made.before,
      agents: made.agents,
      lookup: lookup({ 59650: "open", 61697: "open", 61699: "merged", 63364: "open", 62363: "open", 60707: "open", 63363: "closed" }),
    })
    expect(work.candidates).toEqual([
      {
        fork: { hash: made.wait, subject: "feat: a subagent waits on its own background work" },
        upstream: { hash: made.theirs, subject: "fix(job): wait for background work (#63209)" },
        why: "3 of its 3 added lines in src/job.ts",
      },
      { fork: { hash: "", subject: "form actions" }, upstream: { hash: made.forms, subject: "feat(tui): form actions" }, why: "it names #63363, filed for form actions" },
    ])
    expect(work.closed.map((link) => [link.number, link.state])).toEqual([
      [61699, "merged"],
      [63363, "closed"],
    ])
    expect(work.unread).toBe(0)
    expect(work.droppable).toEqual([{ commit: made.wait.slice(0, 10), pr: 63209, what: "a subagent waiting on its own background work", by: made.theirs, merged: true }])
    const text = forkWorkText(work)
    expect(text[0]).toStartWith(`- drop fork commit ${made.wait.slice(0, 10)} (a subagent waiting on its own background work): upstream PR #63209 is merged into the fork`)
    expect(text.filter((line) => line.startsWith("- prefer upstream?"))).toHaveLength(4)
    expect(text.some((line) => line.includes(made.theme.slice(0, 10)))).toBe(false)
  })

  test("after a conflict (nothing merged): the same candidates against the commits tried, the marked commit droppable once the merge lands; a lookup that fails is counted, not fatal", async () => {
    const made = fixture()
    const work = await forkWork({ fork: made.dir, branch: "prime-look", upstream: "dev", before: made.before, agents: made.agents, lookup: async () => undefined })
    expect(work.candidates.map((candidate) => candidate.upstream.hash)).toEqual([made.theirs, made.forms])
    expect(work.droppable).toEqual([expect.objectContaining({ by: made.theirs, merged: false })])
    expect(work.closed).toEqual([])
    expect(work.unread).toBe(7)
    expect(forkWorkText(work).at(-1)).toBe("- 7 linked upstream issues or PRs could not be read (gh); their state is unchecked.")
  })

  test("nothing new upstream and no marker: no fork work", async () => {
    const made = fixture()
    sh(made.dir, "merge", "-q", "--no-edit", "-X", "theirs", "dev")
    const after = sh(made.dir, "rev-parse", "HEAD")
    const work = await forkWork({ fork: made.dir, branch: "prime-look", upstream: "dev", before: after, agents: "# nothing linked", lookup: lookup({}) })
    expect(work).toEqual({ candidates: [], closed: [], unread: 0, droppable: [] })
    expect(forkWorkText(work)).toEqual([])
  })
})
