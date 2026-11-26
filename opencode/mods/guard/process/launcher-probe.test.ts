// The user-scope probe status and each launch decide by (probeScope, which
// groupLauncher runs), on a virtual clock with fake helpers: a helper that
// answers within SCOPE_PROBE_TIMEOUT_MS gives a scope, one that fails
// gives none with its failure, and a slow one is timed out, never mistaken
// for an absent user manager.
import { describe } from "bun:test"
import { Effect, Fiber } from "effect"
import { expect, it } from "effect-bun-test"
import { TestClock } from "effect/testing"
import { AdmissionUnavailable } from "../admission.ts"
import { probeScope, SCOPE_PROBE_TIMEOUT_MS } from "./scope-probe.ts"

const answersAfter = (ms: number) => () => Effect.sleep(ms).pipe(Effect.as(""))
const probe = (run: Parameters<typeof probeScope>[0]) => Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(probeScope(run))
  yield* TestClock.adjust(SCOPE_PROBE_TIMEOUT_MS * 4)
  return yield* Fiber.join(fiber)
})

describe("the user-scope probe", () => {
  it.effect("a helper that answers within the bound gives a scope, even a slow one", () =>
    Effect.gen(function* () {
      expect(yield* probe(answersAfter(0))).toEqual({ kind: "scope" })
      expect(yield* probe(answersAfter(SCOPE_PROBE_TIMEOUT_MS - 1))).toEqual({ kind: "scope" })
    }))

  it.effect("a helper slower than the bound is timed out, not an absent user manager", () =>
    Effect.gen(function* () {
      expect(yield* probe(answersAfter(SCOPE_PROBE_TIMEOUT_MS + 1))).toEqual({ kind: "timed-out", afterMs: SCOPE_PROBE_TIMEOUT_MS })
      expect(yield* probe(() => Effect.never)).toEqual({ kind: "timed-out", afterMs: SCOPE_PROBE_TIMEOUT_MS })
    }))

  it.effect("a failing helper gives no scope, naming its failure", () =>
    Effect.gen(function* () {
      const failing = () => Effect.fail(new AdmissionUnavailable({ reason: "unavailable", detail: "/usr/bin/systemd-run --user --scope: exit 1" }))
      expect(yield* probe(failing)).toEqual({ kind: "none", why: "/usr/bin/systemd-run --user --scope: exit 1" })
    }))
})
