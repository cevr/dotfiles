// The handler (../model.ts) over Rifts in memory: what each action does to
// the Rifts and what the model reads back. It sits here because the domain
// fence keeps the root's files off its folders.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Predicate, Queue } from "effect"
import * as MemoryLanding from "./landing.ts"
import * as MemoryNotices from "./notices.ts"
import * as MemoryRifts from "./rifts.ts"
import * as MemorySessionDirectories from "./session-directories.ts"
import * as MemoryWorkbox from "./workbox.ts"
import * as Model from "../model.ts"
import { workspaceName, type RiftInput } from "../rift.ts"

const SOURCE = "/code/app"
const FEAT = "/code/.rifts/app/feat-x"

/** The world one test acts on: Rifts, landing, the wakes sent and the workbox commands run. */
interface Bench {
  readonly rifts: MemoryRifts.World
  readonly landing: MemoryLanding.World
  readonly woken: Array<MemoryNotices.Woken>
  readonly workbox: Array<MemoryWorkbox.Ran>
  readonly onWorkbox: boolean
}

const bench = (rifts: MemoryRifts.World, landing = MemoryLanding.world(), onWorkbox = false): Bench => ({ rifts, landing, woken: [], workbox: [], onWorkbox })

const make = (made: Bench, sessions: Record<string, string> = { ses_1: "/code/app/src", ses_in: `${FEAT}/src` }) =>
  Model.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        MemoryRifts.layer(made.rifts),
        MemorySessionDirectories.layer(sessions),
        MemoryLanding.layer(made.landing),
        MemoryNotices.layer(made.woken),
        MemoryWorkbox.layer(made.onWorkbox, made.workbox),
      ),
    ),
  )

/** `body` over one tool's life in the bench's world; the tool's background work stops with it. */
const within = <A>(made: Bench, body: (tool: typeof Model.RiftTool.Service) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(Model.RiftTool, body).pipe(Effect.provide(make(made)))))

/** One call's answer text, or the words of its failure (`refused: …`). */
const answerOf = (tool: typeof Model.RiftTool.Service, input: RiftInput, sessionID = "ses_1") =>
  tool.run(sessionID, input).pipe(
    Effect.map((answer) => answer.text),
    Effect.catch((failure) => Effect.succeed(`${Predicate.isTagged(failure, "RiftFailed") || Predicate.isTagged(failure, "SessionUnreadable") ? "failed" : "refused"}: ${Model.explain(failure)}`)),
  )

/** The answer text of each call in turn, or the words of its failure (`refused: …`), within one tool's life. */
const calls = (made: Bench | MemoryRifts.World, inputs: ReadonlyArray<RiftInput>, sessionID = "ses_1") =>
  within("sources" in made ? bench(made) : made, (tool) =>
    Effect.gen(function* () {
      const answers: Array<string> = []
      for (const input of inputs) answers.push(yield* answerOf(tool, input, sessionID))
      // The background accept checks finish before the tool goes.
      yield* Effect.sleep("20 millis")
      return answers
    }),
  )

/** One call's answer text, or the words of its failure. */
const call = async (made: Bench | MemoryRifts.World, input: RiftInput, sessionID = "ses_1") => (await calls(made, [input], sessionID))[0]!

