// GitHub through a stand-in `gh` (fake-gh.ts) on a scratch PATH: where a
// checkout stands, one GraphQL read of requests and the default branch, the
// conditional probes, a job's log and `pr create` with the reviewers; and no
// `gh` on PATH is GhMissing.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { GitHub } from "../service.ts"
import { type FakeWorld, install } from "./fake-gh.ts"
import { headOf, layer, normalTag } from "./github.ts"

const REPO = "biteinc/maitred"
const WORLD: FakeWorld = {
  repo: REPO,
  branchRequest: 412,
  requests: [
    {
      number: 412,
      title: "Pay with points",
      head: "aaaaaaaa11",
      checks: [
        { name: "test", word: "FAILURE", jobId: 9 },
        { name: "lint", word: "SUCCESS" },
        { name: "deploy", word: "CANCELLED" },
        { name: "e2e", word: "IN_PROGRESS" },
      ],
      reviews: [{ author: "alice", state: "APPROVED" }],
      decision: "APPROVED",
    },
  ],
  branch: { name: "master", head: "bbbbbbbb22", checks: [{ name: "build", word: "SUCCESS" }] },
  logs: { "9": "FAIL src/points.test.ts > redeems" },
  tags: { [`repos/${REPO}/pulls/412`]: '"t1"' },
}

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const setUp = (world: FakeWorld = WORLD) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "git-github-")))
  dirs.push(dir)
  const gh = install(dir, world)
  const run = <A, E>(body: (github: GitHub["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(GitHub.use(body).pipe(Effect.provide(layer({ ...process.env, ...gh.env, PATH: gh.bin }))))
  return { dir, gh, run }
}

describe("gh's GitHub", () => {
  test("names the checkout's repository and its branch's open request", async () => {
    const { dir, run } = setUp()
    expect(await run((github) => github.here(dir))).toEqual({ repo: REPO, number: 412 })
    const { dir: bare, run: runBare } = setUp({ ...WORLD, branchRequest: undefined })
    expect(await runBare((github) => github.here(bare))).toEqual({ repo: REPO })
  })

  test("reads requests and the default branch in one GraphQL call, naming a number that does not exist", async () => {
    const { gh, run } = setUp()
    const read = await run((github) => github.read(REPO, [412, 999]))
    expect(gh.calls().filter((call) => call[1] === "graphql")).toHaveLength(1)
    expect(read.missing).toEqual([999])
    expect(read.branch).toMatchObject({ name: "master", head: "bbbbbbbb22" })
    const report = read.reports[0]
    expect(report).toMatchObject({ repo: REPO, number: 412, head: "aaaaaaaa11", reviewDecision: "APPROVED", reviews: [{ author: "alice", state: "APPROVED" }] })
    expect(report?.checks.map((check) => [check.name, check.state, check.jobId])).toEqual([
      ["test", "fail", 9],
      ["lint", "pass", undefined],
      ["deploy", "cancelled", undefined],
      ["e2e", "pending", undefined],
    ])
  })

  test("a probe is changed the first time, unchanged on a 304, and changed when the tag moves", async () => {
    const { gh, run } = setUp()
    const path = `repos/${REPO}/pulls/412`
    const answers = await run((github) =>
      Effect.gen(function* () {
        const first = yield* github.changed([path])
        const second = yield* github.changed([path])
        gh.put({ ...WORLD, tags: { [path]: '"t2"' } })
        const third = yield* github.changed([path])
        return [first, second, third]
      }),
    )
    expect(answers).toEqual([true, false, true])
    expect(gh.calls()[1]).toEqual(["api", "--include", "--silent", "-H", 'If-None-Match: "t1"', path])
  })

  test("reads a job's log and opens a request asking the reviewers", async () => {
    const { dir, gh, run } = setUp()
    expect(await run((github) => github.jobLog(REPO, 9))).toBe("FAIL src/points.test.ts > redeems\n")
    const url = await run((github) => github.create(dir, { title: "T", body: "B", draft: true, reviewers: ["andrewgoupil", "antwandaher"] }))
    expect(url).toBe(`https://github.com/${REPO}/pull/413`)
    expect(gh.calls().at(-1)).toEqual(["pr", "create", "--title", "T", "--body", "B", "--draft", "--reviewer", "andrewgoupil,antwandaher"])
  })

  test("no gh on PATH is GhMissing", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "git-github-")))
    dirs.push(dir)
    const failure = await Effect.runPromise(GitHub.use((github) => github.here(dir).pipe(Effect.flip)).pipe(Effect.provide(layer({ PATH: join(dir, "bin") }))))
    expect(failure._tag).toBe("GhMissing")
  })
})

describe("a probe's answer", () => {
  test("its status and its tag, the weak W/ dropped", () => {
    expect(headOf('HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\n\r\n')).toEqual({ status: 200, etag: '"abc"' })
    expect(headOf("HTTP/2.0 304 Not Modified\nEtag: \"abc\"\n")).toEqual({ status: 304, etag: '"abc"' })
    expect(normalTag(' W/"x" ')).toBe('"x"')
  })
})
