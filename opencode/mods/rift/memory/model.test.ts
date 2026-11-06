// The handler (../model.ts) over Rifts in memory: what each action does to
// the Rifts and what the model reads back. It sits here because the domain
// fence keeps the root's files off its folders.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as MemoryRifts from "./rifts.ts"
import * as MemorySessionDirectories from "./session-directories.ts"
import * as Model from "../model.ts"
import { explainInput, workspaceName, type RiftInput } from "../rift.ts"
import { explainRefusal } from "../workspace.ts"

const SOURCE = "/code/app"
const FEAT = "/code/.rifts/app/feat-x"

const make = (state: MemoryRifts.World, sessions: Record<string, string> = { ses_1: "/code/app/src", ses_in: `${FEAT}/src` }) =>
  Model.layer.pipe(Layer.provide(Layer.mergeAll(MemoryRifts.layer(state), MemorySessionDirectories.layer(sessions))))

/** One call's answer text, or the words of its failure. */
const call = (state: MemoryRifts.World, input: RiftInput, sessionID = "ses_1") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tool = yield* Model.RiftTool
      return yield* tool.run(sessionID, input).pipe(
        Effect.map((answer) => answer.text),
        Effect.catchTags({
          BranchMissing: (refusal) => Effect.succeed(`refused: ${explainInput(refusal)}`),
          TargetMissing: (refusal) => Effect.succeed(`refused: ${explainInput(refusal)}`),
          NoSuchRift: (refusal) => Effect.succeed(`refused: ${explainInput(refusal)}`),
          SourceKept: (refusal) => Effect.succeed(`refused: ${explainRefusal(refusal)}`),
          SessionInside: (refusal) => Effect.succeed(`refused: ${explainRefusal(refusal)}`),
          ChildrenKept: (refusal) => Effect.succeed(`refused: ${explainRefusal(refusal)}`),
          WorkUnsaved: (refusal) => Effect.succeed(`refused: ${explainRefusal(refusal)}`),
          RiftFailed: (failure) => Effect.succeed(`failed: ${Model.failureText(failure)}`),
          SessionUnreadable: (failure) => Effect.succeed(`failed: ${Model.failureText(failure)}`),
        }),
      )
    }).pipe(Effect.provide(make(state))),
  )

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
})
