import { agentFile, ROLES } from "../../skills/orchestrate/scripts/agents.ts"
import type { Path } from "effect"
import { OUT, renderAgents, ROOT } from "../scripts/agents.ts"
import { readInputText, readScratchFileSync, scratchInput } from "./read-path.ts"

const source = { agentFile, ROLES }

/** The checked installed-source case of the same agent compiler. */
export const checkoutAgents = (root = ROOT) => renderAgents(root, source, {
  protocol: readInputText("../skills/orchestrate/protocol.md"),
  safety: readInputText("../skills/loop/safety.md"),
  skill: readInputText("../skills/orchestrate/SKILL.md"),
  worker: readInputText("../agents/worker.md"),
})

export const writtenAgents = () => readInputText(OUT)

/** The --source case changes the source texts, not the compiler code. */
export const scratchAgents = (root: string, sourceDir: string, path: Path.Path) => {
  const dir = scratchInput(sourceDir)
  return renderAgents(root, source, {
    protocol: readScratchFileSync(path.join(dir, "protocol.md"), "utf8"),
    safety: readScratchFileSync(path.join(dir, "../loop/safety.md"), "utf8"),
    skill: readScratchFileSync(path.join(dir, "SKILL.md"), "utf8"),
    worker: readScratchFileSync(path.join(dir, "../../agents/worker.md"), "utf8"),
  })
}
