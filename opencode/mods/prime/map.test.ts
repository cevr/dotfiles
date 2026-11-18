import { expect, test } from "bun:test"
import { Option } from "effect"
import { mapNotice, mapNoticeGlyph, mapWork, mapWorkTail } from "./map.ts"

test("a run's work reads as the transcript's folded row words it, after its sentence", () => {
  expect(mapWork({ thoughts: 1, tools: 1 })).toBe("+ 1 thought, 1 tool")
  expect(mapWork({ thoughts: 2, tools: 0 })).toBe("+ 2 thoughts")
  expect(mapWork({ thoughts: 0, tools: 3 })).toBe("+ 3 tools")
  expect(mapWork({ thoughts: 0, tools: 0 })).toBe("")
  expect(mapWorkTail({ text: "Shipped it.", thoughts: 1, tools: 4 })).toBe(" · + 1 thought, 4 tools")
  expect(mapWorkTail({ text: "", thoughts: 0, tools: 2 })).toBe("+ 2 tools")
  expect(mapWorkTail({ text: "Shipped it.", thoughts: 0, tools: 0 })).toBe("")
})

test("a stop notice reads as notice.ts heads it; any other notice is none", () => {
  const notice = (text: string, source = "subagent") => mapNotice({ kind: "notice", source, text })
  expect(notice("Implementor finished · implementor leader-hint r1 (fork)")).toEqual(
    Option.some({
      glyph: { char: "●", tone: "muted" },
      tone: "muted",
      actor: "Implementor",
      word: "finished",
      tail: " · implementor leader-hint r1 (fork)",
    }),
  )
  expect(Option.getOrThrow(notice("Shell failed · bun test", "shell"))).toMatchObject({ glyph: { char: "✗", tone: "error" }, word: "failed", tone: "error" })
  expect(Option.getOrThrow(notice("Worker cancelled"))).toMatchObject({ glyph: { char: "●", tone: "warning" }, tail: "" })
  expect(notice("Queue check: 1 stale of 16 open", "")).toEqual(Option.none())
  expect(mapNotice({ kind: "user", source: "subagent", text: "Implementor finished" })).toEqual(Option.none())
  expect([mapNoticeGlyph("goal"), mapNoticeGlyph("mail"), mapNoticeGlyph("wake")]).toEqual(["◎", "✉", "◈"])
})
