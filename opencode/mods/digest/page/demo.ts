// The page on invented data, for a look or a headless check: writes a log of made-up runs into a scratch folder and
// serves the built page over it on 127.0.0.1, exactly as the digest plugin does (cmd/digest/server.ts handlersOf).
// Nothing here is real: names, texts and times are invented, relative to now.
//
//   bun mods/digest/page/demo.ts --dir <scratch folder> [--port 8291] [--seed full
//                                [--name macbook --peers workbox=8292,spare=8293]|empty|one|xss] [--as tailnet [--read member]]
//
// `--as tailnet` serves 127.0.0.1 as the tailnet listener does (its policy: nothing but pairing until paired), for
// a look at the unpaired page without binding the tailnet. `--read member` serves it with digest.tailnetRead
// "member", as his hosts ship it: the digest for every member, marks and answers once paired.
//
// `--name` and `--peers` make it one host of several (peers.ts): each peer is another demo on 127.0.0.1 at its port,
// read every 2 s through its `/peer/view.json`; a port where no demo runs is a host that is down.
//
// `full` holds three projects: Harbor (a red message, two open questions pinned, a decision, units with rounds, one
// message set aside for Later), Lantern (500 messages over 30 days) and Quarry (one message). `xss` holds one project
// whose every shown text is script-shaped, for the check that the page renders it as text and runs none of it.
import { parseArgs } from "node:util"
import { Duration, Effect, Option, Ref } from "effect"
import { handlersOf } from "../../../cmd/digest/server.ts"
import { DigestEvent as E, encodeLine, VERSION } from "../event.ts"
import * as FileLog from "../filestore/log.ts"
import * as FileMarks from "../filestore/marks.ts"
import * as FilePairing from "../filestore/pairing.ts"
import type { Answerers } from "../answers.ts"
import { listen } from "../http/listener.ts"
import { pull, servePeers, unreadAll } from "../http/peers.ts"
import * as LivePeers from "../process/peers.ts"
import { markOf, sinceOf } from "../marks.ts"
import { nextMorning } from "../zone.ts"

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { dir: { type: "string" }, port: { type: "string" }, seed: { type: "string" }, zone: { type: "string" }, as: { type: "string" }, read: { type: "string" }, name: { type: "string" }, peers: { type: "string" } } })
const dir = values.dir ?? ""
if (dir === "") throw new Error("usage: bun mods/digest/page/demo.ts --dir <scratch folder> [--port 8291] [--seed full|empty|one|xss] [--zone America/Montreal]")
const zone = values.zone ?? "America/Montreal"
const NOW = Date.now()
const H = 3_600_000
const v = VERSION
const none = Option.none<string>()

