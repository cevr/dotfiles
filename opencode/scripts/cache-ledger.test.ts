import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { DEFAULT_DIR, FILE_NAME } from "../mods/cache/filestore/request-log.ts"
import { parseArgs } from "./cache-ledger.ts"

const NOW = Date.parse("2026-11-06T12:00:00Z")
const HOUR = 3_600_000

describe("cache-ledger's command line", () => {
  test("by default: the last 24 hours of this machine's ledger, every host, the top 10, as text", () => {
    expect(parseArgs([], NOW)).toEqual({ since: NOW - 24 * HOUR, top: 10, json: false, files: [join(DEFAULT_DIR, FILE_NAME)] })
  })

  test("a relative or ISO --since, a host, a top, JSON and several files", () => {
    expect(parseArgs(["--since", "7d", "--host", "bite-cristian", "--top", "3", "--json", "--file", "a.jsonl", "--file", "b.jsonl"], NOW)).toEqual({
      since: NOW - 7 * 24 * HOUR,
      host: "bite-cristian",
      top: 3,
      json: true,
      files: ["a.jsonl", "b.jsonl"],
    })
    expect(parseArgs(["--since", "2026-11-05T00:00:00Z"], NOW).since).toBe(Date.parse("2026-11-05T00:00:00Z"))
  })

  test("a malformed flag stops it with what to give", () => {
    expect(() => parseArgs(["--since", "yesterday"], NOW)).toThrow("--since yesterday: give 30m, 24h, 7d or an ISO time")
    expect(() => parseArgs(["--top", "-1"], NOW)).toThrow("--top takes a whole number")
    expect(() => parseArgs(["--host"], NOW)).toThrow("--host needs a value")
    expect(() => parseArgs(["--verbose"], NOW)).toThrow("unknown flag --verbose")
  })
})
