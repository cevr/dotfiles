// GitHub through `gh`, with prompts, the update notice and the spinner off.
// A repository's requests and its default branch are one GraphQL read (one
// alias per request); the watcher's probes are conditional REST requests
// (`If-None-Match` with the ETag of the last answer), which cost no rate
// limit when nothing changed; a failing job's log is its raw Actions log;
// a new request is `gh pr create`. No `gh` on PATH is GhMissing; anything
// else that does not answer is GitHubUnreadable.
import { Effect, Layer, Ref, Schema } from "effect"
import type { BranchRead } from "../branch.ts"
import { SIGNED_OUT } from "../pull-request.ts"
import { type Check, checkState, firstLine, type Report, type Thread } from "../report.ts"
import { GhMissing, GitHub, GitHubUnreadable, type Here, type Opening, type RepoRead } from "../service.ts"

/** `gh` asks the network; a call that takes longer fails. */
export const TIMEOUT_MS = 20_000

type Env = Readonly<Record<string, string | undefined>>

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

// ── The GraphQL read ──

const CONTEXTS = `contexts(first: 100) { nodes {
  __typename
  ... on CheckRun { name status conclusion databaseId detailsUrl checkSuite { workflowRun { workflow { name } } } }
  ... on StatusContext { context state targetUrl }
} }`

const REQUEST = `number title url state isDraft headRefName baseRefName headRefOid mergeable mergeStateStatus reviewDecision
  author { login }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
  latestReviews(first: 20) { nodes { author { login } state submittedAt } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated path line comments(first: 1) { nodes { author { login } body } } } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { ${CONTEXTS} } } } }`

/** The query that reads `numbers` of `repo` and its default branch at once. */
export const readQuery = (repo: string, numbers: ReadonlyArray<number>): string => {
  const [owner, name] = repo.split("/")
  const requests = numbers.map((number) => `p${number}: pullRequest(number: ${number}) { ${REQUEST} }`).join("\n")
  return `query { repository(owner: ${JSON.stringify(owner ?? "")}, name: ${JSON.stringify(name ?? "")}) {
${requests}
defaultBranchRef { name target { ... on Commit { oid statusCheckRollup { ${CONTEXTS} } } } }
} }`
}

const Login = Schema.NullOr(Schema.Struct({ login: Schema.String }))
const Nodes = <S extends Schema.Top>(item: S) => Schema.Struct({ nodes: Schema.Array(Schema.NullOr(item)) })
const Context_ = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  databaseId: Schema.optional(Schema.NullOr(Schema.Number)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  checkSuite: Schema.optional(
    Schema.NullOr(Schema.Struct({ workflowRun: Schema.NullOr(Schema.Struct({ workflow: Schema.Struct({ name: Schema.String }) })) })),
  ),
  context: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
})
const Rollup = Schema.NullOr(Schema.Struct({ contexts: Nodes(Context_) }))
const Request = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRefOid: Schema.String,
  mergeable: Schema.String,
  mergeStateStatus: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  author: Login,
  reviewRequests: Nodes(
    Schema.Struct({ requestedReviewer: Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String), slug: Schema.optional(Schema.String) })) }),
  ),
  latestReviews: Nodes(Schema.Struct({ author: Login, state: Schema.String, submittedAt: Schema.NullOr(Schema.String) })),
  reviewThreads: Nodes(
    Schema.Struct({
      isResolved: Schema.Boolean,
      isOutdated: Schema.Boolean,
      path: Schema.NullOr(Schema.String),
      line: Schema.NullOr(Schema.Number),
      comments: Nodes(Schema.Struct({ author: Login, body: Schema.String })),
    }),
  ),
  commits: Nodes(Schema.Struct({ commit: Schema.Struct({ oid: Schema.String, statusCheckRollup: Rollup }) })),
})
const Answer = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Record(Schema.String, Schema.Unknown),
  }),
})
const Branch = Schema.NullOr(Schema.Struct({ name: Schema.String, target: Schema.Struct({ oid: Schema.String, statusCheckRollup: Rollup }) }))
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer))
const decodeRequest = Schema.decodeUnknownOption(Schema.NullOr(Request))
const decodeBranch = Schema.decodeUnknownOption(Branch)

const present = <A>(items: ReadonlyArray<A | null>): ReadonlyArray<A> => items.filter((item): item is A => item !== null)