/** A seeded generator (mulberry32), so the 500 messages are the same each run. */
const random = (start: number) => {
  let seed = start
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const run = (root: string, repo: string, t: number) => E.cases.Run.make({ v, t, root, host: "mac", repo, dir: none, name: Option.some(repo) })
const lane = (root: string, unit: string, purpose: string, t: number) => E.cases.Lane.make({ v, t, root, unit, purpose: Option.some(purpose), branch: Option.some(`feat/${unit}`), path: none })
const item = (root: string, id: string, text: string, t: number, extra: { readonly state?: string; readonly level?: "red" | "amber" | "green"; readonly unit?: string } = {}) =>
  E.cases.Item.make({ answer: Option.none(), choices: Option.none(), v, t, root, id, text, state: extra.state ?? "running", owner: "mine", who: none, level: Option.fromUndefinedOr(extra.level), unit: Option.fromUndefinedOr(extra.unit) })
const back = (root: string, unit: string, round: number, t: number, digest: string) =>
  E.cases.HandBack.make({ v, t, root, session: `s-${unit}-${round}`, role: "implementor", unit, round, verdict: "ready", file: Option.some(`/runs/${root}/${unit}/round-${round}-request.md`), digest: Option.some(digest) })
const verdict = (root: string, batch: string, round: number, t: number, units: ReadonlyArray<{ readonly unit: string; readonly round: number; readonly verdict: string }>, digest: string) =>
  E.cases.Verdict.make({ v, t, root, session: `s-v-${batch}`, batch, round, verdict: units.every((each) => each.verdict === "accepted") ? "accepted" : "changes", file: Option.some(`/runs/${root}/${batch}/findings.md`), digest: Option.some(digest), units })
const ask = (root: string, id: string, question: string, options: ReadonlyArray<string>, assume: string, t: number) =>
  E.cases.Asked.make({ v, t, root, session: `s-ask-${id}`, id, question, header: none, options, assume })

const harbor = (): ReadonlyArray<E> => {
  const r = "r-harbor"
  return [
    run(r, "harbor", NOW - 50 * H),
    lane(r, "billing", "Bill each seat once", NOW - 46 * H),
    lane(r, "search", "Search answers in under 200 ms", NOW - 40 * H),
    lane(r, "importer", "Import the 2019 archive", NOW - 30 * H),
    back(r, "billing", 1, NOW - 40 * H, "Each seat is billed once. The invoice test is green and the double charge from March is gone."),
    verdict(r, "batch-a", 1, NOW - 38 * H, [{ unit: "billing", round: 1, verdict: "changes" }], "Billing needs one more round. A refund still charges the seat twice when the plan changes mid-month."),
    back(r, "billing", 2, NOW - 30 * H, "Refunds credit the seat once. The mid-month plan change has its own test now."),
    back(r, "search", 1, NOW - 28 * H, "Search answers in 140 ms at the 95th percentile. The index is rebuilt nightly."),
    verdict(r, "batch-b", 1, NOW - 26 * H, [{ unit: "billing", round: 2, verdict: "accepted" }, { unit: "search", round: 1, verdict: "accepted" }], "Billing and search are accepted. Both land together this morning."),
    ask(r, "q1", "Keep the old CSV export for one more release? Two customers still download it weekly.", ["Keep it", "Cut it"], "Keep it", NOW - 20 * H),
    item(r, "importer", "The importer stops at row 4,812. A null currency in the 2019 archive breaks the parse; the unit waits for a decision on defaulting it.", NOW - 9 * H, { level: "red", unit: "importer" }),
    E.cases.Answered.make({ via: Option.none(), v, t: NOW - 7 * H, root: r, session: "s-ask-q0", id: "q0", answer: "Weekly", matches: false, question: Option.some("How often should the archive import run?"), assume: Option.some("Nightly") }),
    item(r, "search-ship", "Search ships to everyone. The index rebuild took 11 minutes and nothing timed out.", NOW - 5 * H, { state: "done", level: "green" }),
    ask(r, "q2", "Name the new billing page Plans or Pricing?", ["Plans", "Pricing"], "Plans", NOW - 3 * H),
    item(r, "docs", "The billing guide is rewritten for the new plans. A review is open.", NOW - 1.5 * H, { state: "running" }),
  ]
}

const lantern = (): ReadonlyArray<E> => {
  const r = "r-lantern"
  const next = random(5)
  const items = Array.from({ length: 500 }, (_, at) => {
    const t = NOW - Math.floor(next() * 29.5 * 24 * H)
    const red = next() < 0.02
    return item(r, `sync-${at}`, `Nightly sync ${1000 + at} finished: ${Math.floor(next() * 900) + 20} records moved, ${Math.floor(next() * 4)} skipped.`, t, { state: "done", ...(red ? { level: "red" as const, state: "running" } : {}) })
  })
  return [run(r, "lantern", NOW - 31 * 24 * H), ...items]
}

const quarry = (): ReadonlyArray<E> => {
  const r = "r-quarry"
  return [run(r, "quarry", NOW - 4 * H), item(r, "setup", "The quarry map loads offline. The first survey is imported.", NOW - 2 * H, { state: "done" })]
}

/** Script-shaped text: were any of it run, it would set `window.pwned` and write `pwned` to localStorage. */
const X = `<img src=x onerror="window.pwned=1;localStorage.setItem('pwned','1')"><script>window.pwned=1</script>`

/** `xss`: one project whose every shown text is script-shaped: its name, a lane's path, a question and its options, an answer, an item. */
const xss = (): ReadonlyArray<E> => {
  const r = "r-xss"
  return [
    E.cases.Run.make({ v, t: NOW - 4 * H, root: r, host: "mac", repo: `repo ${X}`, dir: Option.some(`/tmp/${X}`), name: Option.some(`Project ${X}`) }),
    E.cases.Lane.make({ v, t: NOW - 4 * H, root: r, unit: "inject", purpose: Option.some(`Purpose ${X}`), branch: Option.some(`feat/${X}`), path: Option.some(`/work/${X}`) }),
    back(r, "inject", 1, NOW - 3 * H, `Hand-back ${X}`),
    ask(r, "q9", `Question ${X}`, [`Option ${X}`, "Plain"], `Assume ${X}`, NOW - 2 * H),
    E.cases.Answered.make({ via: Option.some("tray"), v, t: NOW - 1.5 * H, root: r, session: "s-ask-q8", id: "q8", answer: `Answer ${X}`, matches: false, question: Option.some(`Asked ${X}`), assume: Option.some("Plain") }),
    item(r, "inject-item", `Item ${X}`, NOW - H, { state: "needs-you" }),
  ]
}

const seed = values.seed ?? "full"
const events: ReadonlyArray<E> = seed === "empty" ? [] : seed === "one" ? quarry() : seed === "xss" ? xss() : [...harbor(), ...lantern(), ...quarry()]
const log = FileLog.make(dir)
const marks = FileMarks.make(dir)
await Effect.runPromise(Effect.forEach(events, (event) => log.append(encodeLine(event), event.t), { discard: true }))
if (seed === "full") {
  // He first came a day and a half ago, read the importer's red message, and set the shipped search aside.
  await Effect.runPromise(marks.append(sinceOf(NOW - 36 * H)))
  await Effect.runPromise(marks.append(markOf("item:r-harbor:importer", NOW - 8 * H, "read")))
  await Effect.runPromise(marks.append(markOf("item:r-harbor:search-ship", NOW - 4 * H, "later", Option.some(nextMorning(NOW - 4 * H, zone)))))
}
const port = Number(values.port ?? "8291")
const dist = new URL("./dist", import.meta.url).pathname
// Answers go nowhere real: a question's is written to the demo's own log as the questions plugin's line would be
// (from the page), so the page shows it decided; a queue item's is refused.
const asked = new Map(events.flatMap((event) => (event._tag === "Asked" ? [[`${event.session}\n${event.id}`, event] as const] : [])))
const answerers: Answerers = {
  question: (session, id, answer) =>
    Option.match(Option.fromUndefinedOr(asked.get(`${session}\n${id}`)), {
      onNone: () => Effect.succeed({ ok: false, message: "no such question in the demo" }),
      onSome: (question) =>
        Effect.as(
          Effect.orDie(
            log.append(
              encodeLine(E.cases.Answered.make({ v, t: Date.now(), root: question.root, session, id, answer, matches: answer === question.assume, question: Option.some(question.question), assume: Option.some(question.assume), via: Option.some("page") })),
              Date.now(),
            ),
          ),
          { ok: true },
        ),
    }),
  item: () => Effect.succeed({ ok: false, message: "the demo answers questions only" }),
}
// One pairing code for the check: printed, never kept but as its hash.
const code = await Effect.runPromise(FilePairing.make(dir).issue(Date.now()))
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const named = (values.peers ?? "").split(",").filter((each) => each.includes("=")).map((each) => ({ name: each.split("=")[0] ?? "", host: each.split("=")[0] ?? "", port: Number(each.split("=")[1]) }))
      const peers = yield* Ref.make(unreadAll(named))
      const located = new Map(named.map((each) => [each.name, { name: each.name, base: `http://127.0.0.1:${each.port}` }] as const))
      yield* Effect.forkScoped(servePeers(pull(named, Effect.succeed(located), LivePeers.get, peers, Effect.sync(() => Date.now())), Duration.seconds(2)))
      const options = { dir, timezone: zone, ...(values.read === "member" ? { tailnetRead: "member" as const } : {}), ...(values.name === undefined ? {} : { name: values.name, peers: named.map(({ name, host }) => ({ name, host })) }) }
      const bound = yield* listen({ address: "127.0.0.1", port, listener: values.as === "tailnet" ? "tailnet" : "loopback", names: [] }, handlersOf(options, log, answerers, undefined, Ref.get(peers)), dist)
      console.log(`digest demo (${seed}): http://${bound.hostname}:${bound.port}/#pair=${code}`)
      yield* Effect.never
    }),
  ),
)
