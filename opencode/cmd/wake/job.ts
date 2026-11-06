/**
 * A job's runner: what `@dotfiles/opencode-wake/process/runner` launches as
 * `bun job.ts <dir>`, outside the OpenCode server. It runs the job in <dir>
 * to its end (`@dotfiles/opencode-wake/process/supervise`), then calls the
 * wakes' `due` through the OS backstop's script, starting the OpenCode
 * service when none answers, so the end letter goes now.
 */
import { supervise } from "@dotfiles/opencode-wake/process/supervise"
import { scheduled } from "./backstop.ts"

const dir = process.argv[2]
if (dir === undefined) {
  console.error("usage: bun job.ts <job dir>")
  process.exit(2)
}
await supervise(dir, scheduled)
process.exit(0)
