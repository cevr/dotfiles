/**
 * The orchestrate rules as an OpenCode server plugin, the Claude Code hooks' counterpart.
 *
 * - Roles: the planner, implementor, verifier and worker agents, from
 *   agents.json (the orchestrate skill's prompts, written by `bun run agents`).
 * - Guard: a subagent call with no agent, or with the general agent, runs as the
 *   lean `worker`; a former role name (`orchestrate-*`, `orchestrate-reviewer`)
 *   runs as the role. A new role subagent runs at the role's reasoning effort,
 *   as a variant of the model it would run on, when that model has one. Each
 *   call is a line in a JSONL log a status pane can read.
 * - Compaction: each role compacts at its own window, and the primary agents
 *   at root's, from the orchestrate tuner's compact.json, else the defaults.
 *   The window is the agent's `request.settings.compactionWindow`, which the
 *   fork's automatic compaction reads. Every compaction keeps the files, the
 *   step and the user's instructions word for word.
 * - Sabbath: from Friday sunset to 30 minutes after Saturday's at the owner's
 *   place, no subagent starts, no Codex tool runs, and a running subagent's
 *   next tool call is refused so it ends its turn. The main session answers
 *   as always.
 *
 * Options (all optional):
 * - `windows`: path of compact.json, default `~/.cache/orchestrate/compact.json`.
 * - `log`: path of the call log, default `~/.cache/orchestrate/opencode-agents.jsonl`.
 * - `now`: a fixed time (ISO 8601) for the Sabbath clock, for tests.
 * - `place`: `{ name, lat, lon, timeZone }` for the Sabbath, default Knowlton, QC.
 * - `fullAgent`: true lets an untyped or general call run as asked.
 * - `codex`: tool name prefixes that start Codex work, default `["codex"]`.
 */
import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { definitions, effort, isRole, ROLES, route, type Reason } from "./roles.ts"
import { KNOWLTON, why, type Place } from "./sabbath.ts"
import { POOL_STATUS } from "../../pool/src/protocol.ts"
import type { Pace } from "../../pool/src/pace.ts"
import { DEFAULT_FILE, KEEP, ROOT, windows } from "./windows.ts"

export const DEFAULT_LOG = join(homedir(), ".cache/orchestrate/opencode-agents.jsonl")
const SUBAGENT = "subagent"
const HOUR = 3_600_000

/** One line of the call log. `asked` is what the model passed; `agent` is what runs. */
export type Call =
  | {
      readonly kind: "call"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly from: string
      readonly asked?: string
      readonly agent: string
      readonly reason: Reason | "continued"
      readonly model?: string
      readonly child?: string
      readonly background?: boolean
      readonly description?: string
    }
  | {
      readonly kind: "done"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly child?: string
      readonly status: "completed" | "running" | "error"
    }
  | {
      readonly kind: "denied"
      readonly at: string
      readonly sessionID: string
      readonly callID: string
      readonly tool: string
      readonly why: string
    }

