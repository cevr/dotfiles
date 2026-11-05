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
  /** The model it runs on, by id as its latest step says, else as the session says (`claude-opus-5-5`). */
  readonly model?: string
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
  /**
   * The latch a held start waits on, when the session is a latched child (the
   * wakes' mark in its metadata, mods/wake latch.ts): what holds it, why, when
   * it opens and when it latched (epoch ms), and, once it will not open, when
   * it was cancelled or why it failed.
   */
  readonly latch?: Latch
  /** Its waiting permission requests, each as `action resource`. */
  readonly permissions: ReadonlyArray<string>
  /** Its waiting questions, by title. */
  readonly questions: ReadonlyArray<string>
  readonly messages: ReadonlyArray<Message>
}

/** A latched child's latch, as its row reads it. */
export type Latch = {
  /** `pace` or `sabbath`. */
  readonly hold: string
  readonly reason: string
  readonly opensAt: number
  readonly at: number
  readonly cancelledAt?: number
  readonly failed?: string
}

/**
 * The messages a row reads: an assistant step with its parts, the notice a
 * parent gets when a background subagent stops, and the notice a session
 * gets when one of its background shell commands stops. Other messages are
 * left out.
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
  | {
      readonly type: "shell"
      /** The background shell that stopped, as its call's result named it. */
      readonly shellID: string
      /** As the host says it: `completed`, `error` or `cancelled`. */
      readonly state: string
      readonly at: number
    }

/** A part of an assistant step: its words (text or reasoning), or a tool call. */
export type Part = Words | Call

/** Words the model wrote or thought, with when, if the data says (the reasoning's end, else its step's). */
export type Words = { readonly type: "words"; readonly text: string; readonly at?: number }

/** A tool call, by the name the model called it. */
export type Call = {
  readonly type: "call"
  readonly tool: string
  readonly status: "streaming" | "running" | "completed" | "error"
  readonly input: Readonly<Record<string, unknown>>
  readonly metadata: Readonly<Record<string, unknown>>
  /** A failed call's error message. */
  readonly error?: string
  /** When it started running (else when its input started), if the data says. */
  readonly started?: number
  readonly completed?: number
  /**
   * A kernel call's record of the tools its cell called, in the order they
   * started (mods/kernel/operations.ts). Each one's metadata is the record's
   * brief of its result (an exit code, a subagent's session, a background
   * shell's ID); none carries a time.
   */
  readonly calls?: ReadonlyArray<Call>
}
