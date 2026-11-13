// Times COUNT plain fs.watch calls on directories under DIR, the way the OpenCode TUI
// watches each plugin source (packages/tui/src/util/watch.ts). A busy fseventsd makes each
// one cost 0.1 to 2 s; on the Developer volume the whole set should take under LIMIT ms.
// Read-only: it only watches existing directories, then closes the watches.
//
//   bun watch-bench.ts DIR [COUNT=38] [LIMIT_MS=100]
import { watch, readdirSync, type FSWatcher } from "node:fs"
import { join } from "node:path"

const [dir, countArg = "38", limitArg = "100"] = process.argv.slice(2)
if (dir === undefined) {
  console.error("usage: bun watch-bench.ts DIR [COUNT] [LIMIT_MS]")
  process.exit(2)
}
const count = Number(countArg)
const limit = Number(limitArg)

// Breadth first, skipping hidden directories and node_modules, as plugin sources are.
const dirs: Array<string> = []
const queue = [dir]
while (queue.length > 0 && dirs.length < count) {
  const next = queue.shift()!
  let entries
  try {
    entries = readdirSync(next, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue
    const path = join(next, entry.name)
    if (dirs.length < count) dirs.push(path)
    queue.push(path)
  }
}
if (dirs.length < count) {
  console.error(`watch bench: found ${dirs.length} directories under ${dir}, needs ${count}`)
  process.exit(2)
}

const watchers: Array<FSWatcher> = []
const start = performance.now()
for (const path of dirs) watchers.push(watch(path, () => {}))
const took = performance.now() - start
for (const watcher of watchers) watcher.close()

console.log(`${count} watches in ${took.toFixed(1)} ms (limit ${limit} ms)`)
process.exit(took < limit ? 0 : 1)
