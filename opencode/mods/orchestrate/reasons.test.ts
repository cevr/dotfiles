// A reason's shared type and its checks (reasons.ts): the public payload decoded to a closed union and encoded once to
// its canonical pointer, decoded strictly back; the kinds not shipped refused by name; and the evidence reader on real
// files, paths and git: a receipt envelope read and hashed inside the checkout's evidence root once every link is
// resolved, refused for any other shape, place or size, and a declared document found in git at HEAD.
import { describe, expect, test } from "bun:test"
import { spawnSync, write } from "bun"
import { symlinkSync } from "node:fs"
import { Effect, Layer, Option, Result } from "effect"
import { Digest } from "effect/crypto"
import * as Seed from "../../sim/seed.ts"
import { hostServices } from "../../sim/host-services.ts"
import { gitInit, withProcessEnv } from "../../tests/git-repo.ts"
import { scratch } from "../../tests/scratch.ts"
import { platform as ownPlatform } from "./node/platform.ts"
import { EVIDENCE_ROOT, evidenceLayer, pointerOf, RECEIPT_MAX, type Referent, type ReferentInput, reasonFrom, referentOf } from "./reasons.ts"
import { Evidence } from "./service.ts"

const why = <A>(result: Result.Result<A, string>) => Result.match(result, { onFailure: (reason) => reason, onSuccess: () => "taken" })

describe("the reason payload", () => {
  test("each class takes its kinds; a kind not shipped is refused naming the unit that brings it", () => {
    const cases: ReadonlyArray<readonly ["guarantee" | "dependency" | "measured", ReferentInput, string]> = [
      ["guarantee", { kind: "invariant", id: "one-writer" }, "taken"],
      ["guarantee", { kind: "spec-item", id: "s1" }, "a spec-item referent is not available yet: it ships with spec-items (unit C)"],
      ["guarantee", { kind: "commitment", id: "a" }, "a guarantee reason takes a referent of kind invariant or spec-item; commitment is not one"],
      ["dependency", { kind: "commitment", id: "a" }, "taken"],
      ["dependency", { kind: "unit", id: "u1" }, "a unit referent is not available yet: it ships with hand-back-tools (unit D)"],
      ["dependency", { kind: "owner-question", id: "q1" }, "a owner-question referent is not available yet: it ships with hand-back-tools and question-reasons (units D, E)"],
      ["dependency", { kind: "receipt", path: `${EVIDENCE_ROOT}/r/x.json` }, "a dependency reason takes a referent of kind commitment or unit or owner-question; receipt is not one"],
      ["measured", { kind: "receipt", path: `${EVIDENCE_ROOT}/r/x.json` }, "taken"],
      ["measured", { kind: "invariant", id: "x" }, "a measured reason takes a referent of kind receipt; invariant is not one"],
    ]
    expect(cases.map(([reasonClass, referent]) => why(reasonFrom(reasonClass, referent)))).toEqual(cases.map(([, , expected]) => expected))
  })

  test("an id is a slug and a receipt a normalised path under the evidence root; neither is repeated in a refusal", () => {
    const refusals = [
      reasonFrom("dependency", { kind: "commitment", id: "has space" }),
      reasonFrom("dependency", { kind: "commitment", id: "" }),
      reasonFrom("measured", { kind: "receipt", path: "elsewhere/x.json" }),
      reasonFrom("measured", { kind: "receipt", path: `${EVIDENCE_ROOT}/../x.json` }),
      reasonFrom("measured", { kind: "receipt", path: `${EVIDENCE_ROOT}/./x.json` }),
      reasonFrom("measured", { kind: "receipt", path: `/${EVIDENCE_ROOT}/x.json` }),
      reasonFrom("measured", { kind: "receipt", path: `${EVIDENCE_ROOT}//x.json` }),
      reasonFrom("measured", { kind: "receipt", path: `${EVIDENCE_ROOT}/${"x".repeat(600)}` }),
    ].map(why)
    expect(refusals.filter((each) => each === "taken")).toEqual([])
    expect(refusals.filter((each) => each.includes("has space") || each.includes(`${EVIDENCE_ROOT}/..`) || each.includes("xxxx"))).toEqual([])
  })

  test("the pointer is encoded once and decoded strictly: every taken referent round-trips, anything else decodes to none", () => {
    const referents: ReadonlyArray<Referent> = [
      { kind: "invariant", id: "one-writer" },
      { kind: "commitment", id: "a.b_c-1" },
      { kind: "receipt", path: `${EVIDENCE_ROOT}/run-1/check.json` },
    ]
    expect(referents.map((each) => referentOf(pointerOf(each)))).toEqual(referents.map(Option.some))
    expect(referents.map(pointerOf)).toEqual(["invariant/one-writer", "commitment/a.b_c-1", `receipt/${EVIDENCE_ROOT}/run-1/check.json`])
    const malformed = ["", "invariant/", "invariant/has space", "nothing/x", "ask/q1", " invariant/x", "commitment/a/b", "receipt/elsewhere/x", `receipt/${EVIDENCE_ROOT}/../x`, `invariant/${"x".repeat(600)}`]
    expect(malformed.map(referentOf)).toEqual(malformed.map(() => Option.none()))
  })
})

