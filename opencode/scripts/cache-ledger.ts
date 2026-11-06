// Sum the cache mod's ledger: cache-write tokens by cause, by the first
// changed segment, per host and day (the unexplained part is the weekly
// check), and per session-hour.
//
//   bun scripts/cache-ledger.ts [--since 24h] [--host <name>] [--top 10] [--json] [--file <ledger.jsonl>]...
//
// `--since` takes `30m`, `24h`, `7d` or an ISO time; default 24h. `--file`
// may repeat (a copy of another host's ledger beside this one's); default
// ~/.cache/opencode-cache-ledger/ledger.jsonl.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_DIR, FILE_NAME, parse } from "../mods/cache/filestore/request-log.ts"
import { render, summarize } from "../mods/cache/summary.ts"
import { parseTtl } from "../mods/cache/ttl.ts"

export interface Args {
  readonly since: number
  readonly host?: string
  readonly top: number
  readonly json: boolean
  readonly files: ReadonlyArray<string>
}

/** The command line, read; `now` anchors a relative `--since`. Throws on a malformed flag. */
export const parseArgs = (argv: ReadonlyArray<string>, now: number): Args => {
  let since = now - 24 * 3_600_000
  let host: string | undefined
  let top = 10
  let json = false
  const files: Array<string> = []
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === "--since") {
      const raw = value()
      const relative = parseTtl(raw)
      const absolute = Date.parse(raw)
      if (relative !== undefined) since = now - relative
      else if (!Number.isNaN(absolute)) since = absolute
      else throw new Error(`--since ${raw}: give 30m, 24h, 7d or an ISO time`)
    } else if (flag === "--host") host = value()
    else if (flag === "--top") {
      top = Number(value())
      if (!Number.isInteger(top) || top < 0) throw new Error("--top takes a whole number")
    } else if (flag === "--json") json = true
    else if (flag === "--file") files.push(value())
    else throw new Error(`unknown flag ${flag}`)
  }
  return { since, ...(host === undefined ? {} : { host }), top, json, files: files.length > 0 ? files : [join(DEFAULT_DIR, FILE_NAME)] }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2), Date.now())
    const lines = args.files.flatMap((file) => (existsSync(file) ? parse(readFileSync(file, "utf8")) : []))
    const summary = summarize(lines, args.since, args.host)
    console.log(args.json ? JSON.stringify(summary, null, 2) : render(summary, args.top))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
