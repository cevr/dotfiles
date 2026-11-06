// Mail's handlers over a test Sessions declared here: addressing by id and by
// title, the refusals, the reply-to, delivery and its log.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Option, References } from "effect"
import type { SessionCard } from "./directory.ts"
import type { Letter } from "./letter.ts"
import { layer, Mail } from "./model.ts"
import type { Arrival, Parcel } from "./peer.ts"
import { DeliveryRefused, Peers, PeerUnreachable, Sessions, SessionsUnreadable } from "./service.ts"

const NOW = 1_000_000

const card = (id: string, fields: Partial<SessionCard> = {}): SessionCard => ({ id, directory: "/work", running: false, updated: NOW, ...fields })

const CARDS: ReadonlyArray<SessionCard> = [
  card("ses_a", { title: "Bite PR", running: true, agent: "build" }),
  card("ses_b", { title: "Dotfiles", updated: NOW - 60_000 }),
  card("ses_c", { title: "Dotfiles review", updated: NOW - 120_000 }),
  card("ses_w", { title: "Fix money", parentID: "ses_a", running: true, updated: NOW - 1_000 }),
]

interface Sent {
  readonly sessionID: string
  readonly letter: Letter
  readonly wake: boolean
}

/** A paired host as the test Peers holds it: its sessions, or why it cannot be reached. */
interface Remote {
  readonly cards?: ReadonlyArray<SessionCard>
  readonly down?: string
  readonly refuse?: string
}

/**
 * A test Sessions over `cards` and a test Peers over `peers`; `unreadable`
 * fails every read, `refuse` the inbox. A peer takes a parcel for one of its
 * cards, as its own `receive` would, and keeps it in `parcels`.
 */
const world = (options: { readonly unreadable?: boolean; readonly refuse?: boolean; readonly peers?: Readonly<Record<string, Remote>> } = {}) => {
  const parcels: Array<{ readonly peer: string; readonly parcel: Parcel }> = []
  const remotes = options.peers ?? {}
  const reach = (peer: string): Effect.Effect<Remote, PeerUnreachable> => {
    const remote = remotes[peer]
    if (remote === undefined) return Effect.fail(new PeerUnreachable({ peer, message: "not paired with this host" }))
    return remote.down === undefined ? Effect.succeed(remote) : Effect.fail(new PeerUnreachable({ peer, message: remote.down }))
  }
  const peers = Layer.succeed(
    Peers,
    Peers.of({
      names: Effect.succeed(Object.keys(remotes).toSorted()),
      sessions: (peer, { children }) => reach(peer).pipe(Effect.map((remote) => (remote.cards ?? []).filter((item) => children || item.parentID === undefined))),
      deliver: (peer, parcel) =>
        reach(peer).pipe(
          Effect.map((remote): Arrival => {
            if (remote.refuse !== undefined) return { outcome: "refused", message: remote.refuse }
            const found = remote.cards?.find((item) => item.id === parcel.to)
            if (found === undefined) return { outcome: "unknown" }
            parcels.push({ peer, parcel })
            return { outcome: "delivered", to: found, delivery: found.running ? "steered" : parcel.wake ? "woke" : "queued" }
          }),
        ),
    }),
  )
  const sent: Array<Sent> = []
  const logs: Array<{ readonly message: string; readonly annotations: Record<string, unknown> }> = []
  const read = <A>(value: A) => (options.unreadable ? Effect.fail(new SessionsUnreadable({ message: "database is locked" })) : Effect.succeed(value))
  const sessions = Layer.succeed(
    Sessions,
    Sessions.of({
      get: (sessionID) => read(Option.fromNullishOr(CARDS.find((item) => item.id === sessionID))),
      list: ({ children }) => read(CARDS.filter((item) => children || item.parentID === undefined)),
      deliver: (sessionID, letter, wake) =>
        options.refuse ? Effect.fail(new DeliveryRefused({ sessionID, message: "inbox closed" })) : Effect.sync(() => void sent.push({ sessionID, letter, wake })),
    }),
  )
  const logger = Logger.make((entry) => {
    logs.push({ message: String(Array.isArray(entry.message) ? entry.message.join(" ") : entry.message), annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) } })
  })
  const run = <A, E>(body: (mail: Mail["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* body(yield* Mail)
      }).pipe(Effect.provide(layer.pipe(Layer.provide(Layer.mergeAll(sessions, peers)))), Effect.provide(Logger.layer([logger])), Effect.result),
    )
  return { sent, logs, parcels, run }
}