// ── The evidence reader on real files ──

const env = withProcessEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" })
const git = (dir: string, args: ReadonlyArray<string>) => spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()
const HEAD = "a".repeat(40)
const envelope = (fields: Record<string, unknown> = {}) => JSON.stringify({ receipt: 1, command: "bun test mods/orchestrate", exit: 0, output: { value: "12 pass, 0 fail" }, run: "r1", checkout: HEAD, ...fields })

/** A checkout with a committed document and its evidence root, the reader over it; every case's outcome, in words. */
const reader = Effect.acquireUseRelease(
  Effect.sync(() => scratch("reasons-")),
  (dir) =>
    Effect.gen(function* () {
      const checkout = `${dir.path}/repo`
      const root = `${checkout}/${EVIDENCE_ROOT}`
      const files: Record<string, string> = {
        "docs/record.md": "# One writer\n",
        "docs/uncommitted.md": "later\n",
        [`${EVIDENCE_ROOT}/r1/value.json`]: envelope(),
        [`${EVIDENCE_ROOT}/r1/file.json`]: envelope({ output: { path: `${EVIDENCE_ROOT}/r1/out.log` } }),
        [`${EVIDENCE_ROOT}/r1/out.log`]: "all green\n",
        [`${EVIDENCE_ROOT}/r1/outside-out.json`]: envelope({ output: { path: "docs/record.md" } }),
        [`${EVIDENCE_ROOT}/r1/escape-out.json`]: envelope({ output: { path: `${EVIDENCE_ROOT}/r1/out-link.log` } }),
        [`${EVIDENCE_ROOT}/r1/missing-out.json`]: envelope({ output: { path: `${EVIDENCE_ROOT}/r1/nope.log` } }),
        [`${EVIDENCE_ROOT}/r1/validated.json`]: envelope({ validated: true }),
        [`${EVIDENCE_ROOT}/r1/prose.json`]: JSON.stringify({ receipt: 1, note: "trust me, it passed" }),
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
      symlinkSync(`${checkout}/outside.json`, `${root}/r1/escape.json`)
      symlinkSync(`${root}/r1`, `${root}/linked`)
      symlinkSync(`${checkout}/docs/record.md`, `${root}/r1/out-link.log`)
      const evidence = yield* Evidence
      const receipt = (path: string) =>
        Effect.match(evidence.receipt(checkout, path), { onFailure: (refused) => refused.reason, onSuccess: (seen) => `${seen.exit} ${seen.run} ${seen.receiptSha.length}/${seen.outputSha.length}` })
      const receipts = yield* Effect.forEach(
        ["value", "file", "linked-value", "outside-out", "escape-out", "missing-out", "validated", "prose", "blank-command", "blank-output", "bad-run", "bad-checkout", "large", "escape", "dir", "nope"],
        (name) =>
          Effect.map(
            receipt(name === "linked-value" ? `${EVIDENCE_ROOT}/linked/value.json` : name === "dir" ? `${EVIDENCE_ROOT}/r1` : `${EVIDENCE_ROOT}/r1/${name}.json`),
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
