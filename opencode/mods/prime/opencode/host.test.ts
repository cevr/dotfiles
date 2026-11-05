// The host's side of the Prime look: whether the sidebar shows, on a host
// that can say and on one that cannot.
import { describe, expect, test } from "bun:test"
import { sidebarShown } from "./host.ts"

describe("the sidebar", () => {
  test("the rows step aside while the host shows the sidebar, and always show on a host that cannot say", () => {
    const shown = new Set(["wide"])
    const host = { sidebar: { visible: (sessionID: string) => shown.has(sessionID) } }
    expect(sidebarShown(host, "wide")).toBe(true)
    expect(sidebarShown(host, "narrow")).toBe(false)
    expect(sidebarShown({}, "wide")).toBe(false)
  })
})