describe("sending a message", () => {
  test("to an idle session by id wakes it with a letter from the sender, and logs the delivery", async () => {
    const { sent, logs, run } = world()
    const result = await run((mail) => mail.send("ses_a", { to: "ses_b", text: "rebase please" }))
    expect(result).toMatchObject({ _tag: "Success", success: { to: { id: "ses_b" }, delivery: "woke" } })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ sessionID: "ses_b", wake: true, letter: { description: "from Bite PR · rebase please" } })
    expect(sent[0]?.letter.text).toStartWith('✉ Message from session "Bite PR" (ses_a)')
    expect(sent[0]?.letter.text).toEndWith("\n\nrebase please")
    expect(logs).toEqual([
      {
        message: "mail: Bite PR → Dotfiles",
        annotations: { from: "ses_a", to: "ses_b", replyTo: "ses_a", delivery: "woke", excerpt: "rebase please" },
      },
    ])
  })

  test("to a running session by title is a steer; wake: false on an idle one leaves it queued", async () => {
    const { sent, run } = world()
    expect(await run((mail) => mail.send("ses_b", { to: "bite pr", text: "done" }))).toMatchObject({
      _tag: "Success",
      success: { to: { id: "ses_a" }, delivery: "steered" },
    })
    expect(await run((mail) => mail.send("ses_a", { to: "review", text: "later", wake: false }))).toMatchObject({
      _tag: "Success",
      success: { to: { id: "ses_c" }, delivery: "queued" },
    })
    expect(sent.map((item) => [item.sessionID, item.wake])).toEqual([
      ["ses_a", true],
      ["ses_c", false],
    ])
  })

  test("a title reaches a subagent's session too, and its parent can write to it", async () => {
    const { sent, run } = world()
    expect(await run((mail) => mail.send("ses_a", { to: "Fix money", text: "stop" }))).toMatchObject({ _tag: "Success", success: { delivery: "steered" } })
    expect(sent[0]?.sessionID).toBe("ses_w")
  })

  test("names another session to answer when given replyTo, by id or title", async () => {
    const { sent, run } = world()
    await run((mail) => mail.send("ses_w", { to: "ses_b", text: "q", replyTo: "Bite PR" }))
    expect(sent[0]?.letter.metadata.replyTo).toEqual({ sessionID: "ses_a", title: "Bite PR" })
    expect(sent[0]?.letter.metadata.from).toEqual({ sessionID: "ses_w", title: "Fix money" })
  })

  test("refuses its own session, by id or by title, and delivers nothing", async () => {
    const { sent, run } = world()
    expect(await run((mail) => mail.send("ses_a", { to: "ses_a", text: "hi" }))).toMatchObject({ _tag: "Failure", failure: { _tag: "SelfAddressed" } })
    expect(await run((mail) => mail.send("ses_a", { to: "Bite PR", text: "hi" }))).toMatchObject({ _tag: "Failure", failure: { _tag: "SelfAddressed" } })
    expect(sent).toEqual([])
  })

  test("refuses a session that does not exist, an ambiguous title, a missing reply-to and an empty text", async () => {
    const { sent, run } = world()
    expect(await run((mail) => mail.send("ses_a", { to: "ses_zzz", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NoSuchSession", to: "ses_zzz" },
    })
    expect(await run((mail) => mail.send("ses_a", { to: "dotfiles r", text: "hi" }))).toMatchObject({ _tag: "Success" })
    expect(await run((mail) => mail.send("ses_a", { to: "otfiles", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AmbiguousTitle", matches: [{ id: "ses_b" }, { id: "ses_c" }] },
    })
    expect(await run((mail) => mail.send("ses_a", { to: "ses_b", text: "hi", replyTo: "nobody" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NoSuchSession", to: "nobody" },
    })
    expect(await run((mail) => mail.send("ses_a", { to: "ses_b", text: " \n " }))).toMatchObject({ _tag: "Failure", failure: { _tag: "EmptyMessage" } })
    expect(sent.map((item) => item.sessionID)).toEqual(["ses_c"])
  })

  test("an exact title wins over a longer one that contains it", async () => {
    const { sent, run } = world()
    await run((mail) => mail.send("ses_a", { to: "dotfiles", text: "hi" }))
    expect(sent[0]?.sessionID).toBe("ses_b")
  })

  test("logs no more than 200 characters of the text", async () => {
    const { logs, run } = world()
    await run((mail) => mail.send("ses_a", { to: "ses_b", text: "y".repeat(500) }))
    expect(logs[0]?.annotations.excerpt).toBe(`${"y".repeat(199)}…`)
  })

  test("passes on an unreadable server and a refused delivery", async () => {
    expect(await world({ unreadable: true }).run((mail) => mail.send("ses_a", { to: "ses_b", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SessionsUnreadable" },
    })
    expect(await world({ refuse: true }).run((mail) => mail.send("ses_a", { to: "ses_b", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DeliveryRefused", sessionID: "ses_b" },
    })
  })
})

describe("listing the sessions", () => {
  test("gives the main sessions by default and the subagents' on request, marking the caller", async () => {
    const { run } = world()
    const main = await run((mail) => mail.sessions("ses_b", {}))
    expect(main).toMatchObject({ _tag: "Success" })
    const text = main._tag === "Success" ? main.success : ""
    expect(text.split("\n")[0]).toBe("Sessions (3):")
    expect(text).toContain('ses_b "Dotfiles" · idle · /work')
    expect(text).toContain("(you)")
    expect(text).not.toContain("ses_w")
    const all = await run((mail) => mail.sessions("ses_b", { children: true, search: "money" }))
    expect(all._tag === "Success" ? all.success : "").toMatch(/^Sessions \(1\):\nses_w "Fix money" · running · \/work · .+ · child of ses_a$/)
  })
})

const REMOTE: ReadonlyArray<SessionCard> = [
  card("ses_r1", { title: "Workbox PR", directory: "/home/me/bite", running: false, updated: Date.now() - 30_000 }),
  card("ses_r2", { title: "Workbox worker", parentID: "ses_r1", running: true, updated: Date.now() }),
]

describe("a paired host", () => {
  test("its sessions are listed beside this server's, marked with the host; one that cannot be reached is named", async () => {
    const { run } = world({ peers: { workbox: { cards: REMOTE }, laptop: { down: "it answered 401: the signature is not mac's" } } })
    const result = await run((mail) => mail.sessions("ses_a", {}))
    const text = result._tag === "Success" ? result.success : ""
    expect(text.split("\n")[0]).toBe("Sessions (4):")
    expect(text).toContain('ses_r1 "Workbox PR" · idle · /home/me/bite · 30s ago · on workbox')
    expect(text).not.toContain("ses_r2")
    expect(text.split("\n").at(-1)).toBe("laptop: unreachable (it answered 401: the signature is not mac's); its sessions are not listed.")
  })

  test("a message to an id this server lacks goes to the peer that has it, with the sender and the reply-to", async () => {
    const { sent, parcels, logs, run } = world({ peers: { laptop: { cards: [] }, workbox: { cards: REMOTE } } })
    const result = await run((mail) => mail.send("ses_a", { to: "ses_r1", text: "restart the build" }))
    expect(result).toMatchObject({ _tag: "Success", success: { to: { id: "ses_r1", host: "workbox" }, delivery: "woke" } })
    expect(sent).toEqual([])
    expect(parcels).toEqual([
      {
        peer: "workbox",
        parcel: { to: "ses_r1", from: { id: "ses_a", title: "Bite PR" }, replyTo: { id: "ses_a", title: "Bite PR" }, body: "restart the build", wake: true },
      },
    ])
    expect(logs[0]).toMatchObject({ message: "mail: Bite PR → workbox/Workbox PR", annotations: { toHost: "workbox", delivery: "woke" } })
  })

  test("an id no host has is refused, naming the hosts asked and the one that could not be", async () => {
    const { parcels, run } = world({ peers: { laptop: { down: "http://100.64.0.2:4196 did not answer: timed out" }, workbox: { cards: REMOTE } } })
    const result = await run((mail) => mail.send("ses_a", { to: "ses_zzz", text: "hi" }))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NoSuchSession", to: "ses_zzz", peers: [{ name: "laptop", missed: "http://100.64.0.2:4196 did not answer: timed out" }, { name: "workbox" }] },
    })
    expect(parcels).toEqual([])
  })

  test("with no peers an unknown id is refused as before; a peer's refusal is a refused delivery", async () => {
    const alone = await world().run((mail) => mail.send("ses_a", { to: "ses_r1", text: "hi" }))
    expect(alone).toMatchObject({ _tag: "Failure", failure: { _tag: "NoSuchSession", to: "ses_r1" } })
    expect(alone._tag === "Failure" && alone.failure._tag === "NoSuchSession" ? alone.failure.peers : "other").toBeUndefined()
    expect(await world({ peers: { workbox: { cards: REMOTE, refuse: "inbox closed" } } }).run((mail) => mail.send("ses_a", { to: "ses_r1", text: "hi" }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DeliveryRefused", sessionID: "ses_r1", message: "workbox refused it: inbox closed" },
    })
  })

  test("a title still names only this server's sessions", async () => {
    const { parcels, run } = world({ peers: { workbox: { cards: REMOTE } } })
    expect(await run((mail) => mail.send("ses_a", { to: "Workbox PR", text: "hi" }))).toMatchObject({ _tag: "Failure", failure: { _tag: "NoSuchSession" } })
    expect(parcels).toEqual([])
  })

  test("a parcel from a peer is composed here, naming the peer as the sender's host, and answers come back by id", async () => {
    const { sent, logs, run } = world()
    const parcel: Parcel = { to: "ses_b", from: { id: "ses_m", title: "Mac main" }, replyTo: { id: "ses_m", title: "Mac main" }, body: "rebase please", wake: true }
    expect(await run((mail) => mail.receive("mac", parcel))).toMatchObject({ _tag: "Success", success: { outcome: "delivered", to: { id: "ses_b" }, delivery: "woke" } })
    expect(sent[0]?.letter.text.split("\n")).toEqual([
      '✉ Message from session "Mac main" (ses_m) on host mac, sent with the message tool. It is not the user speaking.',
      'To answer, call the message tool with { "to": "ses_m", "text": "…" }; answer only if it asks for something.',
      "",
      "rebase please",
    ])
    expect(sent[0]?.letter.metadata.from).toEqual({ sessionID: "ses_m", title: "Mac main", host: "mac" })
    expect(logs[0]?.message).toBe("mail: mac/Mac main → Dotfiles")
    expect(await run((mail) => mail.receive("mac", { ...parcel, to: "ses_nowhere" }))).toMatchObject({ _tag: "Success", success: { outcome: "unknown" } })
    expect(await world({ refuse: true }).run((mail) => mail.receive("mac", parcel))).toMatchObject({
      _tag: "Success",
      success: { outcome: "refused", message: "inbox closed" },
    })
  })
})