describe("the rift tool", () => {
  test("create makes a Rift of the session's warm source on the branch, named after it, and says how to move there", async () => {
    const state = MemoryRifts.world([SOURCE])
    expect(await call(state, { action: "create", branch: "feat/x" })).toBe(
      [
        `Created the Rift ${FEAT} from ${SOURCE}, on branch feat/x.`,
        `This session still runs in its own directory. To work in the Rift, move the session there with the session_move tool (directory: "${FEAT}"), or give each shell call workdir "${FEAT}".`,
      ].join("\n"),
    )
    expect(state.rifts.get(FEAT)?.branch).toBe("feat/x")
    // A name alone is the branch too; a Rift's own session makes Rifts of the same source.
    expect(await call(state, { action: "create", name: "spike" }, "ses_in")).toStartWith(`Created the Rift /code/.rifts/app/spike from ${SOURCE}, on branch spike.`)
    expect(await call(state, { action: "create" })).toBe('refused: create needs a branch (or a name, which becomes the branch): { action: "create", branch: "feat/x" }.')
  })

  test("list shows each Rift with its branch and its unsaved work", async () => {
    const state = MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x"), { ...MemoryRifts.clean("/code/.rifts/app/old", undefined), unpushed: ["d85f04d wip"], stashes: 2 }])
    expect(await call(state, { action: "list" })).toBe(
      [`Rifts of ${SOURCE}:`, `- ${FEAT} · branch feat/x · clean`, "- /code/.rifts/app/old · detached at abc1234 · 1 unpushed, 2 stashed"].join("\n"),
    )
    expect(await call(MemoryRifts.world([SOURCE]), { action: "list" })).toBe(`The warm source ${SOURCE} has no Rifts.`)
    expect(await call(MemoryRifts.world(["/other"]), { action: "list" })).toBe("failed: rift ancestors failed: /code/app/src is in no Rift source")
  })

  test("remove trashes a clean Rift by name or path, and refuses one with work found nowhere else until forced", async () => {
    const state = MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x"), { ...MemoryRifts.clean("/code/.rifts/app/busy", "busy"), uncommitted: [" M a.ts"] }])
    expect(await call(state, { action: "remove", name: "feat/x" })).toBe(`Moved the Rift ${FEAT} (branch feat/x) to Rift's trash.`)
    expect(state.rifts.has(FEAT)).toBe(false)
    expect(await call(state, { action: "remove", path: "../../.rifts/app/busy" })).toStartWith("refused: /code/.rifts/app/busy holds work found nowhere else:\n1 uncommitted change(s):\n   M a.ts")
    expect(state.rifts.has("/code/.rifts/app/busy")).toBe(true)
    expect(await call(state, { action: "remove", name: "busy", force: true })).toBe("Moved the Rift /code/.rifts/app/busy (branch busy) to Rift's trash; it held 1 uncommitted.")
    expect(state.rifts.size).toBe(0)
  })

  test("remove names what it cannot find, and never takes the source or the session's own Rift", async () => {
    const state = MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x")])
    expect(await call(state, { action: "remove" })).toStartWith("refused: remove needs the Rift")
    expect(await call(state, { action: "remove", name: "nope" })).toBe(`refused: The warm source ${SOURCE} has no Rift named nope. Its Rifts:\n  ${FEAT}`)
    expect(await call(state, { action: "remove", path: SOURCE, force: true })).toBe(`refused: ${SOURCE} is a warm source, not a Rift made from one; the rift tool never removes a source.`)
    expect(await call(state, { action: "remove", name: "feat-x", force: true }, "ses_in")).toStartWith(`refused: This session runs in ${FEAT}/src, inside ${FEAT}.`)
    expect(state.rifts.has(FEAT)).toBe(true)
  })

  test("a Rift's name is its branch as workrift names it", () => {
    expect(workspaceName("feat/rift tool")).toBe("feat-rift-tool")
    expect(workspaceName("/fix:it!/")).toBe("fixit")
  })

  test("a path resolves against the session's directory", () => {
    expect(Model.resolvePath("/a/b", "../c/./d")).toBe("/a/c/d")
    expect(Model.resolvePath("/a/b", "/x/y/")).toBe("/x/y")
  })

  test("remove withChildren takes a Rift's own Rifts with it, unless one of them holds unsaved work", async () => {
    const CHILD = "/code/.rifts/.rifts/feat-x/child"
    const state = () => MemoryRifts.world([SOURCE], [{ ...MemoryRifts.clean(FEAT, "feat/x"), children: [CHILD] }, MemoryRifts.clean(CHILD, "child")])
    const plain = state()
    expect(await call(plain, { action: "remove", name: "feat-x" })).toStartWith(`refused: ${FEAT} has Rifts of its own, which would go with it.`)
    expect(await call(plain, { action: "remove", name: "feat-x", withChildren: true })).toBe(`Moved the Rift ${FEAT} (branch feat/x) to Rift's trash; it held 1 Rift(s) of its own.`)
    expect(plain.rifts.size).toBe(0)
    const busy = state()
    MemoryRifts.change(busy, CHILD, (workspace) => ({ ...workspace, stashes: 1 }))
    expect(await call(busy, { action: "remove", name: "feat-x", withChildren: true })).toStartWith(`refused: ${CHILD} holds work found nowhere else:\n1 stash entry`)
    expect(busy.rifts.size).toBe(2)
  })

  test("remove counts only a Rift's own stash: one inherited from the warm source is found there, one made in the Rift is not", async () => {
    const state = MemoryRifts.world([SOURCE])
    MemoryRifts.stash(state, SOURCE, "5a5a5a5")
    expect(await call(state, { action: "create", branch: "feat/x" })).toStartWith(`Created the Rift ${FEAT}`)
    expect(await call(state, { action: "list" })).toBe([`Rifts of ${SOURCE}:`, `- ${FEAT} · branch feat/x · clean`].join("\n"))
    MemoryRifts.stash(state, FEAT, "6b6b6b6")
    expect(await call(state, { action: "remove", name: "feat-x" })).toStartWith(`refused: ${FEAT} holds work found nowhere else:\n1 stash entry`)
    expect(state.rifts.has(FEAT)).toBe(true)
    // Once the warm source holds the same entry (the Rift's stash came from it), nothing of the Rift's own is lost.
    MemoryRifts.stash(state, SOURCE, "6b6b6b6")
    expect(await call(state, { action: "remove", name: "feat-x" })).toBe(`Moved the Rift ${FEAT} (branch feat/x) to Rift's trash.`)
  })
})

