// Pairing's rules over a stand-in keyed hash: an invite, a join that leaves
// both hosts holding each other, the refused codes, and each request refusal.
import { describe, expect, test } from "bun:test"
import { accept, authenticate, EMPTY, HEADERS, type Incoming, INVITE_MS, invited, joined, type Keyed, type Pairs, sign, SKEW_MS } from "./pairing.ts"

/** Not crypto: a keyed value that changes with the key and the text, enough to test the rules. */
const KEYED: Keyed = {
  mac: (secret, text) => `mac(${secret}:${text.length}:${[...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 1_000_000_007, 7)})`,
  hash: (text) => `hash(${text})`,
  same: (left, right) => left === right,
}

const NOW = 1_800_000_000_000
const CODE = "code-0123456789abcdef"

/** The workbox invites; the Mac joins with the code. */
const paired = () => {
  const inviter = invited(EMPTY, "workbox", CODE, NOW, KEYED)
  const accepted = accept(inviter, { code: CODE, name: "mac", url: "http://100.64.0.1:4196" }, "s3cret", NOW + 1_000, KEYED)
  if (!accepted.ok) throw new Error(accepted.reason)
  const joiner = joined({ ...EMPTY, url: "http://100.64.0.1:4196" }, "mac", { name: accepted.answer.name, url: "http://100.64.0.2:4196", secret: accepted.answer.secret }, NOW + 1_000)
  return { workbox: accepted.pairs, mac: joiner }
}

describe("pairing", () => {
  test("an invite keeps only its code's hash, under the host's name, for ten minutes", () => {
    const pairs = invited(EMPTY, "workbox", CODE, NOW, KEYED)
    expect(pairs).toEqual({ name: "workbox", peers: {}, invites: [{ hash: `hash(${CODE})`, expires: NOW + INVITE_MS }] })
    expect(JSON.stringify(pairs)).not.toContain(`"${CODE}"`)
    expect(invited(pairs, "other", "code-2", NOW + INVITE_MS, KEYED).invites.map((invite) => invite.hash)).toEqual(["hash(code-2)"])
    expect(invited(pairs, "other", "code-2", NOW, KEYED).name).toBe("workbox")
  })

  test("a join with the code leaves each host holding the other's name, address and one shared secret, and uses the code up", () => {
    const { workbox, mac } = paired()
    expect(workbox).toEqual({ name: "workbox", peers: { mac: { url: "http://100.64.0.1:4196", secret: "s3cret", paired: NOW + 1_000 } }, invites: [] })
    expect(mac).toEqual({ name: "mac", url: "http://100.64.0.1:4196", peers: { workbox: { url: "http://100.64.0.2:4196", secret: "s3cret", paired: NOW + 1_000 } }, invites: [] })
    expect(accept(workbox, { code: CODE, name: "intruder", url: "http://x" }, "other", NOW + 2_000, KEYED)).toEqual({ ok: false, reason: "the code is unknown, used or expired" })
  })

  test("a wrong code, an expired one, a bad name and the inviter's own name are refused", () => {
    const pairs = invited(EMPTY, "workbox", CODE, NOW, KEYED)
    const ask = { code: CODE, name: "mac", url: "http://100.64.0.1:4196" }
    expect(accept(pairs, { ...ask, code: "guess" }, "s", NOW, KEYED)).toMatchObject({ ok: false, reason: "the code is unknown, used or expired" })
    expect(accept(pairs, ask, "s", NOW + INVITE_MS, KEYED)).toMatchObject({ ok: false, reason: "the code is unknown, used or expired" })
    expect(accept(pairs, { ...ask, name: "a b" }, "s", NOW, KEYED)).toMatchObject({ ok: false, reason: '"a b" is not a mail name' })
    expect(accept(pairs, { ...ask, name: "workbox" }, "s", NOW, KEYED)).toMatchObject({ ok: false, reason: "workbox is this host's own name" })
  })
})

describe("a request between paired hosts", () => {
  const { workbox, mac } = paired()
  const BODY = JSON.stringify({ children: false })
  const NONCE = "nonce-0123456789ab"
  /** The Mac's signed request as the workbox's listener reads it, with `change` applied to its headers. */
  const incoming = (change: (headers: Record<string, string>) => Record<string, string> = (headers) => headers, at = NOW, body = BODY): Incoming => {
    const secret = mac.peers.workbox?.secret ?? ""
    const headers = change(sign("mac", secret, { method: "POST", path: "/mail/v1/list", body }, at, NONCE, KEYED))
    return { method: "POST", path: "/mail/v1/list", body: BODY, header: (name) => headers[name] }
  }
  const check = (request: Incoming, pairs: Pairs = workbox, seen: (nonce: string) => boolean = () => false) => authenticate(pairs, request, NOW, seen, KEYED)

  test("signed with the shared secret, it is the peer's", () => {
    expect(check(incoming())).toEqual({ ok: true, peer: "mac", nonce: NONCE })
    expect(check(incoming(undefined, NOW - SKEW_MS))).toMatchObject({ ok: true })
  })

  test("an unsigned request, an unpaired host, a bad signature, a stale time, a replay and a changed body are refused", () => {
    expect(check({ method: "POST", path: "/mail/v1/list", body: BODY, header: () => undefined })).toEqual({ ok: false, reason: "the request is not signed" })
    expect(check(incoming((headers) => ({ ...headers, [HEADERS.peer]: "laptop" })))).toEqual({ ok: false, reason: '"laptop" is not paired with this host' })
    expect(check(incoming(), { ...workbox, peers: {} })).toEqual({ ok: false, reason: '"mac" is not paired with this host' })
    expect(check(incoming((headers) => ({ ...headers, [HEADERS.signature]: "forged" })))).toEqual({ ok: false, reason: "the signature is not mac's" })
    expect(check(incoming(undefined, NOW - SKEW_MS - 1))).toEqual({ ok: false, reason: "the request's time is more than 60s off" })
    expect(check(incoming(), workbox, (nonce) => nonce === NONCE)).toEqual({ ok: false, reason: "the request was replayed" })
    expect(check(incoming(undefined, NOW, JSON.stringify({ children: true })))).toEqual({ ok: false, reason: "the signature is not mac's" })
    expect(check(incoming((headers) => ({ ...headers, [HEADERS.peer]: "__proto__" })))).toEqual({ ok: false, reason: '"__proto__" is not paired with this host' })
  })
})
