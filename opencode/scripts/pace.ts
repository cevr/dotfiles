#!/usr/bin/env bun
// One held call's background waiter. This is a wake-up, not an admission
// ticket: retrying the original tool always rechecks current pool quota.
// No shared Claude queue is touched, since it cannot see OpenCode's agents.
if (import.meta.main) {
  const index = process.argv.indexOf("--wait")
  const at = Number(process.argv[index + 1])
  if (index < 0 || !Number.isFinite(at) || at <= 0) {
    console.error("usage: bun scripts/pace.ts --wait <epoch milliseconds>")
    process.exit(2)
  }
  while (Date.now() < at) await Bun.sleep(Math.min(60_000, at - Date.now()))
  console.log("Pace wait ended. Retry the held call with the same agent and description; the pool will recheck admission.")
}
