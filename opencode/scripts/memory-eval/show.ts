// Prints episodes of a run for reading: the arm, the grade, the stored notes
// and both sessions' transcripts.
// Usage: bun scripts/memory-eval/show.ts <episodes.jsonl> [arm] [scenario] [--s2] [--max N]
import type { EpisodeResult } from "./episode.ts"

const [path, arm, scenario] = process.argv.slice(2).filter((arg) => !arg.startsWith("--") && !/^\d+$/.test(arg))
if (path === undefined) throw new Error("usage: bun scripts/memory-eval/show.ts <episodes.jsonl> [arm] [scenario] [--s2] [--max N]")
const onlyS2 = process.argv.includes("--s2")
const maxIndex = process.argv.indexOf("--max")
const max = maxIndex === -1 ? Infinity : Number(process.argv[maxIndex + 1])
const episodes = (await Bun.file(path).text())
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as EpisodeResult)
  .filter((episode) => (arm === undefined || arm === "all" || episode.arm === arm) && (scenario === undefined || episode.scenario === scenario))
  .slice(0, max)

for (const episode of episodes) {
  if (episode.error !== undefined) {
    console.log(`=== ${episode.arm} ${episode.scenario} #${episode.repeat}: failed: ${episode.error}`)
    continue
  }
  console.log(`=== ${episode.arm} ${episode.scenario} #${episode.repeat}`)
  console.log(`saved ${JSON.stringify(episode.graded.saved)} correct ${JSON.stringify(episode.graded.correct)} readBeforeAct ${episode.graded.readBeforeAct}`)
  console.log("stored after s1:", JSON.stringify(episode.stored1.documents, null, 1))
  if (!onlyS2 && episode.s1 !== undefined) console.log("--- session 1\n" + episode.s1.transcript.join("\n"))
  console.log("--- session 2 extra system:\n" + episode.s2.extra.join("\n---\n"))
  console.log("--- session 2\n" + episode.s2.transcript.join("\n"))
}
