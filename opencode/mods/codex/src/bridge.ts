// Transport only. The installed daemon owns app-server, role/model resolution,
// budget latches, recovery and Sabbath stops; none of that policy lives here.
export interface Thread {
  readonly id: string
  readonly owner?: string
  readonly description: string
  readonly model: string
  readonly effort?: string
  readonly status: string
  readonly turns: number
  readonly compactions: number
  readonly updatedAt: number
  readonly held?: string
  readonly opensAt?: number
  readonly usage?: { tokens: number; context: number; window: number }
}
export interface Completion {
  readonly seq: number
  readonly threadId: string
  readonly description: string
  readonly status: string
  readonly cause?: string
  readonly error?: string
  readonly resumes?: number
  readonly final: string
  readonly durationMs: number
}
export interface Budget {
  readonly admission?: { readonly ok?: boolean; readonly line: string }
  readonly summary: string
  readonly start: { ok: boolean; reason?: string; until?: number }
  readonly send: { ok: boolean; reason?: string; until?: number }
}

export class Bridge {
  private socket?: string
  private ensuring?: Promise<string>
  constructor(private readonly options: { socket?: string; signal?: AbortSignal } = {}) {
    this.socket = options.socket
  }
  private async ensure() {
    if (this.socket) return this.socket
    this.ensuring ??= (async () => {
      const run = Bun.spawn(["sh", "-c", 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" exec codex-bridge ensure'], {
        stdout: "pipe", stderr: "pipe", signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(this.options.signal ? [this.options.signal] : [])]),
      })
      const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
      if (code !== 0) throw new Error(`codex-bridge ensure failed: ${err.trim() || out.trim()}`)
      const value = JSON.parse(out) as { socket?: string }
      if (!value.socket) throw new Error("codex-bridge ensure returned no socket")
      return this.socket = value.socket
    })().finally(() => { this.ensuring = undefined })
    return this.ensuring
  }
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const send = async () => fetch(`http://bridge${path}`, {
      unix: await this.ensure(), method,
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(this.options.signal ? [this.options.signal] : [])]),
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    // Retry connection failures only. An HTTP error is a policy refusal, and
    // replaying a successful POST after losing its response could start twice.
    const response = await send().catch((error: unknown) => {
      const code = (error as { code?: string }).code
      if (this.options.socket || this.options.signal?.aborted || (method === "POST" && code !== "ECONNREFUSED" && code !== "ENOENT")) throw error
      this.socket = undefined
      return send()
    })
    const value = await response.json() as { error?: string }
    if (!response.ok) throw new Error(value.error ?? `codex-bridge answered ${response.status}`)
    return value as T
  }
  threads(owner?: string) { return this.call<Thread[]>("GET", `/threads${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`) }
}

const minute = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z"
export const queued = (thread: Thread) => thread.status !== "queued" ? "" : /\bthe Sabbath\b/.test(thread.held ?? "")
  ? `The turn is latched for the Sabbath's rest (${thread.held}); it starts by itself when the rest ends. Leave it latched: Claude rests too. `
  :
  `The turn is latched (${thread.held ?? "waiting"})${thread.opensAt ? `; it should start about ${minute(thread.opensAt)}` : ""}; it starts by itself when there is room. Run \`codex-bridge wait ${thread.id} --patience 10\` in the background if needed. `
export const facts = (thread: Thread) => `${thread.model}${thread.effort ? ` ${thread.effort}` : ""}, ${thread.turns} turns, ${thread.compactions} compactions${thread.usage ? `, ${thread.usage.tokens} tokens, context ${Math.round(100 * thread.usage.context / (thread.usage.window || 1))}%` : ""}`
export const completionText = (event: Completion) => {
  const final = event.final.length > 6000 ? event.final.slice(0, 6000) + "\n[cut at 6000 characters]" : event.final || "(no final message)"
  return `Codex thread ${event.threadId} "${event.description}" ended its turn: ${event.status}${event.cause ? ` (${event.cause})` : ""}${event.error ? `: ${event.error}` : ""}${event.resumes ? `; bridge resumed ${event.resumes} times` : ""}; ${Math.round(event.durationMs / 60_000)} min.\nContinue it with codex_send, or leave it. Final message:\n${final}`
}
