// The handler (../model.ts) over Rifts in memory: what each action does to
// the Rifts and what the model reads back. It sits here because the domain
// fence keeps the root's files off its folders.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
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

/** The answer text of each call in turn, or the words of its failure (`refused: …`), within one tool's life. */
const calls = (made: Bench | MemoryRifts.World, inputs: ReadonlyArray<RiftInput>, sessionID = "ses_1") =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tool = yield* Model.RiftTool
        const answers: Array<string> = []
        for (const input of inputs)
          answers.push(
            yield* tool.run(sessionID, input).pipe(
              Effect.map((answer) => answer.text),
              Effect.catch((failure) => Effect.succeed(`${failure._tag === "RiftFailed" || failure._tag === "SessionUnreadable" ? "failed" : "refused"}: ${Model.explain(failure)}`)),
            ),
          )
        // The background accept checks finish before the tool goes.
        yield* Effect.sleep("20 millis")
        return answers
      }).pipe(Effect.provide(make("sources" in made ? bench(made) : made))),
    ),
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
})

describe("land", () => {
  const OTHER = "/code/.rifts/app/feat-y"
  const INTEGRATE = "/code/.rifts/app/integrate"
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
        "Installed again and committed: opencode/bun.lock, opencode/mods/orchestrate/agents.json.",
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
