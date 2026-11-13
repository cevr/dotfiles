// The pair command and the listener together, in this process: two hosts'
// listeners on loopback ports, each over its own pairing file. The workbox
// invites, the Mac joins; then each lists the other's sessions and hands it a
// parcel over signed HTTP, and requests that are unpaired, forged or replayed
// are refused and logged. tests/mail-peer.test.ts does the same between two
// real OpenCode servers.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Logger, Scope } from "effect"
import type { SessionCard } from "@dotfiles/opencode-mail/directory"
import * as FilePairs from "@dotfiles/opencode-mail/filestore/pairs"
import * as Listener from "@dotfiles/opencode-mail/http/listener"
import * as HttpPeers from "@dotfiles/opencode-mail/http/peers"
import { keyed, token, tokens } from "@dotfiles/opencode-mail/node/keyed"
import { HEADERS, sign } from "@dotfiles/opencode-mail/pairing"
import { ROUTES, type Parcel } from "@dotfiles/opencode-mail/peer"
import { type Net, PairStore, Peers, type Tokens } from "@dotfiles/opencode-mail/service"
import { pair } from "./pair.ts"

const root = mkdtempSync(join(tmpdir(), "mail-pair-"))
const scope = Effect.runSync(Scope.make())
afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  rmSync(root, { recursive: true, force: true })
})

/** A host: its pairing file, its listener on a loopback port, and what it was handed and logged. */
const host = async (name: string, cards: ReadonlyArray<SessionCard>) => {
  const file = join(root, name, "pairs.json")
  const store = FilePairs.layer(file)
  const received: Array<{ readonly peer: string; readonly parcel: Parcel }> = []
  const logs: Array<string> = []
  const logger = Logger.make((entry) => void logs.push(String(Array.isArray(entry.message) ? entry.message.join(" ") : entry.message)))
  const outside = Layer.mergeAll(store, HttpPeers.liveNet, tokens)
  const context = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(outside, HttpPeers.layer(keyed).pipe(Layer.provide(outside)), Logger.layer([logger])), scope))
  const handlers: Listener.Handlers = {
    cards: ({ children }) => Effect.succeed(cards.filter((card) => children || card.parentID === undefined)),
    receive: (peer, parcel) =>
      Effect.sync(() => {
        const found = cards.find((card) => card.id === parcel.to)
        if (found === undefined) return { outcome: "unknown" as const }
        received.push({ peer, parcel })
        return { outcome: "delivered" as const, to: found, delivery: "woke" as const }
      }),
  }
  await Effect.runPromise(Listener.serve({ hostname: "127.0.0.1", port: 0 }, handlers, keyed).pipe(Effect.provide(context), Scope.provide(scope)))
  const run = <A, E>(effect: Effect.Effect<A, E, PairStore | Peers | Net | Tokens>) => Effect.runPromise(effect.pipe(Effect.provide(context)))
  const url = (await run(Effect.flatMap(PairStore, (pairs) => pairs.read))).url ?? ""
  return { name, file, url, received, logs, run, command: (...args: ReadonlyArray<string>) => run(pair([...args, "--name", name], "pair.ts")) }
}

const card = (id: string, title: string): SessionCard => ({ id, title, directory: "/work", running: false, updated: 1 })

