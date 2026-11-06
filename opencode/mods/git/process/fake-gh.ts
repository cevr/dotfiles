// A stand-in `gh` for tests: run as a program (its shebang is the running
// bun), it answers from a world file (FAKE_GH_WORLD, read again on every call
// so a test moves the world between calls) in gh's own shapes, and appends
// each call's arguments to `<world>.calls`, one JSON array a line. It answers
// `pr view`, `repo view`, `api graphql` (a repository's requests and default
// branch), `api --include` probes (304 when If-None-Match holds the path's
// tag), a job's log and `pr create`; anything else fails.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface FakeCheck {
  readonly name: string
  /** A check run's conclusion once done (SUCCESS, FAILURE, CANCELLED), else its status (IN_PROGRESS). */
  readonly word: string
  readonly jobId?: number
}

export interface FakeRequest {
  readonly number: number
  readonly title: string
  readonly state?: string
  readonly head: string
  readonly checks: ReadonlyArray<FakeCheck>
  readonly reviews?: ReadonlyArray<{ readonly author: string; readonly state: string }>
  readonly decision?: string
}

export interface FakeWorld {
  readonly repo?: string
  /** The open request of the checkout's branch. */
  readonly branchRequest?: number
  readonly requests: ReadonlyArray<FakeRequest>
  readonly branch: { readonly name: string; readonly head: string; readonly checks: ReadonlyArray<FakeCheck> }
  readonly logs?: Readonly<Record<string, string>>
  /** The tag each probed path answers with; a path not here answers a fresh tag each time. */
  readonly tags?: Readonly<Record<string, string>>
}

/** Writes the stand-in (this file, at `source` when bundled elsewhere) into `bin/gh` and the world into `world.json` under `dir`; the env to run gh with. */
export const install = (dir: string, world: FakeWorld, source: string = import.meta.path) => {
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const file = join(dir, "world.json")
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst { main } = await import(${JSON.stringify(source)})\nmain()\n`)
  chmodSync(join(bin, "gh"), 0o755)
  const put = (next: FakeWorld) => writeFileSync(file, JSON.stringify(next))
  put(world)
  return {
    bin,
    env: { FAKE_GH_WORLD: file },
    put,
    calls: (): ReadonlyArray<ReadonlyArray<string>> => {
      try {
        return readFileSync(`${file}.calls`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReadonlyArray<string>)
      } catch {
        return []
      }
    },
  }
}

const rollup = (checks: ReadonlyArray<FakeCheck>) => ({
  contexts: {
    nodes: checks.map((check) => {
      const done = !["IN_PROGRESS", "QUEUED", "PENDING"].includes(check.word)
      return {
        __typename: "CheckRun",
        name: check.name,
        status: done ? "COMPLETED" : check.word,
        conclusion: done ? check.word : null,
        databaseId: check.jobId ?? null,
        detailsUrl: `https://github.com/run/job/${check.jobId ?? 0}`,
        checkSuite: { workflowRun: { workflow: { name: "CI" } } },
      }
    }),
  },
})

/** The `api graphql` answer for `numbers` of the world's repository. */
export const graphqlAnswer = (world: FakeWorld, numbers: ReadonlyArray<number>) => {
  const repository: Record<string, unknown> = {
    defaultBranchRef: { name: world.branch.name, target: { oid: world.branch.head, statusCheckRollup: rollup(world.branch.checks) } },
  }
  for (const number of numbers) {
    const request = world.requests.find((each) => each.number === number)
    repository[`p${number}`] =
      request === undefined
        ? null
        : {
            number,
            title: request.title,
            url: `https://github.com/${world.repo}/pull/${number}`,
            state: request.state ?? "OPEN",
            isDraft: false,
            headRefName: "feature",
            baseRefName: world.branch.name,
            headRefOid: request.head,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: request.decision ?? null,
            author: { login: "cevr" },
            reviewRequests: { nodes: [] },
            latestReviews: { nodes: (request.reviews ?? []).map((review) => ({ author: { login: review.author }, state: review.state, submittedAt: "2026-11-06T10:00:00Z" })) },
            reviewThreads: { nodes: [] },
            commits: { nodes: [{ commit: { oid: request.head, statusCheckRollup: rollup(request.checks) } }] },
          }
  }
  return { data: { repository } }
}

export const main = () => {
  const file = process.env.FAKE_GH_WORLD ?? ""
  const args = process.argv.slice(2)
  appendFileSync(`${file}.calls`, `${JSON.stringify(args)}\n`)
  const world = JSON.parse(readFileSync(file, "utf8")) as FakeWorld
  const said = args.join(" ")
  const out = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
  const fail = (text: string, code = 1) => {
    process.stderr.write(`${text}\n`)
    process.exit(code)
  }
  if (said === "pr view --json number,url,state") {
    if (world.repo === undefined || world.branchRequest === undefined) return fail('no pull requests found for branch "feature"')
    return out(JSON.stringify({ number: world.branchRequest, url: `https://github.com/${world.repo}/pull/${world.branchRequest}`, state: "OPEN" }))
  }
  if (said === "repo view --json nameWithOwner --jq .nameWithOwner") return world.repo === undefined ? fail("no git remotes found") : out(world.repo)
  if (args[0] === "api" && args[1] === "graphql") {
    const query = args.find((arg) => arg.startsWith("query=")) ?? ""
    const numbers = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((match) => Number(match[1]))
    return out(JSON.stringify(graphqlAnswer(world, numbers)))
  }
  if (args[0] === "api" && args[1] === "--include") {
    const path = args.at(-1) ?? ""
    const sent = args.find((arg) => arg.startsWith("If-None-Match: "))?.slice("If-None-Match: ".length)
    const tag = world.tags?.[path] ?? `"${Date.now()}-${Math.random()}"`
    if (sent !== undefined && sent.replace(/^W\//, "") === tag) {
      out(`HTTP/2.0 304 Not Modified\nEtag: ${tag}\n`)
      return fail("gh: HTTP 304")
    }
    return out(`HTTP/2.0 200 OK\nEtag: W/${tag}\n`)
  }
  const job = /^repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)\/logs$/.exec(args.at(-1) ?? "")
  if (args[0] === "api" && job !== null) return out(world.logs?.[job[1] ?? ""] ?? "")
  if (args[0] === "pr" && args[1] === "create") return out(`https://github.com/${world.repo}/pull/${Math.max(0, ...world.requests.map((each) => each.number)) + 1}`)
  return fail(`unexpected: gh ${said}`, 9)
}

if (import.meta.main) main()
