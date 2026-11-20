// OpenCode's automation tools, by their registry ids. The wake tools replace
// them (cmd/wake/server.ts takes them out of the registry); the sim offers
// them under `experimental.automations` (sim/host.ts) and the host laws match
// one (sim/host-laws.ts).
//
// A registry id is the tool's namespace, dots as `_`, then `_` and its name
// (the fork's packages/core/src/tool/runtime.ts `effectiveName`). Upstream
// 2002222d13 moved the tools from namespace `opencode` (`opencode_automation_create`)
// to their own namespace `automation` (`automation_create`). Until every host
// runs a fork past that commit, a match takes both; then `LEGACY` goes.

const VERBS = ["create", "list", "pause", "resume", "delete"] as const

/** The ids a fork past upstream 2002222d13 gives the tools: what the sim offers. */
export const AUTOMATION_TOOLS: ReadonlyArray<string> = VERBS.map((verb) => `automation_${verb}`)

/** The ids an older fork gives them. */
const LEGACY: ReadonlyArray<string> = VERBS.map((verb) => `opencode_automation_${verb}`)

/** Every id either fork gives an automation tool: what the wake plugin removes and a law matches. */
export const AUTOMATION_IDS: ReadonlyArray<string> = [...AUTOMATION_TOOLS, ...LEGACY]

/** Whether a registry id is one of OpenCode's automation tools, on either fork. */
export const isAutomationTool = (id: string) => AUTOMATION_IDS.includes(id)
