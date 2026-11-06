// The Codex account's pace: the orchestrate skill's admission script, the
// one the Claude-side Codex bridge asks, run with `--codex --admit`.
import { Cause, Effect, Layer } from "effect"
import { FailedOpen, parseAdmission } from "../pace.ts"
import { CodexAdmission } from "../service.ts"

/** The script has this long to answer. */
const TIMEOUT_MS = 20_000

/**
 * Run `script` for one new agent. Only the script's own answer holds;
 * anything else (unmeasured, no answer, no script) fails open, saying why.
 * The host's binary is Bun underneath, so BUN_BE_BUN runs it as Bun.
 */
export const layer = (script: string) =>
  Layer.succeed(CodexAdmission, {
    admit: Effect.fn("CodexAdmission.admit")(
      function* (model: string, role: string) {
        return yield* Effect.tryPromise(async () => {
          const child = Bun.spawn([process.execPath, script, "--codex", "--admit", "--model", model, "--role", role], {
            env: { ...process.env, BUN_BE_BUN: "1" },
            stdout: "pipe",
            stderr: "ignore",
            timeout: TIMEOUT_MS,
          })
          const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
          if (code === null || child.signalCode !== null)
            return FailedOpen.make({ why: `the script was stopped by ${child.signalCode ?? "a signal"} (it has ${TIMEOUT_MS / 1000} s)` })
          return parseAdmission(code, out)
        })
      },
      Effect.catchCause((cause) => Effect.succeed(FailedOpen.make({ why: `the script could not run: ${messageOf(Cause.squash(cause))}` }))),
    ),
  })

const messageOf = (error: unknown) => {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
  return cause instanceof Error ? cause.message : String(cause)
}
