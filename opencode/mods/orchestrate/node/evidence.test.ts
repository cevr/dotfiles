// The evidence reader (reasons.ts `evidenceLayer`) on real files, paths and git, through the host's platform services:
// a receipt envelope read and hashed inside the checkout's evidence root once every link is resolved, refused for any
// other shape, place or size, and a declared document found in git at HEAD. Here, beside the platform binding, because
// the orchestrate domain fence keeps node:*, bun and the test helpers out of the root's files and their tests.
import { expect } from "bun:test"
import { spawnSync, write } from "bun"
import { Effect, FileSystem, Layer, Match, Ref, Schema } from "effect"
import { Digest } from "effect/crypto"
import * as Seed from "../../../sim/seed.ts"
import { hostServices } from "../../../sim/host-services.ts"
import { gitInit, withProcessEnv } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import { platform as ownPlatform } from "./platform.ts"
import { EVIDENCE_ROOT, evidenceLayer, RECEIPT_MAX } from "../reasons.ts"
import { Evidence } from "../service.ts"

const env = withProcessEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" })
const git = (dir: string, args: ReadonlyArray<string>) => spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()
const HEAD = "a".repeat(40)
type Json = typeof Schema.Json.Type
const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const envelope = (fields: { readonly [field: string]: Json } = {}) => jsonOf({ receipt: 1, command: "bun test mods/orchestrate", exit: 0, output: { value: "12 pass, 0 fail" }, run: "r1", checkout: HEAD, ...fields })

/** A checkout with a committed document and its evidence root, the reader over it; every case's outcome, in words. */
const reader = Effect.acquireUseRelease(
  Effect.sync(() => scratch("reasons-")),
  (dir) =>
    Effect.gen(function* () {
      const checkout = `${dir.path}/repo`
      const root = `${checkout}/${EVIDENCE_ROOT}`
      const files = {
        "docs/record.md": "# One writer\n",
        "docs/uncommitted.md": "later\n",
        [`${EVIDENCE_ROOT}/r1/value.json`]: envelope(),
        [`${EVIDENCE_ROOT}/r1/file.json`]: envelope({ output: { path: `${EVIDENCE_ROOT}/r1/out.log` } }),
        [`${EVIDENCE_ROOT}/r1/out.log`]: "all green\n",
        [`${EVIDENCE_ROOT}/r1/outside-out.json`]: envelope({ output: { path: "docs/record.md" } }),
        [`${EVIDENCE_ROOT}/r1/escape-out.json`]: envelope({ output: { path: `${EVIDENCE_ROOT}/r1/out-link.log` } }),
        [`${EVIDENCE_ROOT}/r1/missing-out.json`]: envelope({ output: { path: `${EVIDENCE_ROOT}/r1/nope.log` } }),
        [`${EVIDENCE_ROOT}/r1/validated.json`]: envelope({ validated: true }),
        [`${EVIDENCE_ROOT}/r1/prose.json`]: jsonOf({ receipt: 1, note: "trust me, it passed" }),
        [`${EVIDENCE_ROOT}/r1/blank-command.json`]: envelope({ command: "  " }),
        [`${EVIDENCE_ROOT}/r1/blank-output.json`]: envelope({ output: { value: "" } }),
        [`${EVIDENCE_ROOT}/r1/bad-run.json`]: envelope({ run: "has space" }),
        [`${EVIDENCE_ROOT}/r1/bad-checkout.json`]: envelope({ checkout: "main" }),
        [`${EVIDENCE_ROOT}/r1/large.json`]: envelope({ command: "x".repeat(RECEIPT_MAX) }),
        "outside.json": envelope(),
      }
      for (const [path, text] of Object.entries(files)) yield* Effect.promise(() => write(`${checkout}/${path}`, text))
      gitInit(checkout, ["-q", "-b", "main"], env)
      git(checkout, ["add", "docs/record.md"])
      git(checkout, ["commit", "-q", "-m", "docs"])
      const fs = yield* FileSystem.FileSystem
      yield* fs.symlink(`${checkout}/outside.json`, `${root}/r1/escape.json`)
      yield* fs.symlink(`${root}/r1`, `${root}/linked`)
      yield* fs.symlink(`${checkout}/docs/record.md`, `${root}/r1/out-link.log`)
      const evidence = yield* Evidence
      const receipt = (path: string) =>
        Effect.match(evidence.receipt(checkout, path), { onFailure: (refused) => refused.reason, onSuccess: (seen) => `${seen.exit} ${seen.run} ${seen.receiptSha.length}/${seen.outputSha.length}` })
      const receipts = yield* Effect.forEach(
        ["value", "file", "linked-value", "outside-out", "escape-out", "missing-out", "validated", "prose", "blank-command", "blank-output", "bad-run", "bad-checkout", "large", "escape", "dir", "nope", "not-under"],
        (name) =>
          Effect.map(
            receipt(
              Match.value(name).pipe(
                Match.when("not-under", () => "outside.json"),
                Match.when("linked-value", () => `${EVIDENCE_ROOT}/linked/value.json`),
                Match.when("dir", () => `${EVIDENCE_ROOT}/r1`),
                Match.orElse(() => `${EVIDENCE_ROOT}/r1/${name}.json`),
              ),
            ),
            (outcome) => [name, outcome] as const,
          ),
      )
      const outputSha = yield* Effect.map(evidence.receipt(checkout, `${EVIDENCE_ROOT}/r1/file.json`), (seen) => seen.outputSha)
      const expectedSha = yield* (yield* Digest.Digest).digestHex(Digest.sha256, new TextEncoder().encode("all green\n"))
      const document = (path: string) => Effect.match(evidence.document(checkout, path), { onFailure: (refused) => refused.reason, onSuccess: (seen) => [seen.path, seen.blob, seen.commit].join(" ") })
      const documents = yield* Effect.forEach(["docs/record.md", "docs/uncommitted.md", "docs/none.md", "../outside.md", "docs"], document)
      return { receipts, outputSha, expectedSha, documents, blob: git(checkout, ["rev-parse", "HEAD:docs/record.md"]), head: git(checkout, ["rev-parse", "HEAD"]) }
    }),
  (dir) => Effect.sync(() => dir[Symbol.dispose]()),
)