describe("land", () => {
  const OTHER = "/code/.rifts/app/feat-y"
  const INTEGRATE = "/code/.rifts/app/integrate"
  const POST_LAND = "/code/.rifts/app/post-land"
  const configured = { [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept") }
  const two = () => bench(MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x"), MemoryRifts.clean(OTHER, "feat/y")]), MemoryLanding.world(configured))

  test("lands the Rifts as one batch in the integration Rift: merge each in order, one gate, one push, trash them, then one accept check in the background that wakes the session", async () => {
    const made = two()
    made.landing.merges.set("feat/y", { _tag: "Merged", regenerated: ["opencode/bun.lock", "opencode/mods/orchestrate/agents.json"] })
    made.landing.installs.push("opencode/bun.lock")
    const [answer] = await calls(made, [{ action: "land", rifts: ["feat-x", "../../.rifts/app/feat-y"] }])
    expect(answer).toBe(
      [
        "Landed 2 Rift(s) as one push: abc1234 Merge into main to main (merged feat/x, feat/y; the gate passed in 3s).",
        "Installed or regenerated and committed: opencode/bun.lock, opencode/mods/orchestrate/agents.json.",
        `To the trash: ${FEAT}, ${OTHER}.`,
        `The accept check runs in the background in ${INTEGRATE} on the batch since base0; this session is woken with its result.`,
      ].join("\n"),
    )
    // The integration Rift is made on first use and kept; the landed Rifts fetch origin before the removal check.
    expect(made.landing.steps).toEqual([
      `start ${INTEGRATE} main`,
      "merge feat/x",
      "merge feat/y",
      "install",
      `gate ${INTEGRATE}`,
      `push ${INTEGRATE}`,
      `sync ${FEAT}`,
      `sync ${OTHER}`,
      `accept ${INTEGRATE} base0`,
    ])
    expect(made.woken).toEqual([{ sessionID: "ses_1", notice: { text: "rift land: the accept check for feat/x, feat/y passed in 3s.", description: "rift land · accept passed" } }])
    expect([...made.rifts.rifts.keys()]).toEqual([INTEGRATE])
  })

  describe("with rift.postLand set", () => {
    const withPostLand = (accept: string | undefined) =>
      bench(
        MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x"), MemoryRifts.clean(OTHER, "feat/y")]),
        MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", accept, { postLand: "bun scripts/post-land.ts" }) }),
      )

    test("each pushed batch runs the post-land step once, after the accept check, in its own Rift put at origin's main, with the batch's base and head, and wakes the session with its report", async () => {
      const made = withPostLand("bun run accept")
      made.landing.postLandRun = { code: 0, output: "lots of output\n", report: "upstream: merged 3 commits and pushed prime-look\nfork work: none\n" }
      const [answer] = await calls(made, [{ action: "land", rifts: ["feat-x"] }])
      expect(answer).toEndWith(
        `Then the repository's post-land step (rift.postLand) runs in the background after the accept check, in its own Rift (post-land), one at a time; this session is woken with its report. The next land need not wait for it.`,
      )
      expect(made.landing.steps.slice(-6)).toEqual([
        `accept ${INTEGRATE} base0`,
        "load",
        `start ${POST_LAND} main`,
        "install",
        `post-land ${POST_LAND} base0 abc1234`,
        `ended post-land ${POST_LAND}`,
      ])
      expect(made.landing.steps.filter((step) => step.startsWith("post-land"))).toHaveLength(1)
      expect([...made.rifts.rifts.keys()].sort()).toEqual([INTEGRATE, OTHER, POST_LAND].sort())
      expect(await call(made.rifts, { action: "land", rifts: ["post-land"] })).toBe(
        `refused: Did not land anything: ${POST_LAND} is the Rift the post-land step runs in; it holds no work to land.`,
      )
      expect(made.woken.map((woken) => woken.notice.description)).toEqual(["rift land · accept passed", "rift land · post-land ran"])
      expect(made.woken[1]!.notice.text).toBe(
        "rift land: the post-land step after feat/x ran in 4s. Log: /logs/post-land.log\nupstream: merged 3 commits and pushed prime-look\nfork work: none",
      )
      // A second land, once the first one's background work is done, runs it once more: once per land.
      const again = withPostLand(undefined)
      await calls(again, [{ action: "land", rifts: ["feat-x"] }])
      await calls(again, [{ action: "land", rifts: ["feat-y"] }])
      expect(again.landing.steps.filter((step) => step.startsWith("post-land"))).toEqual([`post-land ${POST_LAND} base0 abc1234`, `post-land ${POST_LAND} base0 abc1234`])
    })

    const overlapping = (made: Bench) => {
      const ran = (step: string) => step.includes(`post-land ${POST_LAND}`)
      return within(made, (tool) =>
        Effect.gen(function* () {
          const started = yield* Queue.unbounded<string>()
          const release = yield* Deferred.make<string>()
          made.landing.postLandHold = Queue.offer(started, "started").pipe(Effect.andThen(Deferred.await(release)), Effect.asVoid)
          expect(yield* answerOf(tool, { action: "land", rifts: ["feat-x"] })).toStartWith("Landed 1 Rift(s) as one push")
          yield* Queue.take(started)
          // The first post-land step runs on: the next land merges, gates and pushes, and its own step waits for the lock.
          expect(yield* answerOf(tool, { action: "land", rifts: ["feat-y"] })).toStartWith("Landed 1 Rift(s) as one push")
          expect(made.landing.steps.indexOf("merge feat/y")).toBeGreaterThan(made.landing.steps.indexOf(`post-land ${POST_LAND} base0 abc1234`))
          expect(made.landing.steps.filter(ran)).toEqual([`post-land ${POST_LAND} base0 abc1234`])
          yield* Deferred.succeed(release, "released")
          yield* Queue.take(started)
          expect(made.landing.steps.filter(ran).slice(0, 3)).toEqual([`post-land ${POST_LAND} base0 abc1234`, `ended post-land ${POST_LAND}`, `post-land ${POST_LAND} base0 abc1234`])
        }),
      )
    }

    test("a land while a post-land step runs goes on, and its own post-land step waits for the first to end: two never overlap", () => overlapping(withPostLand(undefined)))

    test("with an accept check too, the integration Rift is free once it ends, while the post-land step still runs", () => overlapping(withPostLand("bun run accept")))

    test("a failed post-land step wakes with its exit and output; one under load is skipped and said to run at the next land; no step is run for a batch that was not pushed", async () => {
      const failed = withPostLand(undefined)
      failed.landing.postLandRun = { code: 1, output: "error: the fork is not a checkout\n", report: undefined }
      await calls(failed, [{ action: "land", rifts: ["feat-x"] }])
      expect(failed.woken[0]!.notice).toEqual({
        text: "rift land: the post-land step after feat/x FAILED (exit 1) in 4s. The batch is already pushed. Log: /logs/post-land.log\n  error: the fork is not a checkout",
        description: "rift land · post-land failed",
      })
      const loaded = withPostLand(undefined)
      loaded.landing.load = { load: 12.5, cores: 10 }
      await calls(loaded, [{ action: "land", rifts: ["feat-x"] }])
      expect(loaded.landing.steps.filter((step) => step.startsWith("post-land"))).toEqual([])
      expect(loaded.woken[0]!.notice).toEqual({
        text: "rift land: the post-land step after feat/x was skipped: the 1-minute load is 12.5, at or past the host's 10 cores. The next land runs it again.",
        description: "rift land · post-land skipped (load)",
      })
      // The next land, on a calm host, runs it.
      loaded.landing.load = { load: 2, cores: 10 }
      await calls(loaded, [{ action: "land", rifts: ["feat-y"] }])
      expect(loaded.landing.steps.filter((step) => step.startsWith("post-land"))).toHaveLength(1)
      const red = withPostLand("bun run accept")
      red.landing.checks.set(`${INTEGRATE} gate`, { code: 1, output: "1 fail\n" })
      await calls(red, [{ action: "land", rifts: ["feat-x"] }])
      expect(red.landing.steps.filter((step) => step.startsWith("post-land") || step === "load")).toEqual([])
      const pr = bench(
        MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x")]),
        MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", undefined, { push: false, postLand: "bun scripts/post-land.ts" }) }),
      )
      await calls(pr, [{ action: "land", rifts: ["feat-x"] }])
      expect(pr.landing.steps.filter((step) => step.startsWith("post-land"))).toEqual([])
    })
  })

  test("land finds each Rift by its branch too, and refuses a name two Rifts answer to, naming both", async () => {
    const LEXER = "/code/.rifts/app/fu-lexer"
    const PARSER = "/code/.rifts/app/fu-parser"
    const state = () => MemoryRifts.world([SOURCE], [MemoryRifts.clean(LEXER, "run/lexer"), MemoryRifts.clean(PARSER, "run/parser")])
    const made = bench(state(), MemoryLanding.world(configured))
    expect(await call(made, { action: "land", rifts: ["run/lexer", "run-parser"] })).toStartWith("Landed 2 Rift(s) as one push")
    expect(made.landing.steps.slice(0, 3)).toEqual([`start ${INTEGRATE} main`, "merge run/lexer", "merge run/parser"])

    const twice = bench(state(), MemoryLanding.world(configured))
    MemoryRifts.change(twice.rifts, PARSER, (workspace) => ({ ...workspace, branch: "run/lexer" }))
    expect(await call(twice, { action: "land", rifts: ["run/lexer"] })).toBe(
      `refused: run/lexer names more than one Rift of ${SOURCE}; name one by its path:\n  ${LEXER} (branch run/lexer)\n  ${PARSER} (branch run/lexer)`,
    )
    expect(twice.landing.steps).toEqual([])
  })

  test("a land's departs is the orchestrate plugin's: the land runs as it would without it", async () => {
    const LEXER = "/code/.rifts/app/fu-lexer"
    const state = () => MemoryRifts.world([SOURCE], [MemoryRifts.clean(LEXER, "run/lexer")])
    const plain = bench(state(), MemoryLanding.world(configured))
    const departing = bench(state(), MemoryLanding.world(configured))
    const answer = await call(plain, { action: "land", rifts: ["run/lexer"] })
    expect(await call(departing, { action: "land", rifts: ["run/lexer"], departs: "the owner asked for lexer alone" })).toBe(answer)
    expect(departing.landing.steps).toEqual(plain.landing.steps)
  })

  test("a landed Rift whose only stash is the warm source's own is trashed; one with a stash of its own stays, named", async () => {
    const made = bench(MemoryRifts.world([SOURCE]), MemoryLanding.world(configured))
    MemoryRifts.stash(made.rifts, SOURCE, "5a5a5a5")
    await calls(made, [{ action: "create", branch: "feat/x" }, { action: "create", branch: "feat/y" }])
    MemoryRifts.stash(made.rifts, OTHER, "6b6b6b6")
    const [answer] = await calls(made, [{ action: "land", rifts: ["feat-x", "feat-y"] }])
    expect(answer).toContain(`To the trash: ${FEAT}.`)
    expect(answer).toContain(`${OTHER} holds work found nowhere else:\n1 stash entry`)
    expect([...made.rifts.rifts.keys()].sort()).toEqual([OTHER, INTEGRATE].sort())
  })

  test("a conflict outside the written files stops the batch before the gate, names the Rift and the files, and keeps every Rift", async () => {
    const made = two()
    made.landing.merges.set("feat/y", { _tag: "Conflict", files: ["src/a.ts", "README.md"] })
    expect(await call(made, { action: "land", rifts: ["feat-x", "feat-y"] })).toBe(
      `refused: Merging ${OTHER} conflicts with the batch; nothing was pushed and the merge was aborted. Merge the default branch into it, resolve these, commit, and land again:\n  src/a.ts\n  README.md`,
    )
    expect(made.landing.steps).toEqual([`start ${INTEGRATE} main`, "merge feat/x", "merge feat/y"])
    expect(made.woken).toEqual([])
    expect(made.rifts.rifts.has(FEAT) && made.rifts.rifts.has(OTHER)).toBe(true)
  })

  test("a red gate stops before the push with its counts and failures; a red accept wakes the session to fix forward", async () => {
    const red = two()
    red.landing.checks.set(`${INTEGRATE} gate`, { code: 1, output: "noise\n 41 pass\n 1 fail\n(fail) rift > lands\nmore noise\n" })
    expect(await call(red, { action: "land", rifts: ["feat-x", "feat-y"] })).toBe(
      `refused: The gate failed on the batch in ${INTEGRATE}; nothing was pushed.\nexit 1 in 3s; log: /logs/gate.log\n   41 pass\n   1 fail\n  (fail) rift > lands`,
    )
    expect(red.landing.steps).toEqual([`start ${INTEGRATE} main`, "merge feat/x", "merge feat/y", "install", `gate ${INTEGRATE}`])
    expect(red.rifts.rifts.size).toBe(3)

    const late = two()
    late.landing.checks.set(`${INTEGRATE} accept`, { code: 1, output: "(fail) rift > e2e\n" })
    await calls(late, [{ action: "land", rifts: ["feat-x"] }])
    expect(late.woken).toEqual([
      {
        sessionID: "ses_1",
        notice: {
          text: "rift land: the accept check for feat/x FAILED (exit 1) in 3s. The batch is already pushed: fix forward. Log: /logs/accept.log\n  (fail) rift > e2e",
          description: "rift land · accept failed",
        },
      },
    ])
  })

  test("a refused push stops the batch and frees the integration Rift for the next land", async () => {
    const made = two()
    made.landing.pushFails = "origin/main moved while the gate ran; land the batch again to merge it first."
    const answers = await calls(made, [{ action: "land", rifts: ["feat-x"] }, { action: "land", rifts: ["feat-x"] }])
    expect(answers[0]).toBe(`refused: The push from ${INTEGRATE} failed: origin/main moved while the gate ran; land the batch again to merge it first.`)
    expect(answers[1]).toBe(answers[0]!)
    expect(made.rifts.rifts.has(FEAT)).toBe(true)
  })

  describe("with rift.regenerate set", () => {
    const AGENTS = "opencode/mods/orchestrate/agents.json"
    const regenerating = () =>
      bench(
        MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x"), MemoryRifts.clean(OTHER, "feat/y")]),
        MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", undefined, { generated: [AGENTS], regenerate: "bun scripts/agents.ts" }) }),
      )

    test("a clean batch is regenerated after the merges and the install, and what it rewrote is committed before the gate", async () => {
      const made = regenerating()
      made.landing.regenerates.push(AGENTS)
      expect(await call(made, { action: "land", rifts: ["feat-x", "feat-y"] })).toBe(
        [
          "Landed 2 Rift(s) as one push: abc1234 Merge into main to main (merged feat/x, feat/y; the gate passed in 3s).",
          `Installed or regenerated and committed: ${AGENTS}.`,
          `To the trash: ${FEAT}, ${OTHER}.`,
          "No rift.accept is configured, so no check runs after the push.",
        ].join("\n"),
      )
      expect(made.landing.steps.slice(0, 7)).toEqual([`start ${INTEGRATE} main`, "merge feat/x", "merge feat/y", "install", "regenerate", `commit ${AGENTS}`, `gate ${INTEGRATE}`])
    })

    test("nothing to commit makes no commit; a failing regenerate stops the batch before the gate", async () => {
      const quiet = regenerating()
      expect(await call(quiet, { action: "land", rifts: ["feat-x"] })).toStartWith("Landed 1 Rift(s) as one push")
      expect(quiet.landing.steps.slice(0, 5)).toEqual([`start ${INTEGRATE} main`, "merge feat/x", "install", "regenerate", `gate ${INTEGRATE}`])

      const broken = regenerating()
      broken.landing.regenerateFails = "error: Cannot find module './protocol.md'"
      expect(await call(broken, { action: "land", rifts: ["feat-x"] })).toBe(
        `refused: The regenerate step failed in ${INTEGRATE}; nothing was pushed: error: Cannot find module './protocol.md'`,
      )
      expect(broken.landing.steps).toEqual([`start ${INTEGRATE} main`, "merge feat/x", "install", "regenerate"])
      expect(broken.rifts.rifts.has(FEAT)).toBe(true)
    })
  })

  test("with no accept check nothing runs after the push; a landed Rift the session runs in stays; changes also in the warm source do not keep one", async () => {
    const made = bench(
      MemoryRifts.world([SOURCE], [{ ...MemoryRifts.clean(FEAT, "feat/x"), uncommitted: [" M codex/config.toml"] }, MemoryRifts.clean(OTHER, "feat/y")]),
      MemoryLanding.world({ [SOURCE]: MemoryLanding.config("trunk", "true", undefined) }),
    )
    expect(await call(made, { action: "land", rifts: ["feat-x", "feat-y"] }, "ses_in")).toBe(
      [
        "Landed 2 Rift(s) as one push: abc1234 Merge into trunk to trunk (merged feat/x, feat/y; the gate passed in 3s).",
        `To the trash: ${OTHER}.`,
        `Kept ${FEAT}: This session runs in ${FEAT}/src, inside ${FEAT}. Move the session out first (session_move to the source), then remove it.`,
        "No rift.accept is configured, so no check runs after the push.",
      ].join("\n"),
    )
    expect(made.woken).toEqual([])
    const quick = bench(
      MemoryRifts.world([SOURCE], [{ ...MemoryRifts.clean(FEAT, "feat/x"), uncommitted: [" M codex/config.toml"] }]),
      MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "true", undefined) }),
    )
    expect(await call(quick, { action: "land", rifts: ["feat-x"] })).toStartWith("Landed 1 Rift(s) as one push")
    expect([...quick.rifts.rifts.keys()]).toEqual([INTEGRATE])
  })

  describe("with rift.push false (a repository that lands through pull requests)", () => {
    const THIRD = "/code/.rifts/app/feat-z"
    const prs = (pushBranches: boolean, accept: string | undefined = undefined) =>
      bench(
        MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x"), MemoryRifts.clean(OTHER, "feat/y"), MemoryRifts.clean(THIRD, "feat/z")]),
        MemoryLanding.world({ [SOURCE]: MemoryLanding.config("master", "bite gate", accept, { push: false, pushBranches }) }),
      )
    const header = `Checked 3 Rift(s) as one batch in ${INTEGRATE} on master since base0; rift.push is false, so master was not pushed and every Rift stays.`

    test("gates the batch once, pushes no default branch, keeps every Rift, and answers each green with its own branch pushed; a conflict reds only its Rift", async () => {
      const made = prs(true)
      made.landing.merges.set("feat/y", { _tag: "Conflict", files: ["src/a.ts"] })
      made.landing.branchFails.set("feat/z", "! [rejected] feat/z -> feat/z (non-fast-forward)")
      expect(await call(made, { action: "land", rifts: ["feat-x", "feat-y", "feat-z"] })).toBe(
        [
          header,
          "The gate passed in 3s.",
          `- feat/x (${FEAT}): green; branch pushed: def5678 tip of feat/x`,
          `- feat/y (${OTHER}): red; conflicts with the batch: src/a.ts`,
          `- feat/z (${THIRD}): green; branch not pushed: git push failed: ! [rejected] feat/z -> feat/z (non-fast-forward)`,
        ].join("\n"),
      )
      expect(made.landing.steps).toEqual([`start ${INTEGRATE} master`, "merge feat/x", "merge feat/y", "merge feat/z", "install", `gate ${INTEGRATE}`, "push-branch feat/x", "push-branch feat/z"])
      expect(made.rifts.rifts.size).toBe(4)
      expect(made.woken).toEqual([])
    })

    test("a red gate reds every merged Rift and pushes no branch; without rift.pushBranches a green Rift's branch stays local", async () => {
      const red = prs(true)
      red.landing.checks.set(`${INTEGRATE} gate`, { code: 1, output: " 9 pass\n 1 fail\n(fail) orders > total\n" })
      expect(await call(red, { action: "land", rifts: ["feat-x", "feat-y", "feat-z"] })).toBe(
        [
          header,
          "The gate FAILED (exit 1) in 3s; log: /logs/gate.log. Route each failure to the Rift whose diff it touches.\n   9 pass\n   1 fail\n  (fail) orders > total",
          `- feat/x (${FEAT}): red; the batch gate failed`,
          `- feat/y (${OTHER}): red; the batch gate failed`,
          `- feat/z (${THIRD}): red; the batch gate failed`,
        ].join("\n"),
      )
      expect(red.landing.steps.filter((step) => step.startsWith("push"))).toEqual([])
      expect(red.rifts.rifts.size).toBe(4)

      const quiet = prs(false)
      expect(await call(quiet, { action: "land", rifts: ["feat-x"] })).toEndWith(`The gate passed in 3s.\n- feat/x (${FEAT}): green`)
      expect(quiet.landing.steps.filter((step) => step.startsWith("push"))).toEqual([])
    })

    test("with an accept check the answer holds the Rifts pending, and the wake answers each Rift and pushes the green branches", async () => {
      const made = prs(true, "bun run accept")
      made.landing.merges.set("feat/z", { _tag: "Conflict", files: ["b.ts"] })
      const [answer] = await calls(made, [{ action: "land", rifts: ["feat-x", "feat-y", "feat-z"] }])
      expect(answer).toBe(
        [
          header,
          "The gate passed in 3s.",
          `- feat/x (${FEAT}): pending; the accept check runs`,
          `- feat/y (${OTHER}): pending; the accept check runs`,
          `- feat/z (${THIRD}): red; conflicts with the batch: b.ts`,
          `The accept check runs in the background in ${INTEGRATE}; this session is woken with each Rift's result, and a green Rift's branch is pushed then.`,
        ].join("\n"),
      )
      expect(made.woken).toEqual([
        {
          sessionID: "ses_1",
          notice: {
            text: [
              "rift land: the accept check for feat/x, feat/y passed in 3s; master was not pushed.",
              `- feat/x (${FEAT}): green; branch pushed: def5678 tip of feat/x`,
              `- feat/y (${OTHER}): green; branch pushed: def5678 tip of feat/y`,
              `- feat/z (${THIRD}): red; conflicts with the batch: b.ts`,
            ].join("\n"),
            description: "rift land · accept passed",
          },
        },
      ])
      expect(made.landing.steps.slice(-3)).toEqual([`accept ${INTEGRATE} base0`, "push-branch feat/x", "push-branch feat/y"])

      const late = prs(true, "bun run accept")
      late.landing.checks.set(`${INTEGRATE} accept`, { code: 2, output: "(fail) e2e > checkout\n" })
      await calls(late, [{ action: "land", rifts: ["feat-x"] }])
      expect(late.woken[0]?.notice.text).toBe(
        [
          "rift land: the accept check for feat/x FAILED (exit 2) in 3s; master was not pushed. Route each failure to the Rift whose diff it touches. Log: /logs/accept.log",
          "  (fail) e2e > checkout",
          `- feat/x (${FEAT}): red; the accept check failed`,
        ].join("\n"),
      )
      expect(late.landing.steps.filter((step) => step.startsWith("push"))).toEqual([])
    })

    test("when every Rift conflicts, no gate runs and each is red", async () => {
      const made = prs(true)
      made.landing.merges.set("feat/x", { _tag: "Conflict", files: ["a.ts"] })
      expect(await call(made, { action: "land", rifts: ["feat-x"] })).toBe(
        [header.replace("3 Rift(s)", "1 Rift(s)"), "The gate did not run: no Rift merged.", `- feat/x (${FEAT}): red; conflicts with the batch: a.ts`].join("\n"),
      )
      expect(made.landing.steps).toEqual([`start ${INTEGRATE} master`, "merge feat/x", "install"])
    })
  })

  test("refuses before touching a Rift: no Rifts named, an unknown one, its own uncommitted changes, a detached HEAD, the integration Rift, no gate configured", async () => {
    const made = two()
    expect(await call(made, { action: "land" })).toBe('refused: land needs the Rifts to land, in order: { action: "land", rifts: ["feat-x"] }.')
    expect(await call(made, { action: "land", rifts: ["feat-x", "nope"] })).toStartWith(`refused: The warm source ${SOURCE} has no Rift named nope.`)
    made.landing.own.set(FEAT, [" M src/a.ts"])
    expect(await call(made, { action: "land", rifts: ["feat-y", "feat-x"] })).toBe(`refused: Did not land anything: ${FEAT} holds uncommitted changes; commit them first:\n   M src/a.ts`)
    made.rifts.rifts.set(INTEGRATE, MemoryRifts.clean(INTEGRATE, "integrate"))
    expect(await call(made, { action: "land", rifts: ["integrate"] })).toStartWith(`refused: Did not land anything: ${INTEGRATE} is the integration Rift`)
    const bare = bench(MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x"), MemoryRifts.clean(OTHER, undefined)]))
    expect(await call(bare, { action: "land", rifts: ["feat-x"] })).toStartWith(`refused: The repository of ${SOURCE} names no gate, so land will not push. Set it in the warm source's Git config: git -C ${SOURCE} config rift.gate`)
    expect(await call(bare, { action: "land", rifts: ["feat-y"] })).toBe(`refused: Did not land anything: ${OTHER} is not on a Git branch.`)
    expect(await call(bare, { action: "land", rifts: [SOURCE] })).toBe(`refused: Did not land anything: ${SOURCE} is a warm source; land a Rift made from one.`)
    expect([...made.landing.steps, ...bare.landing.steps]).toEqual([])
    expect(bare.rifts.rifts.has(INTEGRATE)).toBe(false)
  })
})

describe("the workbox's commands", () => {
  test("run workrift as they are on the workbox: refresh and check of the session's source, deps in a Rift, prune as a dry run, init with its repository", async () => {
    const made = bench(MemoryRifts.world([SOURCE], [MemoryRifts.clean(FEAT, "feat/x")]), MemoryLanding.world(), true)
    const answers = await calls(made, [
      { action: "refresh" },
      { action: "check" },
      { action: "deps", name: "feat-x" },
      { action: "deps" },
      { action: "sources" },
      { action: "prune" },
      { action: "storage" },
      { action: "init", repository: "git@github.com:o/r.git", path: "../r" },
      { action: "init" },
    ])
    expect(answers).toEqual([
      `workrift refresh of ${SOURCE}:\nran refresh in /code/app/src for ${SOURCE}`,
      `workrift check of ${SOURCE}:\nran check in /code/app/src for ${SOURCE}`,
      `workrift deps in ${FEAT}:\nran deps in ${FEAT}`,
      "workrift deps in /code/app/src:\nran deps in /code/app/src",
      "workrift sources:\nran sources in /code/app/src",
      "workrift prune --dry-run:\nran prune in /code/app/src",
      "workbox-rift-storage --check:\nran storage in /code/app/src",
      "workrift init git@github.com:o/r.git /code/app/r:\nran init in /code/app/src",
      'refused: init needs the repository to clone: { action: "init", repository: "git@github.com:owner/repo.git", path? }.',
    ])
    expect(made.workbox.at(-1)?.command).toEqual({ _tag: "init", repository: "git@github.com:o/r.git", path: "/code/app/r" })
  })

  test("say they need the workbox where there is no workrift", async () => {
    expect(await call(MemoryRifts.world([SOURCE]), { action: "refresh" })).toBe(
      "refused: refresh runs the workbox's workrift, which this machine does not have. Here the rift tool offers create, list, remove and land.",
    )
  })
})
