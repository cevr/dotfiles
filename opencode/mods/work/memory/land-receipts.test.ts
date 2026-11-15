// A pushed land by receipts (`rift.mergeCheck`), over the memory services: each Rift's current round
// receipt is taken, a Rift without one runs its focused gate in the land, the merged tree runs one merge
// check, nothing runs the full gate, and what the land took and ran is recorded. A red check stops the
// push; the accept check runs in a Rift of its own, so the next land never waits for it or a post-land step.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Match, Option, Predicate } from "effect"
import * as MemoryDebts from "./debts.ts"
import * as MemoryLanding from "./landing.ts"
import * as MemoryNotices from "./notices.ts"
import * as MemoryRifts from "./rifts.ts"
import * as MemorySessionDirectories from "./session-directories.ts"
import * as MemoryWorkbox from "./workbox.ts"
import * as Model from "../model.ts"
import { ACCEPT_APART, RECEIPT_CLI } from "../land.ts"
import { Standing } from "../receipt.ts"
import type { RiftInput } from "../rift.ts"

const SOURCE = "/code/app"
const X = "/code/.rifts/app/feat-x"
const Y = "/code/.rifts/app/feat-y"
const INTEGRATE = "/code/.rifts/app/integrate"
const ACCEPT = "/code/.rifts/app/land-accept"
const POST_LAND = "/code/.rifts/app/post-land"
const MERGE_CHECK = 'bun scripts/gate.ts --merge "$RIFT_LAND_BASE"'

interface Bench {
  readonly rifts: MemoryRifts.World
  readonly landing: MemoryLanding.World
  readonly woken: Array<MemoryNotices.Woken>
  readonly debts: MemoryDebts.World
}

/** Two Rifts of the source, `feat/x` and `feat/y`, and a source that lands by receipts with `options`. */
const bench = (options: Parameters<typeof MemoryLanding.config>[3] = {}, accepting = true): Bench => ({
  rifts: MemoryRifts.world([SOURCE], [MemoryRifts.clean(X, "feat/x"), MemoryRifts.clean(Y, "feat/y")]),
  landing: MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", Option.getOrUndefined(Option.liftPredicate("bun run accept", () => accepting)), { mergeCheck: MERGE_CHECK, ...options }) }),
  woken: [],
  debts: MemoryDebts.world(),
})

/** The Rift at `path` holds a green round receipt for its head now. */
const receipted = (made: Bench, path: string, head: string) => {
  made.landing.heads.set(path, head)
  made.landing.standings.set(path, Standing.Current({ receipt: MemoryLanding.receiptOf(path, head) }))
}

const layer = (made: Bench) =>
  Model.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        MemoryRifts.layer(made.rifts),
        MemorySessionDirectories.layer({ ses_1: `${SOURCE}/src` }),
        MemoryLanding.layer(made.landing),
        MemoryNotices.layer(made.woken),
        MemoryWorkbox.layer(false, []),
        MemoryDebts.layer(made.debts),
      ),
    ),
  )

/** Lets the tool's background work run as far as it can. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }))

/** `body` over one tool's life in the bench's world. */
const within = <A>(made: Bench, body: (tool: typeof Model.RiftTool.Service) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(Model.RiftTool, body).pipe(Effect.provide(layer(made)))))

/** One call's answer, or the words of its failure. */
const answerOf = (tool: typeof Model.RiftTool.Service, input: RiftInput) =>
  tool.run("ses_1", input).pipe(
    Effect.map((answer) => answer.text),
    Effect.catch((failure) => Effect.succeed(`${Match.value(Predicate.isTagged(failure, "RiftFailed")).pipe(Match.when(true, () => "failed"), Match.orElse(() => "refused"))}: ${Model.explain(failure)}`)),
  )

/** `body` over one tool's life, then `check` of its answer. */
const expecting = <A>(made: Bench, body: (tool: typeof Model.RiftTool.Service) => Effect.Effect<A>, check: (answer: A) => void) =>
  within(made, (tool) => Effect.tap(body(tool), (answer) => Effect.sync(() => check(answer))))