Seed.effect(
  "the reader takes a version 1 envelope inside the evidence root, hashed with its output; refuses any other shape, place, link out or size; finds a document only in git at HEAD",
  Effect.gen(function* () {
    const seen = yield* reader
    expect(seen.receipts).toEqual([
      ["value", "0 r1 64/64"],
      ["file", "0 r1 64/64"],
      // A link inside the root to a file inside it is the file.
      ["linked-value", "0 r1 64/64"],
      ["outside-out", "the receipt's output path is not under tmp/orchestrate/"],
      ["escape-out", "the receipt's output file resolves outside its root"],
      ["missing-out", "the receipt's output file does not exist"],
      ["validated", "the receipt is not a version 1 receipt envelope (receipt, command, exit, output, run, checkout; nothing else)"],
      ["prose", "the receipt is not a version 1 receipt envelope (receipt, command, exit, output, run, checkout; nothing else)"],
      ["blank-command", "the receipt's command is not one line of at most 500 characters that says something"],
      ["blank-output", "the receipt's output value is not one line of at most 200 characters that says something"],
      ["bad-run", "the receipt's run is not a slug"],
      ["bad-checkout", "the receipt's checkout is not a commit (7 to 40 lowercase hex digits)"],
      ["large", `the receipt is larger than ${RECEIPT_MAX} bytes`],
      ["escape", "the receipt resolves outside its root"],
      ["dir", "the receipt is not a regular file"],
      ["nope", "the receipt does not exist"],
      // The reader is a port of its own: a path a caller did not check first is refused by its place, not read.
      ["not-under", "the receipt is not under tmp/orchestrate/"],
    ])
    expect(seen.outputSha).toBe(seen.expectedSha)
    expect(seen.documents).toEqual([
      `docs/record.md ${seen.blob} ${seen.head}`,
      "the document is not in git at HEAD: commit it, then declare the invariant",
      "the document does not exist",
      'the document\'s path is not a checkout-relative path (segments of letters, digits, ".", "_", "-"; no "." or ".." segment)',
      "the document is not a regular file",
    ])
  }).pipe(Effect.provide(evidenceLayer.pipe(Layer.provideMerge(Layer.mergeAll(hostServices, ownPlatform))))),
)

// ── Where a link may sit: the approved root is configured, never discovered through a link ──

/**
 * Each placement of a link, and where it points: inside the approved root, elsewhere inside the checkout, or out of it.
 * `above` puts the link over the checkout itself (the caller names the checkout through it, as macOS's /var); `root`
 * makes `tmp/orchestrate` the link; `tmp` makes its parent one; `below` a folder under the root; `file` the receipt; and
 * `output` the receipt's output file.
 */
