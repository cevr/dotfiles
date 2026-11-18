// What the `queue` tool tells the agent, and the text it answers with: the
// queue as the agent wrote it, one line per item with its id.
import { GLYPHS, type Mark } from "./board.ts"
import { Array as Arr, Option } from "effect"
import { STATES, type Item } from "./item.ts"

export const DESCRIPTION = [
  "Your live queue: the record of your work in flight. The owner reads it in the Queue tab (/queue; the bar under the composer counts it), so your replies carry no queue or next-steps list. Keep it current the moment an item changes: work starts, finishes, gets scheduled, waits on someone, or needs the owner. Prefer a patch (upsert, remove) to rewriting the whole list (set).",
  "One item per running agent, monitor, wait, next step, dated item and owner item.",
  `Each item: id (a short slug you choose and keep), text (one line), state (${STATES.join(", ")}), owner (mine, the default, or other for another session's or agent's work, with who), at (ISO 8601; required for scheduled), detail (a few words: a pane, what it waits on).`,
  "needs-you is what only the owner can do (a decision, a login, an irreversible action); done items stay visible for ten minutes.",
  "When you start a subagent, add an item with session set to its sessionID (from the subagent tool's result): the queue then shows that session's live state (running, blocked, done, failed), so leave the item as written while it runs. A subagent without an item does not show in the queue.",
  "The Queue tab draws the plan as a state machine. When you start a unit or a verifier, set after (the ids it waits on) and on (each outcome and what follows: an item id or a few words), one line each: on {accepted: 'land', changes: 'fix-r2', failed: 'tell owner'}.",
  "The owner can press an item to answer it: give choices (at most 4 {label, description?}, as ask_user_async's options) for the answers you expect, else they pick done, still needed or type their own; the answer arrives as a message 'Owner on queue item <id> (<text>): <answer>', and you decide what follows (set it done, remove it, act), which your next write of the item records.",
  "A queue check note lists items that look stale (a finished subagent, an ended monitor, a needs-you with no open question, an item untouched for hours): check each, then set it done, remove it, or upsert it as it is to mark it checked.",
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
            ...Option.match(Option.fromNullishOr(item.after), { onNone: Arr.empty, onSome: (ids) => [`after ${ids.join(", ")}`] }),
            ...Object.entries(Option.getOrElse(Option.fromNullishOr(item.on), () => ({}))).map(([outcome, next]) => `on ${outcome} ⇥ ${next}`),
            item.detail,
          ]
            .filter((part) => part !== undefined)
            .join(" · "),
        ),
      ].join("\n")
