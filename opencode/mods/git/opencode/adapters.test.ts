// The OpenCode adapters over stand-in hosts: the watch store keeps watches and
// repositories under their keys, replaces by key and passes over what no
// longer decodes, across pages; the courier walks a family to its root and
// delivers a notice as a steered synthetic message that wakes the session.
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Courier, WatchStore } from "../service.ts"
import type { Watch } from "../watch.ts"
import * as Couriers from "./courier.ts"
import * as Stores from "./watch-store.ts"

const memoryStorage = (page = 2) => {
  const map = new Map<string, unknown>()
  const storage: Stores.Storage = {
    get: (key) => Effect.sync(() => map.get(key)),
    set: (key, value: Schema.Json) => Effect.sync(() => void map.set(key, value)),
    remove: (key) => Effect.sync(() => void map.delete(key)),
    scan: ({ prefix, after, limit }) =>
      Effect.sync(() => {
        const keys = [...map.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
        const taken = keys.slice(0, Math.min(limit ?? page, page))
        return { entries: taken.map((key) => ({ key })), ...(keys.length > taken.length ? { next: taken.at(-1) ?? "" } : {}) }
      }),
  }
  return { map, storage }
}

const watch = (sessionID: string, number: number, until: Watch["until"] = "green"): Watch => ({
  sessionID,
  repo: "biteinc/maitred",
  number,
  until,
  since: 1,
  last: { title: "t", url: "u", state: "OPEN", head: "h", verdict: "pending", failing: [], reviews: [], threads: 0, mergeable: "MERGEABLE" },
})

describe("the watch store in plugin storage", () => {
  test("keeps watches by session and request across pages, replaces by key, and passes over a stale entry", async () => {
    const { map, storage } = memoryStorage()
    map.set("watch:ses_x:biteinc/maitred#1", { not: "a watch" })
    const watches = await Effect.runPromise(
      WatchStore.use((store) =>
        Effect.gen(function* () {
          yield* store.put(watch("ses_a", 1))
          yield* store.put(watch("ses_a", 2))
          yield* store.put(watch("ses_b", 1))
          yield* store.put(watch("ses_a", 1, "reviewed"))
          yield* store.remove("ses_b", { repo: "biteinc/maitred", number: 1 })
          yield* store.putRepo({ repo: "biteinc/maitred", users: { ses_a: 5 } })
          yield* store.putRepo({ repo: "biteinc/maitred", users: { ses_a: 6 } })
          return { watches: yield* store.watches, repos: yield* store.repos }
        }),
      ).pipe(Effect.provide(Stores.layer(storage))),
    )
    expect(watches.watches.map((each) => [each.sessionID, each.number, each.until])).toEqual([
      ["ses_a", 1, "reviewed"],
      ["ses_a", 2, "green"],
    ])
    expect(watches.repos).toEqual([{ repo: "biteinc/maitred", users: { ses_a: 6 } }])
  })
})

describe("the courier", () => {
  const host = (parents: Record<string, string>) => {
    const sent: Array<Couriers.Synthetic> = []
    const view: Couriers.Host = {
      synthetic: (input) => (input.sessionID === "ses_gone" ? Effect.fail({ _tag: "Session.NotFoundError" }) : Effect.sync(() => void sent.push(input))),
      get: (sessionID) => Effect.succeed(parents[sessionID] === undefined ? {} : { parentID: parents[sessionID] }),
    }
    return { sent, view }
  }

  test("names a family's root and delivers a notice as a steer that wakes the session", async () => {
    const { sent, view } = host({ ses_grandchild: "ses_child", ses_child: "ses_root" })
    const [root, refused] = await Effect.runPromise(
      Courier.use((courier) =>
        Effect.gen(function* () {
          const root = yield* courier.rootOf("ses_grandchild")
          yield* courier.deliver(root, { title: "PR biteinc/maitred#1: checks pending → pass", text: "PR watch · …" })
          const refused = yield* courier.deliver("ses_gone", { title: "t", text: "x" }).pipe(Effect.flip)
          return [root, refused] as const
        }),
      ).pipe(Effect.provide(Couriers.layer(view, () => "msg_1"))),
    )
    expect(root).toBe("ses_root")
    expect(sent).toEqual([
      {
        sessionID: "ses_root",
        id: "msg_1",
        text: "PR watch · …",
        description: "PR biteinc/maitred#1: checks pending → pass",
        metadata: { [Couriers.NOTICE_KEY]: true },
        delivery: "steer",
        resume: true,
      },
    ])
    expect(refused._tag).toBe("NoticeRefused")
  })
})
