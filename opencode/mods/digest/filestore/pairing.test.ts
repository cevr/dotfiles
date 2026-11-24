// @reads all
// @reads-reason computed read at mods/digest/filestore/pairing.ts: const age = yield* Effect.promise(() => stat(lockPath).then(
// The pairing file:
// - A code is good once, for five minutes, and kept only as its hash.
// - The token it buys is kept only as its hash, so a forged, altered or foreign token is refused.
// - Reading the file gives nothing that pairs.
// - A token outlives a restart, and up to MAX_PAIRED browsers are paired at once.
// - A browser is revoked by its id, or all at once.
// - The file is 0600 and versioned; a file of an unknown version is an error that leaves it as it is.
// - Under concurrency: one code exchanged by many requests at once buys one token, and a burst of wrong codes is
//   compared at most SOURCE_FAILURES times. The limit is per address with a global ceiling and a floor, and in the
//   file, so it holds after a restart.
import { describe, expect, test } from "bun:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Array as Arr, Cause, Effect, Exit, Match, Option } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { CODE_TTL_MS, MAX_PAIRED, normalizeCode, PairingUnavailable, PairRefused, GLOBAL_FAILURES, RATE_WINDOW_MS, showCode, SOURCE_FAILURES } from "../pairing.ts"
import { FILE, make } from "./pairing.ts"

const T = Date.parse("2026-11-20T12:00:00Z")
const UA = "Mozilla/5.0 (invented test browser)"

