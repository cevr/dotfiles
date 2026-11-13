// The ChatGPT backend's laws: scripted exchanges with the three endpoints the
// pool's ChatGPT source reaches, answered alike by the world's backend
// (sim/chatgpt.ts) and the fake the real tier keeps using
// (tests/fake-chatgpt.ts). Each law reports what the pool reads of each answer
// (its status, content type and body), with times as their offset from the
// law's start in whole minutes: the fake stamps a claim's new windows on the
// wall clock, the world on its own. sim/chatgpt-laws.test.ts runs each law on
// both and asks for the same report.
import { Effect, Schema } from "effect"
import { type FakeChatGPTAccount, spentAccount } from "../tests/fake-chatgpt.ts"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** One backend as a law reaches it. */
export interface Wire {
  /** Where it answers: the fake's port, or the world's origin. */
  readonly origin: string
  /** One exchange. */
  readonly send: (request: Request) => Effect.Effect<Response>
}

export interface ChatGPTLaw {
  readonly name: string
  /** The accounts the backend knows, by `chatgpt-account-id`, at the law's start `at` (epoch ms). */
  readonly accounts: (at: number) => ReadonlyArray<readonly [string, FakeChatGPTAccount]>
  /** The exchanges: what the pool reads of each answer, one line each. */
  readonly run: (wire: Wire, read: (response: Response) => Effect.Effect<string>) => Effect.Effect<ReadonlyArray<string>>
}

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g
const RESET_AT = /"reset_at":(\d+)/g

/** What the pool reads of an answer: its status, its content type, its body with times as minutes from `at`. */
export const reading = (at: number) => (response: Response) =>
  Effect.promise(() => response.text()).pipe(
    Effect.map((body) => {
      const minutes = (ms: number) => `T${Math.round((ms - at) / MINUTE)}m`
      const timed = body.replace(ISO, (iso) => minutes(Date.parse(iso))).replace(RESET_AT, (_, seconds: string) => `"reset_at":"${minutes(Number(seconds) * 1000)}"`)
      return `${response.status} ${response.headers.get("content-type") ?? ""} ${timed}`
    }),
  )

/** The headers the pool's source sends for `account`, signed with `access`. */
const headers = (account: string, access: string) => ({
  authorization: `Bearer ${access}`,
  "chatgpt-account-id": account,
  "content-type": "application/json",
  "user-agent": "codex-cli",
})

/** A GET of `account` signed with `access`. */
const signed = (wire: Wire, path: string, account: string, access: string) =>
  new Request(`${wire.origin}${path}`, { headers: headers(account, access) })

/** A POST of `body` by `account` signed with `access`. */
const posted = (wire: Wire, path: string, account: string, access: string, body: string) =>
  new Request(`${wire.origin}${path}`, { method: "POST", headers: headers(account, access), body })

const USAGE = "/backend-api/wham/usage"
const CREDITS = "/backend-api/wham/rate-limit-reset-credits"
const CONSUME = "/backend-api/wham/rate-limit-reset-credits/consume"

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const consume = (requestID: string, creditID: string) => encode({ redeem_request_id: requestID, credit_id: creditID })

/** Sends each request in order, reading each answer. */
const exchange = (wire: Wire, read: (response: Response) => Effect.Effect<string>, requests: ReadonlyArray<Request>) =>
  Effect.forEach(requests, (request) => wire.send(request).pipe(Effect.flatMap(read)))

export const CHATGPT_LAWS: ReadonlyArray<ChatGPTLaw> = [
  {
    name: "the usage endpoint reports both windows in percent with their resets, and the credits left; the list names each credit",
    accounts: (at) => [["acct-1", spentAccount("access-1", "credit-1", at, 40, 20 * DAY)]],
    run: (wire, read) =>
      exchange(wire, read, [signed(wire, USAGE, "acct-1", "access-1"), signed(wire, CREDITS, "acct-1", "access-1")]),
  },
  {
    name: "a request without the account's own token, or for an account it does not know, is refused; an unknown path is not found",
    accounts: (at) => [["acct-1", spentAccount("access-1", "credit-1", at)]],
    run: (wire, read) =>
      exchange(wire, read, [
        signed(wire, USAGE, "acct-1", "access-2"),
        signed(wire, USAGE, "acct-2", "access-1"),
        signed(wire, "/backend-api/wham/elsewhere", "acct-1", "access-1"),
      ]),
  },
  {
    name: "a credit is consumed once: it empties both windows and restarts the week; the same request id again is already redeemed, a spent credit is none",
    accounts: (at) => [["acct-1", spentAccount("access-1", "credit-1", at, 100)]],
    run: (wire, read) =>
      exchange(wire, read, [
        posted(wire, CONSUME, "acct-1", "access-1", consume("req-1", "credit-1")),
        posted(wire, CONSUME, "acct-1", "access-1", consume("req-1", "credit-1")),
        posted(wire, CONSUME, "acct-1", "access-1", consume("req-2", "credit-1")),
        signed(wire, USAGE, "acct-1", "access-1"),
        signed(wire, CREDITS, "acct-1", "access-1"),
      ]),
  },
  {
    name: "an account with nothing spent has nothing to reset, and its credit stays",
    accounts: (at) => [["acct-1", { ...spentAccount("access-1", "credit-1", at), fiveHour: 30 }]],
    run: (wire, read) =>
      exchange(wire, read, [
        posted(wire, CONSUME, "acct-1", "access-1", consume("req-1", "credit-1")),
        posted(wire, CONSUME, "acct-1", "access-1", consume("req-2", "credit-9")),
        signed(wire, CREDITS, "acct-1", "access-1"),
      ]),
  },
]
