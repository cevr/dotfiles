// A model request's system prompt on the simulated host, and the request hook
// that shapes it, as the fork's session/model-request.ts does: before the
// `model.request` hook, a primary request runs the `context` hook, a
// compaction's request the `compaction` hook and a title's the `title` hook,
// each on one event whose `system` parts the hooks of the session's location's
// copies edit in turn; the request carries the parts they leave. The law
// `LAW.system` (host-laws.ts) holds both hosts to it.
//
// The event's conversation, generation options and tool definitions are not
// modelled: a hook that reads one is an unmodelled reach, so the world's next
// operation fails naming it.

/** A system prompt part, as the fork's `SystemPart` has it. */
export interface SystemPart {
  readonly type: "text"
  text: string
}

/** The request hook a request of each kind runs, as the fork's `prepare` names it. */
export const HOOK_OF = { primary: "context", compaction: "compaction", title: "title" } as const

export type RequestHook = (typeof HOOK_OF)[keyof typeof HOOK_OF]

/** The host's own instructions, the system prompt's first part before any hook adds to it. */
export const BASE_SYSTEM = "You are OpenCode."

/** The `context`, `compaction` and `title` hooks' event: the request's scope and its system parts. */
export interface SystemInput {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  system: Array<SystemPart>
}

/** The fields of the fork's request event the world does not model, and what each reads as. */
const UNMODELLED = { messages: [], options: {}, tools: {} }

/**
 * The event for one request: its scope, the host's instructions as its one system part, and the fields the world
 * does not model, each a getter that reports its reach to `reached` and reads as empty.
 */
export const eventOf = (
  scope: { readonly sessionID: string; readonly agent: string; readonly model: { readonly providerID: string; readonly id: string } },
  hook: RequestHook,
  reached: (path: string) => void,
): SystemInput => {
  const event: SystemInput = { ...scope, system: [{ type: "text", text: BASE_SYSTEM }] }
  for (const [field, empty] of Object.entries(UNMODELLED))
    Object.defineProperty(event, field, {
      enumerable: false,
      get: () => {
        reached(`session.hook(${hook}).${field}`)
        return empty
      },
    })
  return event
}

/** The system parts' texts, as a request carries them. */
export const textsOf = (event: SystemInput): ReadonlyArray<string> => event.system.map((part) => part.text)
