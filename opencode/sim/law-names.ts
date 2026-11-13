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
  prompt: "a prompt to an idle session is enqueued, delivered, and answered by the model in one execution that reads it",
  steer: "a synthetic message with resume wakes an idle session into an execution that reads it, and a second admission of its id is not taken again",
  notice: "a synthetic message without resume starts no execution, and the next prompt's execution reads it",
  compact:
    "a compaction asked with a reason runs on the model and starts the context completed with that reason; experimental.idle runs after a turn and not after the compaction alone",
  request: "model.request runs before each request of the plugin's sessions, with the request's kind",
  tools: "a tool a transform adds is offered, and a built-in tool it removes is not",
  rpc: "an RPC method a plugin registers answers a call with its JSON",
  sessions: "sessions list by parent and directory, and an update's metadata is what get answers",
  catalog: "the catalog lists the configured model, its provider and the build agent, and refuses ones it does not have",
  options: "a plugin's options are the ones it was configured with, and its location the directory it serves",
}

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
