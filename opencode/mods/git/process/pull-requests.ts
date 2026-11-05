// Pull requests through `gh pr view --json`, with prompts, the update notice
// and the spinner off. `gh` is an optional program: none on PATH is
// GhMissing; a `gh` that says there is no request (or no GitHub remote) is
// none; a signed-out `gh`, a failure, a timeout and an answer that does not
// decode are PullRequestUnreadable.
import { Effect, Layer, Option } from "effect"
import { decodePullRequest, PULL_REQUEST_FIELDS, refusal, SIGNED_OUT } from "../pull-request.ts"
import { GhMissing, PullRequests, PullRequestUnreadable } from "../service.ts"

/** `gh` asks the network; a read that takes longer fails. */
export const TIMEOUT_MS = 8_000

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

type Env = Readonly<Record<string, string | undefined>>

/** The pull requests `gh` on `env`'s PATH names. */
export const layer = (env: Env = process.env) =>
  Layer.succeed(
    PullRequests,
    PullRequests.of({
      read: Effect.fn("PullRequests.read")(function* (root: string) {
        const gh = Bun.which("gh", { PATH: env.PATH ?? "" })
        if (gh === null) return yield* new GhMissing()
        const signal = AbortSignal.timeout(TIMEOUT_MS)
        const [stdout, stderr, code] = yield* Effect.tryPromise({
          try: () => {
            const run = Bun.spawn([gh, "pr", "view", "--json", PULL_REQUEST_FIELDS], {
              cwd: root,
              env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              signal,
            })
            return Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
          },
          catch: (cause) => new PullRequestUnreadable({ message: `gh pr view: ${messageOf(cause)}` }),
        })
        if (signal.aborted) return yield* new PullRequestUnreadable({ message: "gh pr view timed out" })
        if (code !== 0) {
          const said = refusal(stderr)
          if (said._tag === "None") return Option.none()
          return yield* new PullRequestUnreadable({ message: said._tag === "SignedOut" ? SIGNED_OUT : said.message })
        }
        const pr = decodePullRequest(stdout)
        if (Option.isNone(pr)) return yield* new PullRequestUnreadable({ message: "gh pr view: unreadable answer" })
        return pr
      }),
    }),
  )
