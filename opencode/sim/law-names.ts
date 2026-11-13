// The host laws' names, the law probe's outcome lines, its options and the
// scripted model's answer, apart from the laws themselves (host-laws.ts), so
// the real run (tests/host-laws/real.ts) and its test read them on the root's
// Effect without compiling the fork's sources: this file imports nothing.

/** The model's answer to a law's request: by its kind, and a turn names every law marker its request carried. */
export const answer = (kind: "primary" | "compaction" | "title", text: string) => {
  if (kind === "title") return "Law title"
  if (kind === "compaction" && text.includes("law: kept for the summary")) return `${SUMMARY}\n${KEPT_IN_SUMMARY}`
  if (kind === "compaction") return SUMMARY
  return `heard ${[...text.matchAll(/law: ([a-z ]+[a-z])/g)].map((match) => match[1]).join("|")}`
}

/** The model's summary when the host compacts: a line more for each law marker the request carried after its conversation. */
export const SUMMARY = "## Objective\n- law: the session's summary"

/** A law's prompt that asks the model for one tool call: `law-call: <tool> <input as JSON>`. */
export const LAW_CALL = "law-call: "

/** A second model of the law provider, of a family with a release date, as a Codex sol is configured: the catalog law reads both back. */
export const LAW_SOL = { id: "sim-sol", family: "gpt-sol", releaseDate: "2026-09-29" }

/** A law's prompt that asks the model to call `tool` with `input`, a JSON object's text. */
export const lawCall = (tool: string, input: string) => `${LAW_CALL}${tool} ${input}`

/**
 * The tool call a request's last message asks for, when it is a law's `law-call:` prompt (its input as JSON text, for
 * the caller to decode on its own Effect); none for any other.
 */
export const callOf = (last: string): ReadonlyArray<{ readonly name: string; readonly input: string }> => {
  const at = last.indexOf(LAW_CALL)
  if (at < 0) return []
  const rest = last.slice(at + LAW_CALL.length).trim()
  const space = rest.indexOf(" ")
  if (space < 0) return [{ name: rest, input: "{}" }]
  return [{ name: rest.slice(0, space), input: rest.slice(space + 1) }]
}

/** The summary's line for a compaction request that carried `law: kept for the summary` (the compaction hook law's message). */
export const KEPT_IN_SUMMARY = "- law: the hook's message was in the request"

/** The law probe's options, as both hosts configure it. */
export const PROBE_OPTIONS = { law: "probe", depth: 2 }

/** The folder the law probe's copy runs the laws in: a host may load it for other folders too. */
export const LAW_FOLDER = "law"

export const LAW = {
  storage: "storage keeps a plugin's values, pages a scan in key order, and forgets a removed key",
  prompt: "a prompt to an idle session is enqueued, delivered, and answered by the model in one execution that reads it, and a second admission of its id is not taken again",
  steer: "a synthetic message with resume wakes an idle session into an execution that reads it, and a second admission of its id is not taken again",
  notice: "a synthetic message without resume starts no execution, and the next prompt's execution reads it",
  compact:
    "a compaction asked with a reason runs on the model and starts the context completed with that reason; experimental.idle runs after a turn and not after the compaction alone",
  request: "model.request runs before each request of the plugin's sessions, with the request's kind",
  tools: "a tool a transform adds is offered, and a built-in tool it removes is not",
  rpc: "an RPC method a plugin registers answers a call with its JSON",
  rpcFaults: "an RPC handler that dies fails its call, never its caller, and one that never answers leaves the call open to the caller's own timeout",
  sessions:
    "a session created with an id is that session when created again; sessions list by parent and directory, newest update first unless asc, up to a limit; an update's metadata is what get answers",
  catalog: "the catalog lists the configured model, its provider and the build agent, and refuses ones it does not have",
  http: "http.request runs after model.request for each request, carrying the headers model.request set; the request it leaves is the one sent, and http.response sees that request",
  retry:
    "a response http.response turns into a rate-limit 429 fails the request and the retry hook sees it to be retried; a usage-limit 429 comes to it not retried; a retry it decides with no delay sends the request again, model.request running again",
  refused: "a usage-limit 429 the retry hook leaves unretried ends the turn: one request, no answer, and no experimental.idle after it",
  died: "an http.request hook that dies ends the turn: one request, no answer, the retry hook not asked, and the session at rest",
  unauthorized:
    "an http.request hook may send a request to a data: URL, answered in the process; a 401 http.response puts in its answer's place fails the request with its message, the retry hook asked not to retry it, and the turn ends: one request, no answer",
  integration:
    "integration.get lists the logins OpenCode holds, connection.active is the first, resolve answers its credential, status takes a mark, a transform registers a method, and an unknown integration is refused",
  provider: "a provider a transform turns on is in the provider list",
  agents:
    "an agent a transform defines is listed and got with its fields, an update of an agent the transform did not define makes it, and a session created on it runs as it with its system prompt",
  subagent:
    "a subagent call starts a child session of the caller on the agent asked, prompted with the spawned line, and answers at once that it runs in the background; the child going idle sends the parent a <subagent> notice with its answer, which wakes it",
  idleBackground:
    "experimental.idle after a turn that started a background subagent lists the running child as the session's background; once the child's notice is answered, the session's idle lists none",
  hooks:
    "execute.before sees a call and may change its input; one that fails refuses the call with its message and no execute.after runs; execute.after sees the result and may change what the model reads",
  update: "a transform's update of the built-in subagent tool wraps its execute: the call runs through the wrapper",
  shell: "the shell's create.before hooks see each command the host spawns, before it runs",
  compaction: "a compaction hook's message added after the conversation goes in the compaction request before the summary prompt",
  window: "a session on an agent whose compactionWindow its prompt passed is compacted automatically; one on an agent without the window is not",
  options: "a plugin's options are the ones it was configured with, and its location the directory it serves",
}

/** The login both hosts hold for the integration law: no real token. */
export const LAW_LOGIN = { id: "cred_law", label: "Law login", access: "law-access-token", refresh: "law-refresh-token" }

/** The answers' error bodies the retry and refused laws put on a response, as Anthropic and OpenAI words them. */
export const RATE_LIMITED = '{"type":"error","error":{"type":"rate_limit_error","message":"law: rate limited"}}'
export const USAGE_LIMITED = '{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your session usage limit."}}'
/** The 401 body the unauthorized law answers with, as Anthropic words an authentication failure. */
export const UNAUTHORIZED = '{"type":"error","error":{"type":"authentication_error","message":"law: sign in again"}}'

/** Every law's name, in the order the probe runs them. */
export const NAMES: ReadonlyArray<string> = Object.values(LAW)

/** The probe's line for a law that held. */
export const KEPT = "sim-law: kept "
/** The probe's line for a law that broke: then `<name>: <why>`. */
export const BROKEN = "sim-law: broken "
/** The probe's line once it has run every law. */
export const DONE = "sim-law: done"

/** A law's own outcome line among a run's lines, or, with none, every line, to show what happened. */
export const outcome = (all: ReadonlyArray<string>, name: string) => {
  const own = all.filter((line) => line === `${KEPT}${name}` || line.startsWith(`${BROKEN}${name}:`))
  if (own.length === 0) return all
  return own
}
