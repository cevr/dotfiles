// What the `queue` tool tells the agent, and the text it answers with: the
// queue as the agent wrote it, one line per item with its id.
import { GLYPHS, type Mark } from "./board.ts"
import { STATES, type Item } from "./item.ts"

export const DESCRIPTION = [
  "Your live queue, shown to the owner in the session sidebar like a to-do list. Keep it current as work starts, finishes, gets scheduled, waits on someone, or needs the owner: call it the moment an item changes, not at the end of the turn. Prefer a patch (upsert, remove) to rewriting the whole list (set).",
  `Each item: id (a short slug you choose and keep), text (one line), state (${STATES.join(", ")}), owner (mine, the default, or other for another session's or agent's work, with who), at (ISO 8601; required for scheduled), detail (a few words: a pane, what it waits on).`,
  "needs-you is what only the owner can do (a decision, a login, an irreversible action); done items stay visible for ten minutes.",
  "When you start a subagent, add an item with session set to its sessionID (from the subagent tool's result): the sidebar then shows that session's live state (running, blocked, done, failed), so do not copy its status into state or update it as it runs. Running subagents without an item still show, under their call's description.",
  "Answers with the queue as it now stands.",
].join("\n\n")

/** The queue as the tool answers with it. */
export const listing = (items: ReadonlyArray<Item>): string =>
  items.length === 0
    ? "The queue is empty."
    : [
        `Queue (${items.length}):`,
        ...items.map((item) =>
          [
            `${GLYPHS[item.state satisfies Mark]} ${item.id} [${item.state}${item.owner === "other" ? `, ${item.who ?? "other"}` : ""}]: ${item.text}`,
            item.at === undefined ? undefined : `at ${item.at}`,
            item.session === undefined ? undefined : `session ${item.session}`,
            item.detail,
          ]
            .filter((part) => part !== undefined)
            .join(" · "),
        ),
      ].join("\n")
