// The Codex account's pace: the orchestrate skill's admission script, the
// one the Claude-side Codex bridge asks, run with `--codex --admit`.
import { Effect, Layer } from "effect"
import { parseAdmission } from "../pace.ts"
import { CodexAdmission } from "../service.ts"

/** The script has this long to answer. */
const TIMEOUT_MS = 20_000

/**
 * Run `script` for one new agent. Only the script's own answer holds;
 * anything else (unmeasured, no answer, no script) fails open. The host's
 * binary is Bun underneath, so BUN_BE_BUN runs it as Bun.
 */
export const layer = (script: string) =>
  Layer.succeed(CodexAdmission, {
    admit: Effect.fn("CodexAdmission.admit")(function* (model: string, role: string) {
      return yield* Effect.tryPromise(async () => {
        const child = Bun.spawn([process.execPath, script, "--codex", "--admit", "--model", model, "--role", role], {
          env: { ...process.env, BUN_BE_BUN: "1" },
          stdout: "pipe",
          stderr: "ignore",
          timeout: TIMEOUT_MS,
        })
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
        return parseAdmission(code, out)
      })
    }, Effect.catchCause(() => Effect.succeed(undefined))),
  })
