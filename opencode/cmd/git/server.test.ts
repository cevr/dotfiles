// The plugin seam: the composition root on a stand-in host, with the live
// adapters over a real git checkout in a scratch directory and a scratch PATH
// holding git, and, as each test says, a stand-in `gh` and `hunk`. It checks
// that each method reads the session's directory as the host reports it now,
// and that `gh` and hunk are optional. tests/git.test.ts runs it, with the
// TUI, in OpenCode.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema, type Scope } from "effect"
import { CheckoutAnswer, GIT, PullRequestAnswer, ReviewAnswer } from "@dotfiles/opencode-git/git"
import { OPEN_REQUEST } from "@dotfiles/opencode-git/laws"
import { PULL_REQUEST_FIELDS } from "@dotfiles/opencode-git/pull-request"
import { HUNK_MISSING } from "@dotfiles/opencode-git/review"
import { type FakeWorld, install } from "@dotfiles/opencode-git/process/fake-gh"
import { quietRepo } from "../../tests/git-repo.ts"
import Git, { live, make } from "./server.ts"

type Host = Parameters<(typeof Git)["effect"]>[0]
type Handler = (input: unknown) => Effect.Effect<unknown, unknown>
interface Tool {
  readonly name: string
  readonly options?: { readonly codemode?: boolean }
  readonly execute: (input: unknown, context: { readonly sessionID: string }) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly text: string }> }, { readonly message: string }>
}

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

const scratch = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "git-plugin-")))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const executable = (file: string, text: string) => {
  writeFileSync(file, text)
  chmodSync(file, 0o755)
}

/**
 * A scratch world: a checkout on `feature` with `a.txt` changed and `b.txt`
 * untracked, a directory in no checkout, and a PATH directory holding git
 * and, when asked, a stand-in `gh` that names OPEN_REQUEST and a `hunk`.
 */