/** Why `effect` failed: a refusal's reason, or the file's problem; "none" when it succeeded. */
const refusal = async <A, E>(effect: Effect.Effect<A, E>) =>
  Exit.match(await Effect.runPromise(Effect.exit(effect)), {
    onSuccess: () => "none",
    onFailure: (cause) =>
      Match.value(Cause.squash(cause)).pipe(
        Match.when(Match.instanceOf(PairRefused), (refused) => `reason:${refused.reason}`),
        Match.when(Match.instanceOf(PairingUnavailable), (failure) => failure.message),
        Match.orElse(() => "defect"),
      ),
  })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("the pairing file", () => {
  test("a code buys one token; the file is 0600 and holds neither the code nor the token, only their hashes", async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const code = await run(pairing.issue(T))
    expect(code).toMatch(/^[A-Z2-9]{10}$/)
    expect(statSync(join(held.path, FILE)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(held.path, FILE), "utf8")).not.toContain(code)
    // Typed with a dash and in lower case, it is the same code.
    const paired = await run(pairing.exchange(showCode(code).toLowerCase(), T + 1_000, UA))
    expect(await run(pairing.verify(paired.token))).toEqual(Option.some(paired.id))
    const [, , secret = ""] = paired.token.split(".")
    expect(readFileSync(join(held.path, FILE), "utf8")).not.toContain(secret)
    // A new store over the same file (a restart, or the other server) knows the token too.
    expect(await run(make(held.path).verify(paired.token))).toEqual(Option.some(paired.id))
    expect(await run(pairing.list)).toEqual([{ id: paired.id, created: T + 1_000, label: UA }])
  })

  test("a replayed code, a wrong one and an expired one are refused; an expired one is used up too", async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const code = await run(pairing.issue(T))
    await run(pairing.exchange(code, T + 1, UA))
    expect(await refusal(pairing.exchange(code, T + 2, UA))).toContain("reason:unknown")
    expect(await refusal(pairing.exchange("ABCDEFGHJK", T + 2, UA))).toContain("reason:unknown")
    const late = await run(pairing.issue(T))
    expect(await refusal(pairing.exchange(late, T + CODE_TTL_MS, UA))).toContain("reason:expired")
    expect(await refusal(pairing.exchange(late, T + 1, UA))).toContain("reason:unknown")
  })

  test("a forged, altered or foreign token is refused", async () => {
    using held = scratch("digest-pair-")
    using other = scratch("digest-pair-other-")
    const pairing = make(held.path)
    const { token } = await run(pairing.exchange(await run(pairing.issue(T)), T + 1, UA))
    const foreign = make(other.path)
    const theirs = await run(foreign.exchange(await run(foreign.issue(T)), T + 1, UA))
    const [version = "", id = "", secret = ""] = token.split(".")
    const altered = `${secret.slice(0, -1)}${Option.getOrElse(Arr.findFirst(["A", "B"], (each) => !secret.endsWith(each)), () => "A")}`
    for (const forged of ["", "v2", "v2.abc.def", `${version}.${id}x.${secret}`, `${version}.${id}.${altered}`, theirs.token, `v1.${id}.${secret}`, `${version}.${theirs.id}.${secret}`])
      expect([forged, await run(pairing.verify(forged))]).toEqual([forged, Option.none()])
  })

  test("revoke: one browser by its id, then all; a revoked token is refused at once", async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const pair = () => Effect.flatMap(pairing.issue(T), (code) => pairing.exchange(code, T + 1, UA))
    const [mac, phone, spare] = await run(Effect.all([pair(), pair(), pair()]))
    expect(await run(pairing.revoke({ id: String(phone?.id) }))).toBe(1)
    expect(await run(Effect.forEach([mac, phone, spare], (each) => Effect.map(pairing.verify(String(each?.token)), Option.isSome)))).toEqual([true, false, true])
    expect(await run(pairing.revoke("all"))).toBe(2)
    expect(await run(Effect.forEach([mac, spare], (each) => Effect.map(pairing.verify(String(each?.token)), Option.isSome)))).toEqual([false, false])
  })

  test(`${MAX_PAIRED} browsers are paired at once; one more unpairs the oldest`, async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const all = await run(Effect.forEach(Array.from({ length: MAX_PAIRED + 1 }), (_, index) => Effect.flatMap(pairing.issue(T), (code) => pairing.exchange(code, T + index, UA))))
    const kept = await run(Effect.forEach(all, (each) => Effect.map(pairing.verify(each.token), Option.isSome)))
    expect(kept).toEqual([false, ...Array.from({ length: MAX_PAIRED }, () => true)])
  })

  test("one code exchanged by 5 requests at once buys exactly one token", async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const code = await run(pairing.issue(T))
    const exits = await run(Effect.all(Array.from({ length: 5 }, () => Effect.exit(pairing.exchange(code, T + 1, UA))), { concurrency: 5 }))
    expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
    expect(await run(pairing.list)).toHaveLength(1)
  })

  test(`a burst of 200 wrong codes at once is compared ${SOURCE_FAILURES} times; the limit holds after a restart, until the window passes`, async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const real = await run(pairing.issue(T))
    const reasons = await run(Effect.all(Array.from({ length: 200 }, (_, index) => Effect.promise(() => refusal(pairing.exchange(`WRONG${String(index).padStart(5, "2")}`, T + 1, UA)))), { concurrency: 200 }))
    expect(reasons.filter((each) => each === "reason:unknown")).toHaveLength(SOURCE_FAILURES)
    expect(reasons.filter((each) => each === "reason:limited")).toHaveLength(200 - SOURCE_FAILURES)
    // A restart (a new store over the same file) is still limited, even for the right code, which stays good.
    expect(await refusal(make(held.path).exchange(real, T + 2, UA))).toBe("reason:limited")
    expect(await refusal(make(held.path).exchange(real, T + 1 + RATE_WINDOW_MS, UA))).toBe("none")
  })

  test("one address spending its failures locks only itself: his phone, from its own address, still pairs (T4)", async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const guesser = "100.64.0.9"
    const reasons = await run(Effect.forEach(Array.from({ length: 20 }), (_, index) => Effect.promise(() => refusal(pairing.exchange(`WRONG${String(index).padStart(5, "2")}`, T + 1, UA, guesser)))))
    expect(reasons.filter((each) => each === "reason:unknown")).toHaveLength(SOURCE_FAILURES)
    const code = await run(pairing.issue(T))
    expect(await refusal(pairing.exchange(code, T + 2, UA, "100.64.0.10"))).toBe("none")
    // The guesser is still out, after a restart too.
    expect(await refusal(make(held.path).exchange(await run(pairing.issue(T)), T + 3, UA, guesser))).toBe("reason:limited")
  })

  test(`many addresses together: past ${GLOBAL_FAILURES} failures a minute only an address with none in the window tries, once (the floor)`, async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const wrong = (index: number, source: string) => Effect.promise(() => refusal(pairing.exchange(`WRONG${String(index).padStart(5, "2")}`, T + 1, UA, source)))
    // 30 guessers, each failing until refused: GLOBAL_FAILURES are compared in all, then each gets only its floor.
    const sources = Array.from({ length: GLOBAL_FAILURES }, (_, index) => `100.64.1.${index}`)
    const reasons = await run(Effect.forEach(sources.flatMap((source) => Array.from({ length: SOURCE_FAILURES }, () => source)), (source, index) => wrong(index, source)))
    // In turn: the first six spend five each (30), then each later one only its first try.
    expect(reasons.filter((each) => each === "reason:unknown")).toHaveLength(GLOBAL_FAILURES + sources.length - GLOBAL_FAILURES / SOURCE_FAILURES)
    // Every guesser has failed once at least: none may try again this minute.
    expect(await run(Effect.forEach(sources, (source, index) => wrong(1_000 + index, source)))).toEqual(sources.map(() => "reason:limited"))
    // A fresh address (his phone) gets its try, and its right code pairs.
    expect(await refusal(pairing.exchange(await run(pairing.issue(T)), T + 2, UA, "100.64.2.1"))).toBe("none")
    // A file from before `tries` (failure times alone) still counts them, as from one unknown address.
    const text = readFileSync(join(held.path, FILE), "utf8").replace(/,"tries":\[[^\]]*\]/, "")
    writeFileSync(join(held.path, FILE), text, { mode: 0o600 })
    expect(await refusal(make(held.path).exchange("WRONGWRONG", T + 3, UA, "unknown"))).toBe("reason:limited")
  })

  test("a file of a version this build does not know fails issue and exchange, refuses every token, and is left as it is", async () => {
    using held = scratch("digest-pair-")
    const newer = '{"v":3,"keys":[]}'
    writeFileSync(join(held.path, FILE), newer, { mode: 0o600 })
    const pairing = make(held.path)
    expect(await refusal(pairing.issue(T))).toContain("version 3")
    expect(await refusal(pairing.exchange("ABCDEFGHJK", T, UA))).toContain("version 3")
    expect(await run(pairing.verify(`v2.abcdefgh.${"a".repeat(43)}`))).toEqual(Option.none())
    expect(readFileSync(join(held.path, FILE), "utf8")).toBe(newer)
  })

  test("round 1's file (a cookie key) reads as no browser paired; its codes still pair", async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const code = await run(pairing.issue(T))
    const stored = readFileSync(join(held.path, FILE), "utf8")
    writeFileSync(join(held.path, FILE), stored.replace('"v":2', '"v":1,"key":"invented-key"'), { mode: 0o600 })
    expect(await run(pairing.list)).toEqual([])
    expect(await refusal(pairing.exchange(code, T + 1, UA))).toBe("none")
  })

  test("a code is compared as typed: case, spaces and dashes aside", () => {
    expect(normalizeCode(" abcde-fghjk ")).toBe("ABCDEFGHJK")
  })
})
