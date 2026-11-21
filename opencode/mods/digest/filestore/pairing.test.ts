// The pairing file: a code is good once, for five minutes, kept only as its hash; the cookie it buys is signed with
// the file's key, so a forged or altered one, or one of another digest, is refused; the file is 0600, versioned, and
// one of an unknown version is an error that leaves it as it is.
import { describe, expect, test } from "bun:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Cause, Effect, Exit, Match } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { CODE_TTL_MS, normalizeCode, PairingUnavailable, PairRefused, showCode } from "../pairing.ts"
import { FILE, make } from "./pairing.ts"

const T = Date.parse("2026-11-20T12:00:00Z")

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

describe("the pairing file", () => {
  test("a code buys one signed cookie; the file is 0600 and holds no code, only its hash", async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const code = await Effect.runPromise(pairing.issue(T))
    expect(code).toMatch(/^[A-Z2-9]{10}$/)
    expect(statSync(join(held.path, FILE)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(held.path, FILE), "utf8")).not.toContain(code)
    // Typed with a dash and in lower case, it is the same code.
    const cookie = await Effect.runPromise(pairing.exchange(showCode(code).toLowerCase(), T + 1_000))
    expect(await Effect.runPromise(pairing.verify(cookie))).toBe(true)
    // A new store over the same file (a restart, or the other server) knows the cookie too.
    expect(await Effect.runPromise(make(held.path).verify(cookie))).toBe(true)
  })

  test("a replayed code, a wrong one and an expired one are refused; an expired one is used up too", async () => {
    using held = scratch("digest-pair-")
    const pairing = make(held.path)
    const code = await Effect.runPromise(pairing.issue(T))
    await Effect.runPromise(pairing.exchange(code, T + 1))
    expect(await refusal(pairing.exchange(code, T + 2))).toContain("reason:unknown")
    expect(await refusal(pairing.exchange("ABCDEFGHJK", T + 2))).toContain("reason:unknown")
    const late = await Effect.runPromise(pairing.issue(T))
    expect(await refusal(pairing.exchange(late, T + CODE_TTL_MS))).toContain("reason:expired")
    expect(await refusal(pairing.exchange(late, T + 1))).toContain("reason:unknown")
  })

  test("a forged, altered or foreign cookie is refused", async () => {
    using held = scratch("digest-pair-")
    using other = scratch("digest-pair-other-")
    const pairing = make(held.path)
    const cookie = await Effect.runPromise(pairing.exchange(await Effect.runPromise(pairing.issue(T)), T + 1))
    const foreign = make(other.path)
    const theirs = await Effect.runPromise(foreign.exchange(await Effect.runPromise(foreign.issue(T)), T + 1))
    const [version = "", id = "", signature = ""] = cookie.split(".")
    for (const forged of ["", "v1", "v1.abc.def", `${version}.${id}x.${signature}`, `${version}.${id}.${signature.slice(1)}A`, theirs, `v2.${id}.${signature}`])
      expect([forged, await Effect.runPromise(pairing.verify(forged))]).toEqual([forged, false])
  })

  test("a file of a version this build does not know fails issue and exchange, refuses every cookie, and is left as it is", async () => {
    using held = scratch("digest-pair-")
    const newer = '{"v":2,"keys":[]}'
    writeFileSync(join(held.path, FILE), newer, { mode: 0o600 })
    const pairing = make(held.path)
    expect(await refusal(pairing.issue(T))).toContain("version 2")
    expect(await refusal(pairing.exchange("ABCDEFGHJK", T))).toContain("version 2")
    expect(await Effect.runPromise(pairing.verify("v1.abcdefgh.abcdefghabcdefgh"))).toBe(false)
    expect(readFileSync(join(held.path, FILE), "utf8")).toBe(newer)
  })

  test("a code is compared as typed: case, spaces and dashes aside", () => {
    expect(normalizeCode(" abcde-fghjk ")).toBe("ABCDEFGHJK")
  })
})
