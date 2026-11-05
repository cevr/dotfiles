// The plain view the rows read: a session family as the TUI's data shows it,
// narrowed to what a subagent row needs and free of OpenCode's types. A
// caller reads it from the TUI (`opencode/view.ts` reads it from
// `context.data`); a test writes it by hand.

/** A session family: its root and every session under it, in any order. */
export type Family = {
  readonly root: string
  readonly sessions: ReadonlyArray<Session>
}

/** One session of the family, with how the host sees it now. */
export type Session = {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  /** The agent the session runs as, when the session says. */
  readonly agent?: string
  /** How its last run ended, when the session says: `succeeded`, `failed` or `interrupted`. */
  readonly outcome?: string
  readonly time: {
    readonly created: number
    /** When its current run started. */
    readonly busy?: number
    /** When its last run stopped. */
    readonly idle?: number
    readonly updated?: number
  }
  /** Whether the host runs it now. */
  readonly running: boolean
  /** Its waiting permission requests, each as `action resource`. */
  readonly permissions: ReadonlyArray<string>
  /** Its waiting questions, by title. */
  readonly questions: ReadonlyArray<string>
  readonly messages: ReadonlyArray<Message>
}

/**
 * The messages a row reads: an assistant step with its parts, and the notice
 * a parent gets when a background subagent stops. Other messages are left
 * out.
 */
export type Message =
  | { readonly type: "assistant"; readonly agent?: string; readonly parts: ReadonlyArray<Part> }
  | {
      readonly type: "notice"
      /** The subagent session that stopped. */
      readonly childID: string
      /** As the host says it: `completed`, `error` or `cancelled`. */
      readonly state: string
      readonly at: number
      /** The notice's body: the subagent's answer, or why it failed. */
      readonly text: string
    }

/** A part of an assistant step: its words (text or reasoning), or a tool call. */
export type Part = { readonly type: "words"; readonly text: string } | Call

/** A tool call, by the name the model called it. */
export type Call = {
  readonly type: "call"
  readonly tool: string
  readonly status: "streaming" | "running" | "completed" | "error"
  readonly input: Readonly<Record<string, unknown>>
  readonly metadata: Readonly<Record<string, unknown>>
  /** A failed call's error message. */
  readonly error?: string
  readonly completed?: number
}
