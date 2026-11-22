// The health line: its fields in order, `none` for an empty log and no peers, a sick line squeezed to one line, and
// the build read from an installed tree's path (`dev` from a checkout). Paths and hosts are invented.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { buildOf, healthLine, isWell, sickLine } from "./health.ts"

describe("the health line", () => {
  test("its fields; an empty log; peers when there are some", () => {
    const facts = { build: "2.3.0-prime.aaaa.bbbb.tree", host: "harbor", events: 0, last: Option.none(), peers: [], tailnet: "no:no-cli" } as const
    expect(healthLine(facts)).toBe("digest ok 2.3.0-prime.aaaa.bbbb.tree host=harbor events=0 last=none peers=none tailnet=no:no-cli")
    expect(healthLine({ ...facts, events: 12, last: Option.some(Date.parse("2026-11-20T12:00:00Z")), peers: [{ name: "workbox", age: 40 }], tailnet: "yes" })).toBe(
      "digest ok 2.3.0-prime.aaaa.bbbb.tree host=harbor events=12 last=2026-11-20T12:00:00.000Z peers=workbox:40s tailnet=yes",
    )
    expect(isWell(healthLine(facts))).toBe(true)
  })

  test("a sick line is one line, and not well", () => {
    const line = sickLine("dev", "harbor", "EACCES:\n  permission denied")
    expect([line, isWell(line)]).toEqual(["digest sick dev host=harbor EACCES: permission denied", false])
  })

  test("the build from an installed tree's path, dev from a checkout", () => {
    expect(buildOf("/nonexistent/share/opencode-prime/opencode-2.3.0-prime.aaaa.bbbb.tree.plugins/node_modules/x/server.ts")).toBe("2.3.0-prime.aaaa.bbbb.tree")
    expect(buildOf("/nonexistent/dotfiles/opencode/cmd/digest/server.ts")).toBe("dev")
  })
})
