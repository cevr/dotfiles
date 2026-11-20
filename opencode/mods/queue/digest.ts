// The queue's facts for the digest: one line per item a change wrote, as it now stands, and one per item it removed.
// An item the change left as it was writes nothing.
import { Array as Arr, Option, Schema } from "effect"
import { DigestEvent, VERSION } from "@dotfiles/opencode-digest/event"
import { Item } from "./item.ts"

const itemText = Schema.encodeSync(Schema.fromJsonString(Item))
const sameItem = (a: Item, b: Item): boolean => itemText(a) === itemText(b)

/** The digest lines of a change of `root`'s queue from `before` to `after` at `t`. */
export const changesOf = (root: string, before: ReadonlyArray<Item>, after: ReadonlyArray<Item>, t: number): ReadonlyArray<DigestEvent> => {
  const was = new Map(before.map((item) => [item.id, item]))
  const now = new Set(after.map((item) => item.id))
  const written = after.flatMap((item) =>
    Arr.filter([item], (each) => Option.match(Option.fromUndefinedOr(was.get(each.id)), { onNone: () => true, onSome: (old) => !sameItem(old, each) })),
  )
  return [
    ...written.map((item) =>
      DigestEvent.cases.Item.make({
        v: VERSION,
        t,
        root,
        id: item.id,
        text: item.text,
        state: item.state,
        owner: item.owner,
        who: Option.fromUndefinedOr(item.who),
        level: Option.fromUndefinedOr(item.level),
        unit: Option.fromUndefinedOr(item.unit),
      }),
    ),
    ...before.flatMap((item) => Arr.filter([item], (each) => !now.has(each.id))).map((item) => DigestEvent.cases.ItemGone.make({ v: VERSION, t, root, id: item.id })),
  ]
}
