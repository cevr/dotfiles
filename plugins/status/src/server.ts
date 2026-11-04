import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { readAgents, readRuns } from "./read.ts"
import { STATUS } from "./protocol.ts"

export default Plugin.define({
  id: "opencode-gent.status",
  async setup(ctx) {
    const log = typeof ctx.options.log === "string" ? ctx.options.log : join(homedir(), ".cache/orchestrate/opencode-agents.jsonl")
    const script = typeof ctx.options.statusScript === "string" ? ctx.options.statusScript : undefined
    const status = await ctx.rpc.register(STATUS, { status: async () => {
      const [agents, runs] = await Promise.allSettled([readAgents(log), readRuns(ctx.location.directory, script)])
      return {
        agents: agents.status === "fulfilled" ? agents.value : [],
        runs: runs.status === "fulfilled" ? runs.value : [],
        errors: [agents, runs].flatMap((result, index) => result.status === "rejected" ? [`${index === 0 ? "Agents" : "Runs"}: ${String(result.reason)}`] : []),
      } as never
    } })
    return status.dispose
  },
})
