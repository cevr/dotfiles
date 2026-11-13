// The host laws' names, the law probe's outcome lines, its options and the
// scripted model's answer, apart from the laws themselves (host-laws.ts), so
// the real run (tests/host-laws/real.ts) and its test read them on the root's
// Effect without compiling the fork's sources: this file imports nothing.

/** The model's answer to a law's request: by its kind, and a turn names every law marker its request carried. */
export const answer = (kind: "primary" | "compaction" | "title", text: string) => {
  if (kind === "title") return "Law title"
  if (kind === "compaction") return SUMMARY
  return `heard ${[...text.matchAll(/law: ([a-z ]+[a-z])/g)].map((match) => match[1]).join("|")}`
}

/** The model's summary when the host compacts. */
export const SUMMARY = "## Objective\n- law: the session's summary"

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
  options: "a plugin's options are the ones it was configured with, and its location the directory it serves",
  mail: "get and synthetic of an id the host lacks fail as not found; get answers a running session busy after idle, and its last update; a steer admitted while it runs is read by its next request",
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
