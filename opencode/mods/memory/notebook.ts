// The memory tools as the agent sees them: their names, inputs and
// descriptions, what each answers, and what the agent reads when one refuses.
import { Schema, SchemaGetter } from "effect"
import { MAX_TAGS, MAX_TEXT, type Note, type NoteTooLong, type EmptyNote, type EmptyQuery, type NoteNotFound, Scope, type SubagentWrite } from "./note.ts"

export const SAVE = "memory_save"
export const SEARCH = "memory_search"
export const FORGET = "memory_forget"

/** The most notes a search answers. */
export const MAX_RESULTS = 25
export const DEFAULT_RESULTS = 10

/**
 * Tags as a list, or as one comma-separated string ("tests, ci"), which models
 * often send: split on commas, trimmed, empties dropped.
 */
export const Tags = Schema.Union([
  Schema.Array(Schema.String),
  Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.transform((text: string) =>
        text
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ""),
      ),
      encode: SchemaGetter.transform((tags: ReadonlyArray<string>) => tags.join(", ")),
    }),
  ),
])

export const SaveInput = Schema.Struct({
  text: Schema.String.annotate({
    description: `The note: one self-contained line of at most ${MAX_TEXT} characters, true without this session's context (name the tool, path or person it is about)`,
  }),
  scope: Schema.optional(Scope).annotate({
    description: "global: about the user, true in every project; project (the default): this repository's conventions, commands and fixes",
  }),
  tags: Schema.optional(Tags).annotate({ description: `Up to ${MAX_TAGS} one-word tags that help a later search` }),
  id: Schema.optional(Schema.Number).annotate({ description: "A note's id (#12 → 12) to correct it in place; its text and tags are replaced" }),
})
export type SaveInput = typeof SaveInput.Type

export const SearchInput = Schema.Struct({
  query: Schema.String.annotate({ description: "Words to look for; a note matching more of them ranks higher" }),
  limit: Schema.optional(Schema.Number).annotate({ description: `How many notes to answer, at most ${MAX_RESULTS}; default ${DEFAULT_RESULTS}` }),
})
export type SearchInput = typeof SearchInput.Type

export const ForgetInput = Schema.Struct({
  id: Schema.Number.annotate({ description: "The note's id (#12 → 12)" }),
})
export type ForgetInput = typeof ForgetInput.Type

/**
 * The gotcha a session recovers from by itself, named in memory_save's description: without it agents saved what the
 * owner said and almost never a command they had to run another way (notes/memory-eval.md, round 5: on Opus 5.5,
 * gotchas saved 3 of 24 → 11 of 24, no off-list note).
 */
export const GOTCHA_SENTENCE =
  "A command that failed and worked only once you ran it another way (a variable, a flag, a wrapper, a path) is such a fix: save the way that works, so the next session does not fail first."

export const SAVE_DESCRIPTION = [
  "Save a note to long-term memory, kept on this machine across sessions. Later sessions start with the most useful notes in their system prompt, and memory_search finds the rest.",
  `Save what a later session could not read off the code or the screen and would want: a durable fact about the user, a preference or correction they gave ("use bun, not npm"), a convention of this project, a fix that took real effort and its cause. ${GOTCHA_SENTENCE} Save it when the user asks you to remember something, and when something is clearly worth keeping.`,
  "Do not save task state, progress, plans, what you just did, anything the repository or its docs already say, or a guess you have not checked. Never save a secret, token or credential.",
  "A note that repeats one already kept updates that note instead of adding another. To correct a wrong note, save with its id; to remove it, memory_forget. A subagent does not save: it puts what is worth keeping in its answer.",
].join("\n\n")

export const SEARCH_DESCRIPTION = [
  "Search long-term memory: the notes earlier sessions saved with memory_save, this project's and the global ones, ranked by how well they match.",
  "Search before you ask the user something they may have told an earlier session, and when the start-of-session memory block hints there is more. Past conversations themselves are not here; this holds only the saved notes.",
].join("\n\n")

export const FORGET_DESCRIPTION =
  "Delete a long-term memory note by its id (#12 → 12): one that turned out wrong, outdated, or not worth keeping. To correct a note instead, call memory_save with its id."

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** A note as a result line. */
export const resultLine = (note: Note): string =>
  `#${note.id} [${note.scope}] ${note.text}${note.tags.length === 0 ? "" : ` [${note.tags.join(", ")}]`} · updated ${day(note.updated)}`

/** What a save did. */
export type Saved =
  | { readonly kind: "added"; readonly note: Note }
  | { readonly kind: "merged"; readonly note: Note; readonly was: string }
  | { readonly kind: "corrected"; readonly note: Note; readonly was: string }

export const savedText = (saved: Saved): string => {
  if (saved.kind === "added") return `Saved #${saved.note.id} (${saved.note.scope}).`
  if (saved.kind === "merged") return `Updated #${saved.note.id} (${saved.note.scope}), which said nearly the same: "${saved.was}". It now reads as you wrote it.`
  return `Corrected #${saved.note.id} (${saved.note.scope}); it said: "${saved.was}".`
}

export const foundText = (query: string, notes: ReadonlyArray<Note>): string =>
  notes.length === 0 ? `No note matches "${query}".` : [`${notes.length} note${notes.length === 1 ? "" : "s"} for "${query}":`, ...notes.map(resultLine)].join("\n")

export const forgotText = (note: Note): string => `Forgot #${note.id}: "${note.text}".`

export type Rejection = EmptyNote | NoteTooLong | NoteNotFound | EmptyQuery | SubagentWrite

/** What the agent reads when a call is refused. */
export const explain = (rejection: Rejection): string => {
  switch (rejection._tag) {
    case "EmptyNote":
      return "The note is empty: write the fact to keep."
    case "NoteTooLong":
      return `The note is ${rejection.length} characters; the limit is ${rejection.limit}. Keep one fact per note: shorten it or split it.`
    case "NoteNotFound":
      return `No note #${rejection.id} in this project or the global notes. memory_search finds the ids.`
    case "EmptyQuery":
      return `"${rejection.query}" has no words to search for.`
    case "SubagentWrite":
      return "A subagent does not write memory: put what is worth keeping in your answer, and the session that started you saves it."
  }
}