const checksOf = (rollup: typeof Rollup.Type): ReadonlyArray<Check> =>
  present(rollup?.contexts.nodes ?? []).flatMap((node): ReadonlyArray<Check> => {
    if (node.__typename === "CheckRun") {
      const word = node.conclusion ?? node.status ?? "PENDING"
      const workflow = node.checkSuite?.workflowRun?.workflow.name
      return [
        {
          name: node.name ?? "check",
          state: checkState(word),
          word,
          ...(workflow === undefined ? {} : { workflow }),
          ...(node.detailsUrl == null ? {} : { url: node.detailsUrl }),
          ...(node.databaseId == null ? {} : { jobId: node.databaseId }),
        },
      ]
    }
    if (node.__typename === "StatusContext") {
      const word = node.state ?? "PENDING"
      return [{ name: node.context ?? "status", state: checkState(word), word, ...(node.targetUrl == null ? {} : { url: node.targetUrl }) }]
    }
    return []
  })

const reportOf = (repo: string, request: typeof Request.Type): Report => {
  const commit = request.commits.nodes[0]?.commit
  const threads: Array<Thread> = present(request.reviewThreads.nodes)
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const first = thread.comments.nodes[0]
      return {
        author: first?.author?.login ?? "ghost",
        ...(thread.path === null ? {} : { path: thread.path }),
        ...(thread.line === null ? {} : { line: thread.line }),
        firstLine: firstLine(first?.body ?? ""),
        outdated: thread.isOutdated,
      }
    })
  return {
    repo,
    number: request.number,
    title: request.title,
    url: request.url,
    state: request.state,
    isDraft: request.isDraft,
    author: request.author?.login ?? "ghost",
    head: commit?.oid ?? request.headRefOid,
    headRef: request.headRefName,
    baseRef: request.baseRefName,
    checks: checksOf(commit?.statusCheckRollup ?? null),
    ...(request.reviewDecision === null ? {} : { reviewDecision: request.reviewDecision }),
    reviews: present(request.latestReviews.nodes).map((review) => ({ author: review.author?.login ?? "ghost", state: review.state, at: review.submittedAt ?? "" })),
    threads,
    requested: present(request.reviewRequests.nodes).flatMap((each) => {
      const who = each.requestedReviewer?.login ?? each.requestedReviewer?.slug
      return who === undefined ? [] : [who]
    }),
    mergeable: request.mergeable,
    mergeState: request.mergeStateStatus,
  }
}

/** The read a `readQuery` answer holds, or undefined when it does not decode. */
export const decodeRead = (repo: string, numbers: ReadonlyArray<number>, json: string): RepoRead | undefined => {
  const answer = decodeAnswer(json)
  if (answer._tag === "None") return undefined
  const repository = answer.value.data.repository
  const reports: Array<Report> = []
  const missing: Array<number> = []
  for (const number of numbers) {
    const request = decodeRequest(repository[`p${number}`] ?? null)
    if (request._tag === "None") return undefined
    if (request.value === null) missing.push(number)
    else reports.push(reportOf(repo, request.value))
  }
  const branch = decodeBranch(repository.defaultBranchRef ?? null)
  if (branch._tag === "None") return undefined
  const read: BranchRead =
    branch.value === null
      ? { name: "", head: "", checks: [] }
      : { name: branch.value.name, head: branch.value.target.oid, checks: checksOf(branch.value.target.statusCheckRollup) }
  return { reports, missing, branch: read }
}

// ── Probes ──

/** An ETag as a conditional request compares it: GitHub drops the weak `W/` on a 304's. */
export const normalTag = (tag: string): string => tag.trim().replace(/^W\//, "")

/** The status and the ETag of a `gh api --include` answer. */
export const headOf = (answer: string): { readonly status: number; readonly etag?: string } => {
  const lines = answer.split(/\r?\n/)
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0)
  const etag = lines.find((line) => /^etag:/i.test(line))?.replace(/^etag:\s*/i, "")
  return etag === undefined ? { status } : { status, etag: normalTag(etag) }
}

// ── The layer ──