/** One land of `rifts` and its background work, as far as it runs, then `check` of its answer. */
const landOnce = (made: Bench, rifts: ReadonlyArray<string>, check: (answer: string) => void) =>
  expecting(made, (tool) => Effect.tap(answerOf(tool, { action: "land", rifts: [...rifts] }), () => settle), check)

const RECEIPT_AT = "2026-11-13T12:00:00.000Z"

describe("a land by receipts", () => {
  test("two Rifts with receipts land with only the merge check run, their receipts and the check recorded, and no full gate", () => {
    const made = bench()
    receipted(made, X, "aaa111")
    receipted(made, Y, "bbb222")
    return landOnce(made, ["feat-x", "feat-y"], (answer) => {
      expect(answer).toBe(
        [
          "Landed 2 Rift(s) as one push: abc1234 Merge into main to main (merged feat/x, feat/y; by their receipts, no full gate).",
          `  feat/x: its receipt: 1 check(s) green at aaa111 (${RECEIPT_AT})`,
          `  feat/y: its receipt: 1 check(s) green at bbb222 (${RECEIPT_AT})`,
          "The merge check passed in 3s; log: /logs/merge.log",
          "Receipts recorded: /logs/receipts/head-integrate.land.json",
          `To the trash: ${X}, ${Y}.`,
          "The accept check runs in the background in its own Rift (land-accept) on the batch since base0; this session is woken with its result. The next land need not wait for it.",
        ].join("\n"),
      )
      expect(made.landing.steps).toEqual([
        "load",
        `standing ${X}`,
        `standing ${Y}`,
        `start ${INTEGRATE} main`,
        "merge feat/x",
        "merge feat/y",
        "install",
        `merge-check ${INTEGRATE} base0`,
        `push ${INTEGRATE}`,
        "record head-integrate",
        `sync ${X}`,
        `sync ${Y}`,
        `start ${ACCEPT} main`,
        "install",
        `accept ${ACCEPT} base0`,
      ])
      expect(made.landing.steps.some((step) => step.startsWith("gate ") || step.startsWith("focus "))).toBe(false)
      const [record] = made.landing.records
      expect(record?.units.map((unit) => [unit.branch, unit.by, unit.receipt.head])).toEqual([
        ["feat/x", "held", "aaa111"],
        ["feat/y", "held", "bbb222"],
      ])
      expect(Option.map(record!.merge, (receipt) => [receipt.kind, receipt.repo, receipt.checks[0]?.command])).toEqual(Option.some(["merge", INTEGRATE, MERGE_CHECK]))
      expect(made.woken.map((woken) => woken.notice.description)).toEqual(["rift land · accept passed"])
    })
  })

  test("a Rift whose head moved after its receipt runs its focused gate (rift.focus, on the files it changed) in the land, and only that; the other's receipt is taken", () => {
    const made = bench({ focus: "bun run gate --focused --threads {threads} {paths}" })
    made.landing.heads.set(X, "aaa222")
    made.landing.standings.set(X, Standing.Moved({ receipt: MemoryLanding.receiptOf(X, "aaa111") }))
    receipted(made, Y, "bbb222")
    return landOnce(made, ["feat-x", "feat-y"], (answer) => {
      expect(answer).toContain(`  feat/x: its head moved since its receipt, so its focused gate ran in the land: 1 check(s) green at aaa222 (${RECEIPT_AT})`)
      expect(answer).toContain(`  feat/y: its receipt: 1 check(s) green at bbb222`)
      // The memory host has 8 cores: a quarter of them.
      expect(made.landing.steps.filter((step) => step.startsWith("focus "))).toEqual([`focus ${X} bun run gate --focused --threads 2 '${X}/changed.ts'`])
      expect(made.landing.steps.some((step) => step.startsWith("gate "))).toBe(false)
      expect(made.landing.records[0]?.units.map((unit) => unit.by)).toEqual(["moved", "held"])
      // Its new receipt is kept: the next land of it takes it.
      expect(made.landing.standings.get(X)?._tag).toBe("Current")
    })
  })

  test("with no rift.focus, a pushed land of a Rift without a current receipt stops before any merge: the full gate never runs for it", () => {
    const made = bench()
    receipted(made, X, "aaa111")
    made.landing.standings.set(Y, Standing.Red({ receipt: MemoryLanding.receiptOf(Y, "head-feat-y", "round", 1) }))
    return landOnce(made, ["feat-x", "feat-y"], (answer) => {
      expect(answer).toBe(
        `refused: The focused gate of ${Y} failed (it held no current receipt, so the land ran it); nothing was pushed. Fix it in the Rift and land again:\nits receipt is red, and the repository names no focused gate (rift.focus) for the land to run; the full gate never runs for a Rift. Write the receipt of its round's proof at its head (${RECEIPT_CLI}), or set rift.focus.`,
      )
      expect(made.landing.steps.some((step) => step.startsWith("focus ") || step.startsWith("gate ") || step.startsWith("merge "))).toBe(false)
    })
  })

  test("a checked land (rift.push false) by receipts: the merge check is its gate, a Rift without a receipt is red alone, and the full suite runs apart, holding no Rift", () => {
    const made = bench({ push: false })
    receipted(made, X, "aaa111")
    return expecting(
      made,
      (tool) =>
        Effect.gen(function* () {
          const never = yield* Deferred.make<void>()
          made.landing.checkHold.accept = Deferred.await(never)
          const answer = yield* answerOf(tool, { action: "land", rifts: ["feat-x", "feat-y"] })
          yield* settle
          return answer
        }),
      (answer) => {
        const lines = answer.split("\n")
        expect(lines).toContain("The gate passed in 3s.")
        expect(lines).toContain(`- feat/x (${X}): green`)
        expect(lines.find((line) => line.startsWith(`- feat/y (${Y}): red; no current receipt: it holds no receipt, and the repository names no focused gate`))).toBeDefined()
        expect(lines).toContain(`  feat/x: its receipt: 1 check(s) green at aaa111 (${RECEIPT_AT})`)
        expect(lines).toContain(ACCEPT_APART)
        // One Rift merged onto main: its receipt's head is not the merge's, so the merge check runs.
        expect(made.landing.steps).toEqual([
          "load",
          `standing ${X}`,
          `standing ${Y}`,
          `start ${INTEGRATE} main`,
          "merge feat/x",
          "install",
          `merge-check ${INTEGRATE} base0`,
          "record head-integrate",
          `start ${ACCEPT} main`,
          "install",
          `accept ${ACCEPT} base0`,
        ])
        expect(made.landing.pushes).toBe(0)
      },
    )
  })

  test("a red focused gate stops the land before any merge: nothing is pushed or trashed", () => {
    const made = bench({ focus: "bun run gate --focused {paths}" })
    receipted(made, X, "aaa111")
    made.landing.checks.set(`${Y} focus`, { code: 1, output: "1 fail\n(fail) feat y\n" })
    return landOnce(made, ["feat-x", "feat-y"], (answer) => {
      expect(answer).toBe(
        [
          `refused: The focused gate of ${Y} failed (it held no current receipt, so the land ran it); nothing was pushed. Fix it in the Rift and land again:`,
          "exit 1 in 3s; log: /logs/focus.log",
          "  1 fail",
          "  (fail) feat y",
        ].join("\n"),
      )
      expect(made.landing.steps.some((step) => step.startsWith("merge ") || step.startsWith("push "))).toBe(false)
      expect([...made.rifts.rifts.keys()].sort()).toEqual([INTEGRATE, X, Y].sort())
    })
  })

  test("a red merge check stops the push: main does not move, nothing is trashed or recorded", () => {
    const made = bench()
    receipted(made, X, "aaa111")
    receipted(made, Y, "bbb222")
    made.landing.checks.set(`${INTEGRATE} merge`, { code: 2, output: "error TS2322: no\n" })
    return landOnce(made, ["feat-x", "feat-y"], (answer) => {
      expect(answer).toBe(
        [
          `refused: The merge check failed on the merged batch in ${INTEGRATE}; nothing was pushed. Route each failure to the Rift whose diff it touches:`,
          "exit 2 in 3s; log: /logs/merge.log",
          "  error TS2322: no",
        ].join("\n"),
      )
      expect(made.landing.pushes).toBe(0)
      expect(made.landing.steps.some((step) => step.startsWith("push ") || step.startsWith("record ") || step.startsWith("accept "))).toBe(false)
      expect(made.landing.records).toEqual([])
      expect([...made.rifts.rifts.keys()].sort()).toEqual([INTEGRATE, X, Y].sort())
    })
  })

  test("one Rift the merge fast-forwarded to lands on its receipt alone: no merge check", () => {
    const made = bench({}, false)
    receipted(made, X, "aaa111")
    made.landing.heads.set(INTEGRATE, "aaa111")
    return landOnce(made, ["feat-x"], (answer) => {
      expect(answer).toBe(
        [
          "Landed 1 Rift(s) as one push: abc1234 Merge into main to main (merged feat/x; by their receipts, no full gate).",
          `  feat/x: its receipt: 1 check(s) green at aaa111 (${RECEIPT_AT})`,
          "No merge check: the land fast-forwarded to the one Rift's own checked head.",
          "Receipts recorded: /logs/receipts/aaa111.land.json",
          `To the trash: ${X}.`,
          "No rift.accept is configured, so no check runs after the push.",
        ].join("\n"),
      )
      expect(made.landing.steps.some((step) => step.startsWith("merge-check") || step.startsWith("gate "))).toBe(false)
      expect(made.landing.records[0]?.merge).toEqual(Option.none())
    })
  })

  /** A first land whose background run never ends (`hold`, on the bench), then a second land: its answer within 2 s, if any. */
  const behind = (made: Bench, hold: (made: Bench, never: Effect.Effect<void>) => void, running: string, check: (removed: string) => void) =>
    expecting(
      made,
      (tool) =>
        Effect.gen(function* () {
          const never = yield* Deferred.make<void>()
          hold(made, Deferred.await(never))
          expect(yield* answerOf(tool, { action: "land", rifts: ["feat-x"] })).toStartWith("Landed 1 Rift(s) as one push")
          yield* settle
          expect(made.landing.steps).toContain(running)
          const second = yield* answerOf(tool, { action: "land", rifts: ["feat-y"] }).pipe(Effect.timeoutOption("2 seconds"))
          expect(Option.map(second, (text) => text.split("\n")[0])).toEqual(Option.some("Landed 1 Rift(s) as one push: abc1234 Merge into main to main (merged feat/y; by their receipts, no full gate)."))
          return yield* answerOf(tool, { action: "remove", name: "land-accept", force: true })
        }),
      check,
    )

  test("a land while the last land's accept check still runs goes on at once, in the free integration Rift", () => {
    const made = bench({ postLand: "bun scripts/post-land.ts" })
    receipted(made, X, "aaa111")
    receipted(made, Y, "bbb222")
    return behind(made, (bench, never) => void (bench.landing.checkHold.accept = never), `accept ${ACCEPT} base0`, (removed) => {
      expect(removed).toBe(`refused: ${ACCEPT} is busy: the accept check of feat/x runs there. Remove it after its wake.`)
    })
  })

  test("a land while a post-land step (its deep run) still runs goes on at once", () => {
    const made = bench({ postLand: "bun scripts/post-land.ts" }, false)
    receipted(made, X, "aaa111")
    receipted(made, Y, "bbb222")
    return behind(made, (bench, never) => void (bench.landing.postLandHold = never), `post-land ${POST_LAND} base0 abc1234`, () => {
      expect(made.landing.steps.filter((step) => step.startsWith("push "))).toHaveLength(2)
    })
  })

  test("the accept check's Rift is no Rift to land", () => {
    const made = bench()
    made.rifts.rifts.set(ACCEPT, MemoryRifts.clean(ACCEPT, "land-accept"))
    return expecting(made, (tool) => answerOf(tool, { action: "land", rifts: [ACCEPT] }), (answer) => {
      expect(answer).toBe(`refused: Did not land anything: ${ACCEPT} is the Rift a land's accept check runs in; it holds no work to land.`)
    })
  })
})
