// The git model over in-memory contracts: what each answer says for a
// checkout, no checkout and one that could not be read; that `gh` is asked
// once per pull request key until the key moves, and never again once it is
// missing; and that a review uses hunk only when it is there.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import type { Checkout } from "./checkout.ts"
import { Git, layer } from "./model.ts"
import { OPEN_REQUEST } from "./laws.ts"
import type { PullRequest } from "./pull-request.ts"
import { HUNK_MISSING } from "./review.ts"
import {
  CheckoutUnreadable,
  Checkouts,
  GhMissing,
  Programs,
  PullRequests,
  PullRequestUnreadable,
  SessionDirectories,
  SessionUnreadable,
} from "./service.ts"

const OID = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"

const checkout: Checkout = {
  root: "/work/app",
  base: "HEAD",
  head: { branch: "feature", oid: OID, upstream: "origin/main", ahead: 1, behind: 0 },
  files: [{ path: "a.ts", status: "M", added: 1, deleted: 1 }],
}

type Gh = "open" | "missing" | "signed-out"

/** A world the model reads: sessions by directory, checkouts by directory, what gh does, and whether hunk is there. */
const world = (gh: Gh, hunk = true) => {
  const state = {
    sessions: { root: "/work/app", plain: "/work/plain", broken: "/work/broken" } as Record<string, string>,
    checkouts: { "/work/app": checkout } as Record<string, Checkout>,
    asked: 0,
  }
  const live = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SessionDirectories, {
          directoryOf: (sessionID: string) => {
            const directory = state.sessions[sessionID]
            return directory === undefined ? Effect.fail(new SessionUnreadable({ sessionID, message: `Session not found: ${sessionID}` })) : Effect.succeed(directory)
          },
        }),
        Layer.succeed(Checkouts, {
          read: (directory: string) =>
            directory === "/work/broken"
              ? Effect.fail(new CheckoutUnreadable({ message: "git status: index file corrupt" }))
              : Effect.succeed(Option.fromUndefinedOr(state.checkouts[directory])),
        }),
        Layer.succeed(PullRequests, {
          read: () =>
            Effect.suspend((): Effect.Effect<Option.Option<PullRequest>, GhMissing | PullRequestUnreadable> => {
              state.asked += 1
              if (gh === "missing") return Effect.fail(new GhMissing())
              if (gh === "signed-out") return Effect.fail(new PullRequestUnreadable({ message: "gh is not signed in · gh auth login" }))
              return Effect.succeed(Option.some(OPEN_REQUEST))
            }),
        }),
        Layer.succeed(Programs, { found: (name: string) => Effect.succeed(hunk && name === "hunk") }),
      ),
    ),
  )
  return { state, run: <A>(body: (git: Git["Service"]) => Effect.Effect<A>) => Effect.runPromise(Git.use(body).pipe(Effect.provide(live))) }
}

describe("checkout", () => {
  test("the session's checkout, nothing outside one, and why one could not be read", async () => {
    const { run } = world("open")
    expect(
      await run((git) => Effect.all([git.checkout("root"), git.checkout("plain"), git.checkout("broken"), git.checkout("gone")])),
    ).toEqual([{ checkout }, {}, { error: "git status: index file corrupt" }, { error: "Session not found: gone" }])
  })
})

describe("pullRequest", () => {
  test("asks gh once per key, and again when the branch moves", async () => {
    const { run, state } = world("open")
    await run((git) =>
      Effect.gen(function* () {
        expect(yield* git.pullRequest("root")).toEqual({ pullRequest: OPEN_REQUEST })
        expect(yield* git.pullRequest("root")).toEqual({ pullRequest: OPEN_REQUEST })
        expect(state.asked).toBe(1)
        state.checkouts["/work/app"] = { ...checkout, files: [] }
        yield* git.pullRequest("root")
        expect(state.asked).toBe(1)
        state.checkouts["/work/app"] = { ...checkout, head: { ...checkout.head, ahead: 2 } }
        yield* git.pullRequest("root")
        expect(state.asked).toBe(2)
      }),
    )
  })

  test("a missing gh is no request and is not asked for again; a signed-out one leaves its note", async () => {
    const missing = world("missing")
    await missing.run((git) =>
      Effect.gen(function* () {
        expect(yield* git.pullRequest("root")).toEqual({})
        expect(yield* git.pullRequest("root")).toEqual({})
        expect(missing.state.asked).toBe(1)
      }),
    )
    const signedOut = world("signed-out")
    expect(await signedOut.run((git) => git.pullRequest("root"))).toEqual({ note: "gh is not signed in · gh auth login" })
  })

  test("no checkout, a detached head or an unborn branch asks gh nothing", async () => {
    const { run, state } = world("open")
    state.checkouts["/work/detached"] = { ...checkout, head: { oid: OID, ahead: 0, behind: 0 } }
    state.sessions.detached = "/work/detached"
    expect(await run((git) => Effect.all([git.pullRequest("plain"), git.pullRequest("broken"), git.pullRequest("detached")]))).toEqual([{}, {}, {}])
    expect(state.asked).toBe(0)
  })
})

describe("review", () => {
  test("hunk when it is there, the pager with a note when it is not, and a note outside a checkout", async () => {
    expect((await world("open").run((git) => git.review("root", "a.ts"))).command?.program).toBe("hunk")
    expect(await world("open", false).run((git) => git.review("root", "a.ts"))).toMatchObject({ command: { program: "pager" }, note: HUNK_MISSING })
    expect(await world("open").run((git) => git.review("plain", "a.ts"))).toEqual({ note: "Not a git checkout" })
    expect(await world("open").run((git) => git.review("broken", "a.ts"))).toEqual({ note: "git status: index file corrupt" })
  })
})