/** GitHub as `gh` on `env`'s PATH reaches it. */
export const layer = (env: Env = process.env) =>
  Layer.effect(
    GitHub,
    Effect.gen(function* () {
      /** The ETag of each probed path's last answer. */
      const tags = yield* Ref.make(new Map<string, string>())

      const gh = (args: ReadonlyArray<string>, cwd?: string) =>
        Effect.gen(function* () {
          const program = Bun.which("gh", { PATH: env.PATH ?? "" })
          if (program === null) return yield* new GhMissing()
          const signal = AbortSignal.timeout(TIMEOUT_MS)
          const [stdout, stderr, code] = yield* Effect.tryPromise({
            try: () => {
              const run = Bun.spawn([program, ...args], {
                ...(cwd === undefined ? {} : { cwd }),
                env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                signal,
              })
              return Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
            },
            catch: (cause) => new GitHubUnreadable({ message: `gh ${args[0] ?? ""}: ${messageOf(cause)}` }),
          })
          if (signal.aborted) return yield* new GitHubUnreadable({ message: `gh ${args[0] ?? ""} timed out` })
          return { stdout, stderr, code }
        })

      const failed = (what: string, stderr: string) =>
        new GitHubUnreadable({ message: stderr.toLowerCase().includes("gh auth login") ? SIGNED_OUT : `${what}: ${stderr.trim().split("\n")[0] ?? ""}` })

      const here = Effect.fn("GitHub.here")(function* (directory: string) {
        const view = yield* gh(["pr", "view", "--json", "number,url,state"], directory)
        if (view.code === 0) {
          const pr = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ number: Schema.Number, url: Schema.String, state: Schema.String })))(view.stdout)
          if (pr._tag === "None") return yield* new GitHubUnreadable({ message: "gh pr view: unreadable answer" })
          const repo = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//.exec(pr.value.url)?.[1]
          const found: Here = { ...(repo === undefined ? {} : { repo }), ...(pr.value.state === "OPEN" ? { number: pr.value.number } : {}) }
          return found
        }
        if (view.stderr.toLowerCase().includes("gh auth login")) return yield* failed("gh pr view", view.stderr)
        const repo = yield* gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], directory)
        const name = repo.stdout.trim()
        const found: Here = repo.code === 0 && name.length > 0 ? { repo: name } : {}
        return found
      })

      const read = Effect.fn("GitHub.read")(function* (repo: string, numbers: ReadonlyArray<number>) {
        const answer = yield* gh(["api", "graphql", "-f", `query=${readQuery(repo, numbers)}`])
        // A request number that does not exist fails its alias and leaves `data` with null there.
        const decoded = decodeRead(repo, numbers, answer.stdout)
        if (decoded !== undefined) return decoded
        return yield* failed(`gh api graphql (${repo})`, answer.stderr.length > 0 ? answer.stderr : answer.stdout)
      })

      const probe = (path: string) =>
        Effect.gen(function* () {
          const known = (yield* Ref.get(tags)).get(path)
          const args = ["api", "--include", "--silent", ...(known === undefined ? [] : ["-H", `If-None-Match: ${known}`]), path]
          const answer = yield* gh(args)
          const head = headOf(answer.stdout)
          if (head.status === 304) return false
          if (head.status < 200 || head.status >= 300) return yield* failed(`gh api ${path}`, answer.stderr.length > 0 ? answer.stderr : `HTTP ${head.status}`)
          if (head.etag !== undefined) {
            const tag = head.etag
            yield* Ref.update(tags, (map) => new Map(map).set(path, tag))
          }
          return true
        })

      const changed = Effect.fn("GitHub.changed")(function* (paths: ReadonlyArray<string>) {
        // Every path is probed, so each one's tag stays current for the next pass.
        const answers = yield* Effect.forEach(paths, probe, { concurrency: 4 })
        return answers.some((each) => each)
      })

      const jobLog = Effect.fn("GitHub.jobLog")(function* (repo: string, jobId: number) {
        const answer = yield* gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${jobId}/logs`])
        if (answer.code !== 0) return yield* failed(`gh api job ${jobId} logs`, answer.stderr)
        return answer.stdout
      })

      const create = Effect.fn("GitHub.create")(function* (directory: string, opening: Opening) {
        const args = [
          "pr",
          "create",
          "--title",
          opening.title,
          "--body",
          opening.body,
          ...(opening.base === undefined ? [] : ["--base", opening.base]),
          ...(opening.draft ? ["--draft"] : []),
          ...(opening.reviewers.length === 0 ? [] : ["--reviewer", opening.reviewers.join(",")]),
        ]
        const answer = yield* gh(args, directory)
        if (answer.code !== 0) return yield* failed("gh pr create", answer.stderr)
        const url = answer.stdout.trim().split("\n").findLast((line) => line.startsWith("https://"))
        if (url === undefined) return yield* new GitHubUnreadable({ message: "gh pr create: no URL in its answer" })
        return url
      })

      return GitHub.of({ here, read, changed, jobLog, create })
    }),
  )