export interface Dependencies {
  /** The Sabbath clock, in ms. Defaults to the `now` option, else the system clock. */
  readonly now?: () => number
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const clock = (deps: Dependencies, options: Plugin.Context["options"]): (() => number) => {
  if (deps.now) return deps.now
  if (typeof options.now === "string" && Number.isFinite(Date.parse(options.now))) {
    const fixed = Date.parse(options.now)
    return () => fixed
  }
  return Date.now
}

export const orchestrate = (deps: Dependencies = {}) =>
  Plugin.define({
    id: "dotfiles-opencode.orchestrate",
    setup: async (ctx) => {
      const options = ctx.options
      const now = clock(deps, options)
      const place: Place = isObject(options.place) ? (options.place as unknown as Place) : KNOWLTON
      const full = options.fullAgent === true
      const codex: readonly string[] = Array.isArray(options.codex) ? options.codex.map(String) : ["codex"]
      const windowsFile = typeof options.windows === "string" ? options.windows : DEFAULT_FILE
      const logFile = typeof options.log === "string" ? options.log : DEFAULT_LOG
      const disposers: Array<() => Promise<void> | void> = []

      const record = (call: Call) => {
        try {
          mkdirSync(dirname(logFile), { recursive: true })
          appendFileSync(logFile, `${JSON.stringify(call)}\n`)
        } catch {}
      }
      const isCodex = (tool: string) => codex.some((prefix) => tool === prefix || tool.startsWith(`${prefix}_`))

      /** The model a new role subagent runs on, at the role's effort, when that model offers it. */
      const roleBase = async (sessionID: string, agentID: string) => {
        const parent = await ctx.session.get({ sessionID })
        const location = { directory: parent.location.directory }
        const agent = await ctx.agent.get({ agentID, location }).catch(() => undefined)
        // The subagent tool's order: the agent's model, else the parent's, else (a session that never chose one) the default.
        return agent?.data?.model ?? parent.model ?? (await ctx.model.default({ location })).data ?? undefined
      }
      const roleModel = async (sessionID: string, agentID: string, variant: string) => {
        const parent = await ctx.session.get({ sessionID })
        const location = { directory: parent.location.directory }
        const base = await roleBase(sessionID, agentID)
        if (!base) return undefined
        const models = await ctx.model.list({ location })
        const model = models.data.find((item) => item.providerID === base.providerID && item.id === base.id)
        if (!model?.variants.some((item) => item.id === variant)) return undefined
        return `${base.providerID}/${base.id}#${variant}`
      }

      // The roles, defined as OpenCode's own plugins define build and general: before the
      // config's agent files, so a file in the owner's config still overrides a role's fields.
      // Each role compacts at its window, and each primary agent at root's. Config agent files
      // cannot set a window, and the config's agents arrive after this, so a primary agent
      // defined only in a config file keeps the model's ceiling.
      await ctx.agent.transform((editor) => {
        const sizes = windows(windowsFile)
        for (const agent of editor.list()) {
          if (agent.mode === "subagent" || agent.hidden) continue
          editor.update(agent.id, (item) => {
            item.request.settings.compactionWindow = sizes[ROOT]
          })
        }
        for (const role of ROLES) {
          const definition = definitions[role]
          editor.update(role, (item) => {
            item.description = definition.description
            item.system = definition.system
            item.mode = definition.mode
            item.permissions.push(...definition.permissions.map((rule) => ({ ...rule })))
            item.request.settings.compactionWindow = sizes[role]
          })
        }
      })
      // The tuner rewrites compact.json about once a day; pick it up within the hour.
      const reread = setInterval(() => void ctx.agent.reload().catch(() => undefined), HOUR)
      disposers.push(() => clearInterval(reread))

      await ctx.session.hook("compaction", (event) => {
        event.system.push({ type: "text", text: KEEP })
      })

      await ctx.tool.hook("execute.before", async (event) => {
        const resting = why(now(), place)
        if (resting) {
          const deny = (message: string): never => {
            record({
              kind: "denied",
              at: new Date().toISOString(),
              sessionID: event.sessionID,
              callID: event.id,
              tool: event.tool,
              why: resting,
            })
            throw new Error(`${resting} ${message}`)
          }
          if (event.tool === SUBAGENT) deny("No agent starts now. Do not retry; start it again once work resumes.")
          if (isCodex(event.tool)) deny("No Codex turn starts now. Do not retry; start it again once work resumes.")
          const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
          if (session?.parentID)
            deny("Stop now: end your turn with one line on where you stopped. Make no more tool calls.")
        }
        if (event.tool !== SUBAGENT || !isObject(event.input)) return

        const input = { ...event.input }
        const follow = typeof input.sessionID === "string" && input.sessionID !== ""
        const asked = typeof input.agent === "string" ? input.agent : undefined
        let routed: { agent: string; reason: Reason | "continued" } = route(input.agent, full)
        // A follow-up with no agent keeps its child's: the guard must not switch a verifier to the worker.
        if (follow && (asked === undefined || asked === "")) {
          const child = await ctx.session.get({ sessionID: String(input.sessionID) }).catch(() => undefined)
          if (child?.agent) routed = { agent: child.agent, reason: "continued" }
        }
        input.agent = routed.agent
        const level = isRole(routed.agent) ? effort(routed.agent) : undefined
        if (!follow && level && (input.model === undefined || input.model === "")) {
          const model = await roleModel(event.sessionID, routed.agent, level).catch(() => undefined)
          if (model) input.model = model
        }
        if (!follow) {
          // The pool reads provider quota, so OpenCode spend is visible. Missing
          // RPC/host failures fail open, as guard-agent's unreachable-host case.
          let pace: Pace | undefined
          try {
            const providerID = typeof input.model === "string" && input.model.includes("/")
              ? input.model.slice(0, input.model.indexOf("/"))
              : (await roleBase(event.sessionID, routed.agent))?.providerID
            if (providerID) pace = await ctx.rpc(POOL_STATUS).pace({ providerID }, { signal: AbortSignal.timeout(8000) }) as Pace
          } catch {}
          if (pace?.ok === false) {
            const at = Number.isFinite(pace.retryAt) ? Math.max(now() + 1000, pace.retryAt!) : now() + 60_000
            const script = resolve(import.meta.dir, "../../../scripts/pace.ts")
            const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
            record({ kind: "denied", at: new Date().toISOString(), sessionID: event.sessionID, callID: event.id, tool: event.tool, why: pace.reason })
            throw new Error(`orchestrate: the pool's pace holds this agent. ${pace.reason}. Run \`bun ${quote(script)} --wait ${Math.ceil(at)}\` with shell's background:true and go on with other work. When it exits, call subagent again with the same agent and description; admission is checked again. Do not poll.`)
          }
        }
        event.input = input
        record({
          kind: "call",
          at: new Date().toISOString(),
          sessionID: event.sessionID,
          callID: event.id,
          from: event.agent,
          ...(asked === undefined ? {} : { asked }),
          agent: routed.agent,
          reason: routed.reason,
          ...(typeof input.model === "string" ? { model: input.model } : {}),
          ...(follow ? { child: String(input.sessionID) } : {}),
          ...(input.background === true ? { background: true } : {}),
          ...(typeof input.description === "string" ? { description: input.description } : {}),
        })
      })

      await ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== SUBAGENT) return
        const metadata = event.status === "completed" ? event.result.metadata : undefined
        const child = isObject(metadata) && typeof metadata.sessionID === "string" ? metadata.sessionID : undefined
        record({
          kind: "done",
          at: new Date().toISOString(),
          sessionID: event.sessionID,
          callID: event.id,
          ...(child ? { child } : {}),
          status:
            event.status === "error" ? "error" : isObject(metadata) && metadata.status === "running" ? "running" : "completed",
        })
      })

      return async () => {
        for (const dispose of disposers.reverse()) await dispose()
      }
    },
  })

export default orchestrate()