describe("pairing two hosts", async () => {
  const workbox = await host("workbox", [card("ses_w1", "Workbox PR")])
  const mac = await host("mac", [card("ses_m1", "Mac main")])

  test("invite prints the join command; join pairs both ways, and the files are the owner's alone", async () => {
    expect(workbox.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const invite = await workbox.command("invite")
    if (!invite.ok) throw new Error(invite.error)
    const join = /bun pair\.ts join (\S+) (\S+)/.exec(invite.out)
    expect(join?.[1]).toBe(workbox.url)
    expect(invite.out).toContain(`This host is workbox, listening at ${workbox.url}.`)
    const joined = await mac.command("join", join?.[1] ?? "", join?.[2] ?? "")
    expect(joined).toEqual({ ok: true, out: `Paired: this host is mac; workbox is at ${workbox.url}.` })

    const listed = await mac.command("list")
    expect(listed.ok && listed.out).toStartWith(`This host: mac at ${mac.url}\nworkbox at ${workbox.url}, paired `)
    const [macFile, workboxFile] = [JSON.parse(readFileSync(mac.file, "utf8")), JSON.parse(readFileSync(workbox.file, "utf8"))]
    expect(macFile.peers.workbox.secret).toBe(workboxFile.peers.mac.secret)
    expect(workboxFile.peers.mac.url).toBe(mac.url)
    expect(workboxFile.invites).toEqual([])
    expect(listed.ok && listed.out).not.toContain(macFile.peers.workbox.secret)
    expect(statSync(mac.file).mode & 0o777).toBe(0o600)
    expect(statSync(workbox.file).mode & 0o777).toBe(0o600)

    // The code is used up.
    expect(await mac.command("join", join?.[1] ?? "", join?.[2] ?? "")).toMatchObject({ ok: false, error: expect.stringContaining("the code is unknown, used or expired") })
    expect(workbox.logs.some((line) => line.includes("refused /mail/v1/pair") && line.includes("the code is unknown, used or expired"))).toBe(true)
  })

  test("a code that starts with -- is a code, not a flag: join sends it to the inviter", async () => {
    // A base64url code starts with `--` once in 4096 (SIM_SEED=121415603 of mail-peer.sim.test.ts drew one).
    expect(await mac.command("join", workbox.url, "--AbCdEfGhIjKlMnOpQrSt")).toMatchObject({
      ok: false,
      error: expect.stringContaining("the code is unknown, used or expired"),
    })
  })

  test("each host lists the other's sessions and hands it a parcel", async () => {
    const parcel = (to: string): Parcel => ({ to, from: { id: "ses_x", title: "X" }, replyTo: { id: "ses_x", title: "X" }, body: "hi", wake: true })
    expect(await mac.run(Effect.flatMap(Peers, (peers) => peers.names))).toEqual(["workbox"])
    expect(await mac.run(Effect.flatMap(Peers, (peers) => peers.sessions("workbox", { children: false })))).toEqual([card("ses_w1", "Workbox PR")])
    expect(await mac.run(Effect.flatMap(Peers, (peers) => peers.deliver("workbox", parcel("ses_w1"))))).toMatchObject({ outcome: "delivered", to: { id: "ses_w1" } })
    expect(await workbox.run(Effect.flatMap(Peers, (peers) => peers.deliver("mac", parcel("ses_m1"))))).toMatchObject({ outcome: "delivered", to: { id: "ses_m1" } })
    expect(await workbox.run(Effect.flatMap(Peers, (peers) => peers.deliver("mac", parcel("ses_none"))))).toEqual({ outcome: "unknown" })
    // Each parcel goes with an id of its own, which the receiving host holds it once by.
    const id = expect.stringMatching(/^[A-Za-z0-9_-]{22}$/)
    expect(workbox.received).toEqual([{ peer: "mac", parcel: { ...parcel("ses_w1"), id } }])
    expect(mac.received).toEqual([{ peer: "workbox", parcel: { ...parcel("ses_m1"), id } }])
  })

  test("an unpaired host, a forged signature and a replay are refused with 401 and logged", async () => {
    const body = JSON.stringify({ children: false })
    const post = (headers: Record<string, string>) =>
      fetch(new URL(ROUTES.list, workbox.url), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body })
    const secret = JSON.parse(readFileSync(mac.file, "utf8")).peers.workbox.secret as string
    const signed = sign("mac", secret, { method: "POST", path: ROUTES.list, body }, Date.now(), token(16), keyed)

    const stranger = await post(sign("laptop", "guess", { method: "POST", path: ROUTES.list, body }, Date.now(), token(16), keyed))
    expect([stranger.status, await stranger.json()]).toEqual([401, { reason: '"laptop" is not paired with this host' }])
    const forged = await post({ ...signed, [HEADERS.signature]: "AAAA" })
    expect([forged.status, await forged.json()]).toEqual([401, { reason: "the signature is not mac's" }])
    expect((await post(signed)).status).toBe(200)
    const replay = await post(signed)
    expect([replay.status, await replay.json()]).toEqual([401, { reason: "the request was replayed" }])
    expect((await post({})).status).toBe(401)
    expect(workbox.logs.filter((line) => line.startsWith("mail listener: refused /mail/v1/list"))).toHaveLength(4)
  })

  test("forget drops a peer, after which its requests are refused", async () => {
    expect(await workbox.command("forget", "mac")).toEqual({ ok: true, out: "Forgot mac." })
    const answer = await mac.run(Effect.flip(Effect.flatMap(Peers, (peers) => peers.sessions("workbox", { children: false }))))
    expect(answer).toMatchObject({ _tag: "PeerUnreachable", peer: "workbox", message: 'it answered 401: "mac" is not paired with this host' })
  })
})

describe("the listener", () => {
  test("refuses a wildcard address and listens nowhere", async () => {
    const logs: Array<string> = []
    const logger = Logger.make((entry) => void logs.push(String(entry.message)))
    await Effect.runPromise(
      Effect.scoped(
        Listener.serve({ hostname: "0.0.0.0", port: 0 }, { cards: () => Effect.succeed([]), receive: () => Effect.succeed({ outcome: "unknown" }) }, keyed).pipe(
          Effect.provide(Layer.mergeAll(FilePairs.layer(join(root, "wild", "pairs.json")), HttpPeers.liveNet, tokens)),
          Effect.provide(Logger.layer([logger])),
        ),
      ),
    )
    expect(logs).toEqual(['mail listener: refusing to listen on "0.0.0.0", every interface; give one address (the host\'s Tailscale address)'])
  })
})
