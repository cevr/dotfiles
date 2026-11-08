// How long `tools.docs.search` takes over 60 tools: the index built once, then
// a search over its postings. `bun mods/kernel/bm25.bench.ts`
import { searcher } from "./summary.ts"

const verbs = ["read", "write", "list", "search", "run", "create", "remove", "fetch", "move", "rename", "snapshot", "click"]
const nouns = ["file", "page", "shell", "session", "worktree", "model", "resource", "issue", "branch", "image", "note", "queue"]
const filler =
  "It returns the result as text, with the output truncated past a limit. Quote paths containing spaces. Prefer dedicated tools when possible, and pass an absolute path. The call fails with a message that names the reason when the input is invalid."

const tools = Array.from({ length: 60 }, (_, at) => {
  const verb = verbs[at % verbs.length]!
  const noun = nouns[Math.floor(at / verbs.length) % nouns.length]!
  return { id: `${verb}_${noun}_${at}`, description: `${verb[0]!.toUpperCase()}${verb.slice(1)} a ${noun} by its id or path. ${filler.repeat(1 + (at % 3))}` }
})
const queries = ["shell", "read file", "running shells", "snapshot the page", "create a worktree branch", "zebra", "rename session model"]

const time = (runs: number, body: () => void) => {
  for (let at = 0; at < Math.min(runs, 1_000); at++) body()
  const from = Bun.nanoseconds()
  for (let at = 0; at < runs; at++) body()
  return (Bun.nanoseconds() - from) / runs / 1_000
}

let find = searcher(tools)
const build = time(2_000, () => void (find = searcher(tools)))
let sink = 0
const search = time(200_000, () => {
  for (const query of queries) sink += find(query).length
}) / queries.length
console.log(`60 tools, ${queries.length} queries: build ${build.toFixed(1)} µs once; search ${search.toFixed(2)} µs each (${sink > 0 ? "hits" : "none"})`)
