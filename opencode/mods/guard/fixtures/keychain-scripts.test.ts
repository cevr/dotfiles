// The keychain rule's script catch on copied text (keychain-scripts.json, each
// entry with its source; Exact's at 7b80cf820): the run's probes that started
// a bare Chrome are refused and the one that drove agent-browser is not; none
// of Exact's 13 launches, which take their browser from chromium() and so
// honour CHROME, is refused; the 4 Exact files whose --headless is a word of
// Exact's own CLI are not either; manna's bisect is refused unless the line
// sets CHROME to the shim.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ScriptFile, scriptLaunch, scriptLaunchesBare } from "../chrome.ts"
import fixtures from "./keychain-scripts.json" with { type: "json" }

const Entry = Schema.Struct({ source: Schema.String, text: Schema.String })
const FIXTURES = Schema.decodeUnknownSync(Schema.Struct({ exactLaunches: Schema.Array(Entry), exactWords: Schema.Array(Entry), probes: Schema.Array(Entry) }))(fixtures)

/** The probe whose source ends with `source`. */
const probe = (source: string): string => Option.getOrElse(Option.map(Option.fromUndefinedOr(FIXTURES.probes.find((each) => each.source.endsWith(source))), (each) => each.text), () => "")

describe("the run's probes", () => {
  test("both rebind probes and manna's scratch shot and Puppeteer spike are refused; chrome-peers drove agent-browser and starts none", () => {
    expect(scriptLaunchesBare(probe("digest-address-only/rebind.ts"))).toBe(true)
    expect(scriptLaunchesBare(probe("round-3-receipts/rebind-chrome.ts"))).toBe(true)
    expect(scriptLaunchesBare(probe("pane-mock/shot.ts"))).toBe(true)
    expect(scriptLaunchesBare(probe("spike/spike.ts"))).toBe(true)
    expect(scriptLaunchesBare(probe("round-5-receipts/chrome-peers.ts"))).toBe(false)
  })

  test("manna's bisect runs other commits: refused with the shim as its way through, and runs with CHROME set to the shim", () => {
    const run = (shimmed: boolean) => ({ command: "bun bisect.ts lane a b", ran: ScriptFile.make({ path: "/m/hy-web-budget/bisect.ts" }), shimmed })
    expect(Option.map(scriptLaunch(run(false), probe("hy-web-budget/bisect.ts")), (launch) => launch.remedy)).toEqual(Option.some("shim"))
    expect(scriptLaunch(run(true), probe("hy-web-budget/bisect.ts"))).toEqual(Option.none())
  })
})

describe("Exact", () => {
  test("its 13 launches take their browser from chromium(), which honours CHROME: no Chrome the script names, so none is refused", () => {
    expect(FIXTURES.exactLaunches.length).toBe(13)
    for (const each of FIXTURES.exactLaunches) expect([each.source, scriptLaunchesBare(each.text)]).toEqual([each.source, false])
  })

  test("its 4 files whose --headless is a word of its own CLI are no launch", () => {
    expect(FIXTURES.exactWords.length).toBe(4)
    for (const each of FIXTURES.exactWords) expect([each.source, scriptLaunchesBare(each.text)]).toEqual([each.source, false])
  })
})