const world = (programs: { readonly gh: boolean; readonly hunk: boolean }) =>
  Effect.gen(function* () {
    const dir = yield* scratch
    const bin = join(dir, "bin")
    const repository = join(dir, "repository")
    const outside = join(dir, "outside")
    for (const each of [bin, repository, outside]) mkdirSync(each)
    symlinkSync(Bun.which("git") ?? "/usr/bin/git", join(bin, "git"))
    if (programs.gh)
      executable(
        join(bin, "gh"),
        `#!/bin/sh\n[ "$*" = "pr view --json ${PULL_REQUEST_FIELDS}" ] || exit 9\nprintf '%s\\n' '${JSON.stringify(OPEN_REQUEST)}'\n`,
      )
    if (programs.hunk) executable(join(bin, "hunk"), "#!/bin/sh\n")
    const env = { ...process.env, PATH: bin, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dir }
    const git = (...args: ReadonlyArray<string>) => {
      const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repository, env, stdout: "ignore", stderr: "pipe" })
      return run.exitCode === 0 ? Effect.void : Effect.die(new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`))
    }
    yield* git("init", "-q", "-b", "feature")
    quietRepo(repository)
    writeFileSync(join(repository, "a.txt"), "one\ntwo\n")
    yield* git("add", "a.txt")
    yield* git("commit", "-qm", "base")
    writeFileSync(join(repository, "a.txt"), "one\n2\nthree\n")
    writeFileSync(join(repository, "b.txt"), "new\n")
    return { dir, env, repository, outside }
  })

/**
 * The plugin started on a stand-in host whose sessions are `sessions` (read
 * on every call, so a test can move one), and its git RPC.
 */
const start = (sessions: Record<string, string>, env: Record<string, string | undefined>, options: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const rpc: Record<string, Record<string, Handler>> = {}
    const tools: Record<string, Tool> = {}
    const storage = new Map<string, unknown>()
    const delivered: Array<{ readonly sessionID: string; readonly text: string; readonly description: string }> = []
    const host = {
      options,
      location: { directory: "/plugin" },
      session: {
        get: ({ sessionID }: { readonly sessionID: string }) => {
          const directory = sessions[sessionID]
          return directory === undefined ? Effect.fail(new Error(`Session not found: ${sessionID}`)) : Effect.succeed({ location: { directory } })
        },
        synthetic: (input: { readonly sessionID: string; readonly text: string; readonly description: string }) => Effect.sync(() => void delivered.push(input)),
      },
      storage: {
        get: (key: string) => Effect.sync(() => storage.get(key)),
        set: (key: string, value: unknown) => Effect.sync(() => void storage.set(key, value)),
        remove: (key: string) => Effect.sync(() => void storage.delete(key)),
        scan: ({ prefix }: { readonly prefix: string }) =>
          Effect.sync(() => ({ entries: [...storage.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, value: storage.get(key) })) })),
      },
      tool: {
        transform: (edit: (editor: { readonly add: (tool: Tool) => void }) => void) =>
          Effect.sync(() => edit({ add: (tool) => void (tools[tool.name] = tool) })),
      },
      rpc: {
        register: (definition: { readonly id: string }, handlers: Record<string, Handler>) =>
          Effect.sync(() => {
            rpc[definition.id] = handlers
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Host
    yield* make((ctx) => live(ctx, env)).effect(host)
    const handlers = rpc[GIT.id]
    const call = <S extends Schema.Top & { readonly DecodingServices: never }>(name: string, answer: S, input: unknown) => {
      const method = handlers?.[name]
      return method === undefined
        ? Effect.die(new Error(`not registered: ${GIT.id}.${name}`))
        : method(input).pipe(Effect.flatMap(Schema.decodeUnknownEffect(answer)), Effect.orDie)
    }
    return {
      checkout: (sessionID: string) => call("checkout", CheckoutAnswer, { sessionID }),
      pullRequest: (sessionID: string) => call("pullRequest", PullRequestAnswer, { sessionID }),
      review: (sessionID: string, path: string) => call("review", ReviewAnswer, { sessionID, path }),
      raw: (name: string, input: unknown) => call(name, Schema.Unknown, input),
      tools,
      storage,
      delivered,
    }
  })

describe("the git RPC", () => {
  test("reads the checkout at the session's directory, and follows the session when it moves", () =>
    scenario(
      Effect.gen(function* () {
        const { env, repository, outside } = yield* world({ gh: false, hunk: false })
        const sessions: Record<string, string> = { ses_1: repository }
        const plugin = yield* start(sessions, env)
        const answer = yield* plugin.checkout("ses_1")
        expect(answer.checkout?.root).toBe(repository)
        expect(answer.checkout?.head.branch).toBe("feature")
        expect(answer.checkout?.files).toEqual([
          { path: "a.txt", status: "M", added: 2, deleted: 1 },
          { path: "b.txt", status: "?", added: 1, deleted: 0 },
        ])
        sessions.ses_1 = outside
        expect(yield* plugin.checkout("ses_1")).toEqual({})
      }),
    ))

  test("a session the host cannot read is an answer that says so", () =>
    scenario(
      Effect.gen(function* () {
        const { env } = yield* world({ gh: false, hunk: false })
        const plugin = yield* start({}, env)
        expect(yield* plugin.checkout("ses_gone")).toEqual({ error: "Session not found: ses_gone" })
        expect(yield* plugin.pullRequest("ses_gone")).toEqual({})
        expect(yield* plugin.review("ses_gone", "a.txt")).toEqual({ note: "Session not found: ses_gone" })
      }),
    ))

  test("names the branch's pull request through gh, and none without gh", () =>
    scenario(
      Effect.gen(function* () {
        const withGh = yield* world({ gh: true, hunk: false })
        expect(yield* (yield* start({ ses_1: withGh.repository }, withGh.env)).pullRequest("ses_1")).toEqual({ pullRequest: OPEN_REQUEST })
        const without = yield* world({ gh: false, hunk: false })
        expect(yield* (yield* start({ ses_1: without.repository }, without.env)).pullRequest("ses_1")).toEqual({})
      }),
    ))

  test("reviews a file with hunk when it is on PATH, else with git's pager and a note", () =>
    scenario(
      Effect.gen(function* () {
        const withHunk = yield* world({ gh: false, hunk: true })
        expect(yield* (yield* start({ ses_1: withHunk.repository }, withHunk.env)).review("ses_1", "a.txt")).toEqual({
          command: { program: "hunk", argv: ["hunk", "diff", "--watch", "HEAD", "--", "a.txt"], cwd: withHunk.repository },
        })
        const without = yield* world({ gh: false, hunk: false })
        expect(yield* (yield* start({ ses_1: without.repository }, without.env)).review("ses_1", "b.txt")).toEqual({
          command: { program: "pager", argv: ["git", "--paginate", "diff", "--no-index", "--", "/dev/null", "b.txt"], cwd: without.repository },
          note: HUNK_MISSING,
        })
      }),
    ))

  test("a question that names no session is answered, not failed", () =>
    scenario(
      Effect.gen(function* () {
        const { env } = yield* world({ gh: false, hunk: false })
        const plugin = yield* start({}, env)
        expect(yield* plugin.raw("checkout", {})).toEqual({ error: "the question names no session" })
        expect(yield* plugin.raw("review", { sessionID: "ses_1" })).toEqual({ note: "the question names no session" })
      }),
    ))
})

const FAKE: FakeWorld = {
  repo: "biteinc/maitred",
  branchRequest: 412,
  requests: [{ number: 412, title: "Pay with points", head: "aaaaaaaa11", checks: [{ name: "test", word: "IN_PROGRESS" }] }],
  branch: { name: "master", head: "bbbbbbbb22", checks: [{ name: "build", word: "SUCCESS" }] },
}

const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200 && !done(); tries += 1) yield* Effect.promise(() => new Promise((wake) => setTimeout(wake, 10)))
  })

describe("the pr tool", () => {
  test("is a direct tool; a watch's notice comes into the session on the watcher's tick, and the watch is kept in storage", () =>
    scenario(
      Effect.gen(function* () {
        const { dir, env, repository } = yield* world({ gh: false, hunk: false })
        const gh = install(dir, FAKE)
        const plugin = yield* start({ ses_1: repository }, { ...env, ...gh.env }, { intervalSeconds: 0.02 })
        const pr = plugin.tools.pr
        expect(pr?.options).toEqual({ codemode: false })
        const status = yield* pr!.execute({ action: "status" }, { sessionID: "ses_1" })
        expect(status.content[0]?.text).toContain("biteinc/maitred#412 Pay with points · open")
        const watched = yield* pr!.execute({ action: "watch" }, { sessionID: "ses_1" })
        expect(watched.content[0]?.text).toContain("Watching biteinc/maitred#412 Pay with points until green: checks pending.")
        expect([...plugin.storage.keys()].sort()).toEqual(["repo:biteinc/maitred", "watch:ses_1:biteinc/maitred#412"])

        gh.put({ ...FAKE, requests: [{ ...FAKE.requests[0]!, checks: [{ name: "test", word: "SUCCESS" }] }] })
        yield* until(() => plugin.delivered.length > 0)
        expect(plugin.delivered.map((each) => [each.sessionID, each.description])).toEqual([["ses_1", "PR biteinc/maitred#412: checks pending → pass"]])
        expect(plugin.delivered[0]?.text).toContain("The watch ended.")
        yield* until(() => !plugin.storage.has("watch:ses_1:biteinc/maitred#412"))
        expect(plugin.storage.has("watch:ses_1:biteinc/maitred#412")).toBe(false)
      }),
    ))

  test("a refusal is a tool error the agent reads", () =>
    scenario(
      Effect.gen(function* () {
        const { dir, env, outside } = yield* world({ gh: false, hunk: false })
        const gh = install(dir, { ...FAKE, repo: undefined, branchRequest: undefined })
        const plugin = yield* start({ ses_1: outside }, { ...env, ...gh.env })
        const failure = yield* plugin.tools.pr!.execute({ action: "watch" }, { sessionID: "ses_1" }).pipe(Effect.flip)
        expect(failure.message).toBe("the session is in no GitHub checkout: name the requests in prs")
      }),
    ))

  test("a malformed option stops the plugin and says which", () =>
    scenario(
      Effect.gen(function* () {
        const { env } = yield* world({ gh: false, hunk: false })
        const exit = yield* Effect.exit(start({}, env, { intervalSeconds: "often" }))
        expect(String(exit)).toContain("dotfiles-opencode.git: invalid options")
      }),
    ))
})
