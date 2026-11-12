// The upstream merge's acceptance check: it waits for a calm host, reruns only the files that
// failed, once, and calls the merge red only for a file red twice (scripts/upstream.ts).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { quietRepo } from "../tests/git-repo.ts"
import { acceptance, awaitCalm, CALM_WAIT_MS, failedFiles, type Host, type TestRun, upstreamReading } from "./upstream.ts"

/** A host whose load follows `loads`, one reading per check, on a clock that sleeping advances. */
const fakeHost = (loads: ReadonlyArray<number>) => {
  let clock = 0
  let reads = 0
  const host: Host = {
    load: () => loads[Math.min(reads++, loads.length - 1)] ?? 0,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  }
  return { host, slept: () => clock }
}

/** A `bun test` stand-in: each call fails the files `red` names for that call. */
const fakeRun = (red: ReadonlyArray<ReadonlyArray<string>>) => {
  const calls: Array<ReadonlyArray<string>> = []
  const run: TestRun = async (files) => {
    const failed = (red[calls.length] ?? []).filter((file) => files.includes(file))
    calls.push(files)
    return { code: failed.length === 0 ? 0 : 1, log: `run ${calls.length}: ${failed.join(" ")}`, failed }
  }
  return { run, calls }
}

const files = ["./tests/a.test.ts", "./tests/b.test.ts", "./tests/c.test.ts"]

describe("the acceptance check", () => {
  test("a green run is green, run once", async () => {
    const { run, calls } = fakeRun([])
    expect(await acceptance(files, run, fakeHost([3]).host, () => {})).toEqual({ ok: true })
    expect(calls).toEqual([files])
  })

  test("reruns only the failed files once, and a file green on its rerun is a named flake", async () => {
    const { run, calls } = fakeRun([["./tests/b.test.ts"], []])
    const lines: Array<string> = []
    expect(await acceptance(files, run, fakeHost([3]).host, (line) => lines.push(line))).toEqual({ ok: true })
    expect(calls).toEqual([files, ["./tests/b.test.ts"]])
    expect(lines.some((line) => line.includes("flaky") && line.includes("./tests/b.test.ts"))).toBe(true)
  })

  test("a file red twice makes the merge red and names it", async () => {
    const { run, calls } = fakeRun([["./tests/a.test.ts", "./tests/c.test.ts"], ["./tests/c.test.ts"]])
    const result = await acceptance(files, run, fakeHost([3]).host, () => {})
    expect(calls).toEqual([files, ["./tests/a.test.ts", "./tests/c.test.ts"]])
    expect(result).toEqual({ ok: false, check: "acceptance tests (red twice: ./tests/c.test.ts)", log: "run 2: ./tests/c.test.ts" })
  })

  test("a red run with no file to blame is red at once, with no rerun", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const run: TestRun = async (given) => {
      calls.push(given)
      return { code: 1, log: "crashed", failed: [] }
    }
    expect(await acceptance(files, run, fakeHost([3]).host, () => {})).toEqual({ ok: false, check: "acceptance tests", log: "crashed" })
    expect(calls).toHaveLength(1)
  })

  test("waits for the load to drop under 20 before each run", async () => {
    const { host, slept } = fakeHost([32, 25, 19])
    const { run, calls } = fakeRun([])
    await acceptance(files, run, host, () => {})
    expect(slept()).toBe(30_000)
    expect(calls).toHaveLength(1)
  })
})

describe("waiting for a calm host", () => {
  test("is bounded: past the wait it runs anyway and says so", async () => {
    const { host, slept } = fakeHost([40])
    const lines: Array<string> = []
    expect(await awaitCalm(host, (line) => lines.push(line))).toBe(false)
    expect(slept()).toBe(CALM_WAIT_MS)
    expect(lines.at(-1)).toContain("running the acceptance tests anyway")
  })

  test("does not wait on a calm host", async () => {
    const { host, slept } = fakeHost([4])
    expect(await awaitCalm(host, () => {})).toBe(true)
    expect(slept()).toBe(0)
  })
})

describe("the failed files", () => {
  test("come from bun's own JUnit report, as the paths bun test was given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "upstream-junit-"))
    try {
      writeFileSync(join(dir, "red.test.ts"), `import { describe, expect, test } from "bun:test"\ndescribe("group", () => { test("fails", () => expect(1).toBe(2)) })\n`)
      writeFileSync(join(dir, "top.test.ts"), `import { expect, test } from "bun:test"\ntest("fails", () => expect(1).toBe(2))\n`)
      writeFileSync(join(dir, "green.test.ts"), `import { expect, test } from "bun:test"\ntest("passes", () => expect(1).toBe(1))\n`)
      const report = join(dir, "junit.xml")
      const child = Bun.spawnSync([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`, "./red.test.ts", "./top.test.ts", "./green.test.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(child.exitCode).toBe(1)
      expect(failedFiles(readFileSync(report, "utf8"))).toEqual(["./red.test.ts", "./top.test.ts"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the upstream reading", () => {
  const git = (dir: string, ...args: ReadonlyArray<string>) => {
    const ran = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`)
    return ran.stdout.toString().trim()
  }
  /** An upstream with `ahead` commits past the fork's HEAD, the fork fetched from it as `upstream` before those commits when `stale`. */
  const repos = (ahead: number, stale = false) => {
    const root = mkdtempSync(join(tmpdir(), "upstream-reading-"))
    const upstream = join(root, "upstream")
    const fork = join(root, "fork")
    git(root, "init", "--quiet", "-b", "dev", upstream)
    quietRepo(upstream)
    git(upstream, "commit", "--quiet", "--allow-empty", "-m", "base")
    git(root, "clone", "--quiet", "-o", "upstream", upstream, fork)
    quietRepo(fork)
    for (let i = 0; i < ahead; i++) git(upstream, "commit", "--quiet", "--allow-empty", "-m", `upstream ${i}`)
    if (!stale) git(fork, "fetch", "--quiet", "upstream", "dev")
    return { root, fork, report: join(root, "upstream-conflict.md") }
  }
  const at = new Date("2026-11-11T16:36:01.987Z")

  test("counts the upstream commits the build at HEAD lacks", () => {
    const { root, fork, report } = repos(3)
    try {
      const reading = upstreamReading(fork, report, false, at)
      expect(reading).toMatchObject({ commits: 3, blocked: false, build: git(fork, "rev-parse", "HEAD"), at: at.toISOString() })
      expect(reading?.upstream).toBe(git(fork, "rev-parse", "upstream/dev"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the merge is blocked while its report is there", () => {
    const { root, fork, report } = repos(2)
    try {
      writeFileSync(report, "# Upstream merge conflicts in 8 files\n")
      expect(upstreamReading(fork, report, false, at)).toMatchObject({ commits: 2, blocked: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a host that fetched nothing fetches upstream first, so its count is current", () => {
    const { root, fork, report } = repos(4, true)
    try {
      expect(upstreamReading(fork, report, false, at)).toMatchObject({ commits: 0 })
      expect(upstreamReading(fork, report, true, at)).toMatchObject({ commits: 4 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a fork with no upstream/dev has no reading", () => {
    const { root, fork, report } = repos(1)
    try {
      git(fork, "remote", "remove", "upstream")
      expect(upstreamReading(fork, report, true, at)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