const PLACEMENTS = ["above", "root", "tmp", "below", "file", "output"] as const
const TARGETS = ["in-root", "in-checkout", "outside"] as const
type Placement = (typeof PLACEMENTS)[number]
type Target = (typeof TARGETS)[number]

/** The one rule: a link above the checkout is resolved once and fine; the root and its parents are never links; under the root a link may point only inside it. */
const takenOf = (placement: Placement, target: Target): boolean =>
  Match.value(placement).pipe(
    Match.when("above", () => true),
    Match.whenOr("root", "tmp", () => false),
    Match.orElse(() => target === "in-root"),
  )

/**
 * A fresh checkout with a link at `placement` pointing at `target` (each target holds the same valid files), and the
 * reader's answer for `tmp/orchestrate/r1/proof.json`: "taken" or its refusal.
 */
const placed = (placement: Placement, target: Target) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("evidence-links-")),
    (dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const real = `${dir.path}/real`
        const checkout = `${real}/repo`
        const elsewhere = Match.value(target).pipe(
          Match.when("in-root", () => `${checkout}/${EVIDENCE_ROOT}/kept`),
          Match.when("in-checkout", () => `${checkout}/docs/kept`),
          Match.orElse(() => `${dir.path}/outside/kept`),
        )
        const proof = envelope({ output: { path: `${EVIDENCE_ROOT}/r1/out.log` } })
        // The same valid files at the target, and (unless a link replaces it) in place.
        for (const [path, text] of [["proof.json", proof], ["out.log", "all green\n"], ["r1/proof.json", proof], ["r1/out.log", "all green\n"], ["orchestrate/r1/proof.json", proof], ["orchestrate/r1/out.log", "all green\n"]] as const)
          yield* Effect.promise(() => write(`${elsewhere}/${path}`, text))
        yield* Effect.promise(() => write(`${checkout}/docs/record.md`, "# One writer\n"))
        gitInit(checkout, ["-q", "-b", "main"], env)
        const inRoot = `${checkout}/${EVIDENCE_ROOT}`
        yield* Match.value(placement).pipe(
          Match.when("root", () => fs.makeDirectory(`${checkout}/tmp`, { recursive: true }).pipe(Effect.andThen(fs.symlink(`${elsewhere}/orchestrate`, inRoot)))),
          Match.when("tmp", () => fs.symlink(elsewhere, `${checkout}/tmp`)),
          Match.when("below", () => fs.makeDirectory(inRoot, { recursive: true }).pipe(Effect.andThen(fs.symlink(`${elsewhere}/r1`, `${inRoot}/r1`)))),
          Match.when("file", () =>
            Effect.promise(() => write(`${inRoot}/r1/out.log`, "all green\n")).pipe(Effect.andThen(fs.symlink(`${elsewhere}/proof.json`, `${inRoot}/r1/proof.json`))),
          ),
          Match.when("output", () =>
            Effect.promise(() => write(`${inRoot}/r1/proof.json`, proof)).pipe(Effect.andThen(fs.symlink(`${elsewhere}/out.log`, `${inRoot}/r1/out.log`))),
          ),
          Match.orElse(() =>
            Effect.promise(() => write(`${inRoot}/r1/proof.json`, proof)).pipe(
              Effect.andThen(Effect.promise(() => write(`${inRoot}/r1/out.log`, "all green\n"))),
              Effect.andThen(fs.symlink(real, `${dir.path}/alias`)),
            ),
          ),
        )
        const named = Match.value(placement).pipe(Match.when("above", () => `${dir.path}/alias/repo`), Match.orElse(() => checkout))
        const evidence = yield* Evidence
        return yield* Effect.match(evidence.receipt(named, `${EVIDENCE_ROOT}/r1/proof.json`), { onFailure: (refused) => refused.reason, onSuccess: () => "taken" })
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  )

