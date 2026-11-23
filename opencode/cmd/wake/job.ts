/**
 * A job's runner: what `@dotfiles/opencode-wake/process/runner` launches as
 * `bun job.ts <dir>`, outside the OpenCode server. It runs the job in <dir>
 * to its end (`@dotfiles/opencode-wake/process/supervise`), then calls the
 * wakes' `due` through the OS backstop's script, starting the OpenCode
 * service when none answers, so the end letter goes now.
 */
import { sealJobRoot, superviseAdmitted } from "@dotfiles/opencode-wake/process/supervise"
import { argv } from "bun"
import { fileURLToPath } from "node:url"
import { scheduled } from "./backstop.ts"

const [, , dir, root] = process.argv
const accepted = dir && (dir !== "--seal-root" || root)
if (!accepted) console.error("usage: bun job.ts <job dir> | --seal-root <job storage root>")
else if (dir === "--seal-root" && root) sealJobRoot(root)
else if (dir) {
  const [executable = "bun"] = argv
  const helper = [executable, fileURLToPath(new URL("../guard/host-admit.ts", import.meta.url))]
  await superviseAdmitted(dir, scheduled, helper)
}
process.exit(Number(!accepted) * 2)
