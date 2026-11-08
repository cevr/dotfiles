// The memory eval: our memory tools against Anthropic's native memory tool and
// no memory at all, on Haiku, over two-session episodes (notes/memory-eval.md
// has the design and the results).
//
// Usage, from opencode/:
//   bun scripts/memory-eval/eval.ts [--dry] [--repeats 8] [--cap 5] [--concurrency 4] [--model claude-haiku-5-5]
//                                   [--arms none,ours,ours+pointer,native,kernel,ours+nudge,kernel+nudge] [--scenarios webapp,dotfiles,billing,orders]
//                                   [--out out/memory-eval/<stamp>]
//
// --dry runs one episode per arm. The run stops starting requests once --cap
// dollars are spent. Each episode is a line of <out>/episodes.jsonl, and the
// summary is <out>/report.md.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CapReached, Ledger, MODEL, useModel } from "./api.ts"
import { type Arm, ARMS, type EpisodeResult, runEpisode } from "./episode.ts"
import { report } from "./report.ts"
import { type Scenario, SCENARIOS } from "./scenarios.ts"

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
useModel(flag("model") ?? MODEL)
const dry = process.argv.includes("--dry")
const repeats = Number(flag("repeats") ?? 8)
const cap = Number(flag("cap") ?? 5)
const concurrency = Math.min(4, Math.max(1, Number(flag("concurrency") ?? 4)))
const arms = (flag("arms")?.split(",") ?? [...ARMS]) as Array<Arm>
const scenarios = flag("scenarios")?.split(",").map((id) => SCENARIOS.find((s) => s.id === id) ?? fail(`no scenario ${id}`)) ?? [...SCENARIOS]
const out = flag("out") ?? join("out", "memory-eval", new Date().toISOString().replace(/[:.]/g, "-"))

function fail(message: string): never {
  throw new Error(message)
}
for (const arm of arms) if (!ARMS.includes(arm)) fail(`no arm ${arm}`)

interface Job {
  readonly scenario: Scenario
  readonly arm: Arm
  readonly repeat: number
}

/** Interleaved, so a run the cap stops early still covers every arm and scenario about evenly. */
const jobs: Array<Job> = dry
  ? arms.map((arm, index) => ({ scenario: scenarios[index % scenarios.length]!, arm, repeat: 0 }))
  : Array.from({ length: repeats }, (_, repeat) => scenarios.flatMap((scenario) => arms.map((arm) => ({ scenario, arm, repeat })))).flat()

mkdirSync(out, { recursive: true })
const jsonl = join(out, "episodes.jsonl")
writeFileSync(jsonl, "")
const ledger = new Ledger(cap)
const results: Array<EpisodeResult> = []
let next = 0
let stopped = false

console.log(`memory-eval: ${jobs.length} episodes on ${MODEL}, concurrency ${concurrency}, cap $${cap}, out ${out}`)

const worker = async () => {
  while (!stopped && next < jobs.length) {
    const job = jobs[next++]!
    const label = `${job.arm} ${job.scenario.id} #${job.repeat}`
    try {
      const result = await runEpisode(ledger, job.scenario, job.arm, job.repeat)
      results.push(result)
      appendFileSync(jsonl, JSON.stringify(result) + "\n")
      const saved = Object.values(result.graded.saved).filter(Boolean).length
      const correct = Object.values(result.graded.correct).filter(Boolean).length
      console.log(`✓ ${label}: saved ${saved}/${job.scenario.facts.length}, honoured ${correct}/${job.scenario.facts.length} · ${ledger.line()}`)
    } catch (error) {
      if (error instanceof CapReached) {
        stopped = true
        console.log(`■ ${label}: ${error.message}; stopping`)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const failed = { arm: job.arm, scenario: job.scenario.id, repeat: job.repeat, error: message } as unknown as EpisodeResult
      results.push(failed)
      appendFileSync(jsonl, JSON.stringify(failed) + "\n")
      console.log(`✗ ${label}: ${message}`)
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker))
const summary = [`# Memory eval run`, "", `Model ${MODEL}; ${ledger.line()}`, "", report(results)].join("\n")
writeFileSync(join(out, "report.md"), summary + "\n")
console.log("\n" + summary)