Seed.effect(
  "a receipt is read only inside the configured root: a link above the checkout is fine, the root or its parent as a link is refused, a link under it only inward",
  Effect.gen(function* () {
    // A link at the root or its parent pointing inside the root is no placement: the root would hold itself.
    const cases = PLACEMENTS.flatMap((placement) => TARGETS.map((target) => [placement, target] as const)).filter(([placement, target]) => !((placement === "root" || placement === "tmp") && target === "in-root"))
    const answers = yield* Effect.forEach(cases, ([placement, target]) => Effect.map(placed(placement, target), (answer) => [placement, target, answer] as const))
    expect(answers.map(([placement, target, answer]) => [placement, target, answer === "taken"])).toEqual(cases.map(([placement, target]) => [placement, target, takenOf(placement, target)]))
    // Each refusal names the rule it broke, never the place a link points.
    expect([...new Set(answers.filter(([, , answer]) => answer !== "taken").map(([, , answer]) => answer))].toSorted()).toEqual([
      "the checkout's tmp/orchestrate/ is reached through a link: it is not an approved root",
      "the receipt resolves outside its root",
      "the receipt's output file resolves outside its root",
    ])
  }).pipe(Effect.provide(evidenceLayer.pipe(Layer.provideMerge(Layer.mergeAll(hostServices, ownPlatform))))),
)

Seed.effect(
  "the root swapped for a link after the reader was made, between two reads, is refused: the reader holds no resolved root",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("evidence-swap-")),
    (dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const checkout = `${dir.path}/repo`
        for (const base of [`${checkout}/${EVIDENCE_ROOT}`, `${dir.path}/outside/orchestrate`]) yield* Effect.promise(() => write(`${base}/r1/proof.json`, envelope()))
        gitInit(checkout, ["-q", "-b", "main"], env)
        const evidence = yield* Evidence
        const read = Effect.match(evidence.receipt(checkout, `${EVIDENCE_ROOT}/r1/proof.json`), { onFailure: (refused) => refused.reason, onSuccess: () => "taken" })
        const before = yield* read
        yield* fs.remove(`${checkout}/${EVIDENCE_ROOT}`, { recursive: true })
        yield* fs.symlink(`${dir.path}/outside/orchestrate`, `${checkout}/${EVIDENCE_ROOT}`)
        expect([before, yield* read]).toEqual(["taken", "the checkout's tmp/orchestrate/ is reached through a link: it is not an approved root"])
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ).pipe(Effect.provide(evidenceLayer.pipe(Layer.provideMerge(Layer.mergeAll(hostServices, ownPlatform))))),
)

/**
 * A host whose first read of a `r1/proof.json` swaps its folder `r1` for a link to the sibling `r2` before it reads:
 * the swap lands between the reader's check of the receipt and its read, where the check before the read cannot see it.
 */
const swappedDuringRead = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const done = yield* Ref.make(false)
    const swap = (path: string) =>
      Effect.gen(function* () {
        const folder = path.slice(0, -"/proof.json".length)
        yield* fs.remove(folder, { recursive: true })
        yield* fs.symlink(`${folder.slice(0, -"r1".length)}r2`, folder)
      }).pipe(Effect.orDie)
    const first = (path: string) => Effect.map(Ref.getAndSet(done, true), (was) => !was && path.endsWith("/r1/proof.json"))
    return { ...fs, readFile: (path: string) => Effect.andThen(Effect.when(swap(path), first(path)), fs.readFile(path)) }
  }),
)

Seed.effect(
  "a receipt's folder swapped for a link during its read is refused as moved: the reader checks again after it reads",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("evidence-read-swap-")),
    (dir) =>
      Effect.gen(function* () {
        const checkout = `${dir.path}/repo`
        const root = `${checkout}/${EVIDENCE_ROOT}`
        for (const run of ["r1", "r2"]) yield* Effect.promise(() => write(`${root}/${run}/proof.json`, envelope({ run })))
        gitInit(checkout, ["-q", "-b", "main"], env)
        const read = Effect.gen(function* () {
          const evidence = yield* Evidence
          return yield* Effect.match(evidence.receipt(checkout, `${EVIDENCE_ROOT}/r1/proof.json`), { onFailure: (refused) => refused.reason, onSuccess: (seen) => `taken ${seen.run}` })
        })
        const swapped = yield* read
        // Once swapped, r1 is a link inside the root to r2: a second read through it (no swap now) takes r2's
        // receipt, so the refusal above is the check after the read, not one a link before the read meets.
        const after = yield* read
        expect([swapped, after]).toEqual(["the receipt moved while it was read", "taken r2"])
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ).pipe(Effect.provide(evidenceLayer.pipe(Layer.provide(swappedDuringRead), Layer.provideMerge(Layer.mergeAll(hostServices, ownPlatform))))),
)
