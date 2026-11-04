import { Plugin } from "@opencode/plugin"
import { Bridge, completionText, facts, queued, type Budget, type Completion, type Thread } from "./bridge.ts"
import { CODEX_STATUS } from "./protocol.ts"
import { TOOLS } from "./tools.ts"

export default Plugin.define({
  id: "opencode-gent.codex",
  async setup(ctx) {
    const abort = new AbortController()
    const bridge = new Bridge({ socket: typeof ctx.options.socket === "string" ? ctx.options.socket : undefined, signal: abort.signal })
    const saved = await ctx.storage.get("owners")
    const owners = new Set<string>(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [])
    const disposers: Array<() => void | Promise<void>> = []
    const remember = async (owner: string) => {
      if (owners.has(owner)) return
      owners.add(owner)
      await ctx.storage.set("owners", [...owners])
    }
    let delivering: Promise<void> | undefined
    const deliver = () => delivering ??= (async () => {
      for (const owner of owners) {
        if (abort.signal.aborted) return
        // A removed session must never consume another session's completion.
        const session = await ctx.session.get({ sessionID: owner }).catch(() => undefined)
        if (!session) continue
        const events = await bridge.call<Completion[]>("GET", `/events?owner=${encodeURIComponent(owner)}`)
        for (const event of events) {
          // Stable message identity makes retry after a lost ack idempotent.
          await ctx.session.synthetic({
            sessionID: owner, id: `msg_codex_${event.threadId}_${event.seq}`,
            text: completionText(event), description: `Codex: ${event.description}`,
            delivery: "queue", resume: true,
          })
          await bridge.call("POST", "/ack", { owner, seqs: [event.seq] })
        }
      }
    })().finally(() => { delivering = undefined })

    const tools = await ctx.tool.transform((editor) => {
      for (const tool of TOOLS) editor.add({
        name: `codex_${tool.name}`, description: tool.description, input: tool.inputSchema,
        options: { codemode: false },
        async execute(raw, context) {
          const input = raw as Record<string, unknown>
          const owner = context.sessionID
          await remember(owner)
          if (tool.name === "start") {
            const session = await ctx.session.get({ sessionID: owner })
            const thread = await bridge.call<Thread>("POST", "/start", { ...input, owner, cwd: input.cwd ?? session.location.directory })
            if (thread.status === "held") return { content: `Codex holds this turn and made no thread: ${thread.held}. It should open about ${new Date(thread.opensAt ?? 0).toISOString()}, more than 10 minutes away. Run this role on Claude now (orchestrate Families).` }
            return { content: `${thread.status === "queued" ? "Queued" : "Started"} Codex thread ${thread.id} (${facts(thread)}). ${queued(thread)}Its turn's end arrives as a message; do not poll.`, metadata: { thread: thread.id, turn: thread.turns } }
          }
          if (tool.name === "threads") {
            const threads = await bridge.threads(owner)
            const budget = await bridge.call<Budget>("GET", "/budget").catch(() => undefined)
            return { content: [threads.length ? threads.map((t) => `${t.id} "${t.description}": ${t.status}; ${facts(t)}`).join("\n") : "This session has no Codex threads.", budget?.summary ?? "Codex budget unavailable."].join("\n") }
          }
          // The daemon's send/interrupt endpoints take a global thread id. Enforce session ownership here.
          if (!(await bridge.threads(owner)).some((t) => t.id === input.thread)) throw new Error("This session does not own that Codex thread")
          const thread = await bridge.call<Thread>("POST", `/${tool.name}`, { threadId: input.thread, ...(tool.name === "send" ? { prompt: input.prompt } : {}) })
          return { content: tool.name === "send"
            ? `Codex thread ${thread.id} ${thread.status === "queued" ? "queued" : "runs"} turn ${thread.turns}. ${queued(thread)}Its end arrives as a message; do not poll.`
            : thread.status === "running" ? `Interrupting ${thread.id}; its end arrives as a message.` : `${thread.id} is ${thread.status}; nothing to interrupt.` }
        },
      })
    })
    disposers.push(tools.dispose)
    // Idle handles completions already ready when the model finishes. The timer
    // handles a turn ending later, when there is no OpenCode execution to hook.
    const idle = await ctx.session.hook("experimental.idle", async ({ sessionID }) => {
      if (owners.has(sessionID)) await deliver().catch(() => undefined)
    })
    disposers.push(idle.dispose)
    const poll = setInterval(() => {
      if (owners.size) void deliver().catch(() => undefined)
    }, typeof ctx.options.pollMs === "number" ? Math.max(10, ctx.options.pollMs) : 5000)
    const status = await ctx.rpc.register(CODEX_STATUS, { status: async (input) => ({
      threads: await bridge.threads(typeof input === "object" && input !== null && "owner" in input && typeof input.owner === "string" ? input.owner : undefined),
      budget: await bridge.call<Budget>("GET", "/budget").catch(() => undefined),
    }) as never })
    disposers.push(status.dispose)
    return async () => {
      clearInterval(poll)
      abort.abort()
      await delivering?.catch(() => undefined)
      for (const dispose of disposers.reverse()) await dispose()
    }
  },
})
