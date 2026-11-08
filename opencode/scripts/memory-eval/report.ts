// The run's summary from its episodes: per arm, the means with their counts,
// then correctness per scenario and per kind of fact, then a few failures.
import { costOf, type Usage } from "./api.ts"
import { ARMS, type EpisodeResult } from "./episode.ts"
import { grade } from "./grade.ts"
import { SCENARIOS } from "./scenarios.ts"

const pct = (hits: number, total: number) => (total === 0 ? "–" : `${Math.round((100 * hits) / total)}% (${hits}/${total})`)
const mean = (values: ReadonlyArray<number>, digits = 1) => (values.length === 0 ? "–" : (values.reduce((a, b) => a + b, 0) / values.length).toFixed(digits))
const tokens = (usage: Usage | undefined) => (usage === undefined ? 0 : usage.input + usage.cacheWrite + usage.cacheRead)

const kindOf = (scenario: string, fact: string) => SCENARIOS.find((s) => s.id === scenario)?.facts.find((f) => f.id === fact)?.kind ?? "?"

/** An episode graded again from what it recorded, so a fixed grader applies to an earlier run. */
const regrade = (episode: EpisodeResult): EpisodeResult => {
  const scenario = SCENARIOS.find((s) => s.id === episode.scenario)
  if (scenario === undefined) return episode
  return { ...episode, graded: grade(scenario, episode.s1?.calls ?? [], episode.s2.calls, episode.s2.extra, episode.stored1, episode.stored2) }
}

export const report = (episodes: ReadonlyArray<EpisodeResult>): string => {
  const ok = episodes.filter((episode) => episode.error === undefined).map(regrade)
  const arms = ARMS.filter((arm) => ok.some((episode) => episode.arm === arm))
  const lines: Array<string> = []
  const failed = episodes.length - ok.length
  lines.push(`Episodes: ${ok.length} graded${failed > 0 ? `, ${failed} failed to run` : ""}.`, "")

  lines.push(
    "| arm | n | facts saved (s1) | s2 read before acting | s2 digest | s2 facts honoured | s2 all honoured | honoured when saved | notes off-list (s1/s2) | task-state notes (s1/s2) | requests s1/s2 | turns cut at the step cap s1/s2 | input tok s1/s2 | output tok s1/s2 | cache read share | $/episode |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  )
  for (const arm of arms) {
    const group = ok.filter((episode) => episode.arm === arm)
    const facts = group.flatMap((episode) => Object.entries(episode.graded.saved))
    const correct = group.flatMap((episode) => Object.entries(episode.graded.correct))
    const savedAndCorrect = group.flatMap((episode) =>
      Object.entries(episode.graded.correct).filter(([fact]) => episode.graded.saved[fact] === true),
    )
    const all = group.filter((episode) => Object.values(episode.graded.correct).every(Boolean)).length
    const usage = group.map((episode) => [episode.s1?.usage, episode.s2.usage] as const)
    const reads = usage.flatMap(([a, b]) => [a?.cacheRead ?? 0, b.cacheRead])
    const totals = usage.flatMap(([a, b]) => [tokens(a), tokens(b)])
    const cost = group.map((episode) => (episode.s1 === undefined ? 0 : costOf(episode.s1.usage, episode.model)) + costOf(episode.s2.usage, episode.model))
    lines.push(
      [
        arm,
        group.length,
        arm === "none" ? "–" : pct(facts.filter(([, v]) => v).length, facts.length),
        arm === "none" ? "–" : pct(group.filter((e) => e.graded.readBeforeAct).length, group.length),
        arm.startsWith("ours") ? pct(group.filter((e) => e.graded.digest).length, group.length) : "–",
        pct(correct.filter(([, v]) => v).length, correct.length),
        pct(all, group.length),
        arm === "none" ? "–" : pct(savedAndCorrect.filter(([, v]) => v).length, savedAndCorrect.length),
        arm === "none" ? "–" : `${mean(group.map((e) => e.graded.offList1))} / ${mean(group.map((e) => e.graded.offList2))}`,
        arm === "none" ? "–" : `${mean(group.map((e) => e.graded.taskState1))} / ${mean(group.map((e) => e.graded.taskState2))}`,
        `${mean(group.flatMap((e) => (e.s1 ? [e.s1.requests] : [])))} / ${mean(group.map((e) => e.s2.requests))}`,
        `${group.reduce((n, e) => n + (e.s1?.cappedTurns ?? 0), 0)} / ${group.reduce((n, e) => n + e.s2.cappedTurns, 0)}`,
        `${mean(group.flatMap((e) => (e.s1 ? [tokens(e.s1.usage)] : [])), 0)} / ${mean(group.map((e) => tokens(e.s2.usage)), 0)}`,
        `${mean(group.flatMap((e) => (e.s1 ? [e.s1.usage.output] : [])), 0)} / ${mean(group.map((e) => e.s2.usage.output), 0)}`,
        pct(reads.reduce((a, b) => a + b, 0), totals.reduce((a, b) => a + b, 0)).replace(/ \(.*/, ""),
        `$${mean(cost, 4)}`,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    )
  }

  lines.push("", "Session-2 facts honoured, per scenario:", "", `| arm | ${SCENARIOS.map((s) => s.id).join(" | ")} |`, `| --- | ${SCENARIOS.map(() => "---").join(" | ")} |`)
  for (const arm of arms) {
    const cells = SCENARIOS.map((scenario) => {
      const correct = ok.filter((e) => e.arm === arm && e.scenario === scenario.id).flatMap((e) => Object.values(e.graded.correct))
      return pct(correct.filter(Boolean).length, correct.length)
    })
    lines.push(`| ${arm} | ${cells.join(" | ")} |`)
  }

  const kinds = ["correction", "gotcha", "preference"] as const
  lines.push("", "Per kind of fact, saved in session 1 → honoured in session 2:", "", `| arm | ${kinds.join(" | ")} |`, `| --- | ${kinds.map(() => "---").join(" | ")} |`)
  for (const arm of arms) {
    const cells = kinds.map((kind) => {
      const group = ok.filter((e) => e.arm === arm)
      const saved = group.flatMap((e) => Object.entries(e.graded.saved).filter(([fact]) => kindOf(e.scenario, fact) === kind).map(([, v]) => v))
      const correct = group.flatMap((e) => Object.entries(e.graded.correct).filter(([fact]) => kindOf(e.scenario, fact) === kind).map(([, v]) => v))
      return `${arm === "none" ? "–" : pct(saved.filter(Boolean).length, saved.length)} → ${pct(correct.filter(Boolean).length, correct.length)}`
    })
    lines.push(`| ${arm} | ${cells.join(" | ")} |`)
  }

  lines.push("", "Per fact, saved in session 1 → honoured in session 2:", "", `| fact | ${arms.join(" | ")} |`, `| --- | ${arms.map(() => "---").join(" | ")} |`)
  for (const scenario of SCENARIOS)
    for (const fact of scenario.facts) {
      const cells = arms.map((arm) => {
        const group = ok.filter((e) => e.arm === arm && e.scenario === scenario.id)
        const saved = group.filter((e) => e.graded.saved[fact.id] === true).length
        const values = group.map((e) => e.graded.correct[fact.id] === true)
        return `${arm === "none" ? "" : `${saved}/${group.length} → `}${pct(values.filter(Boolean).length, values.length)}`
      })
      lines.push(`| ${scenario.id}/${fact.id} (${fact.kind}) | ${cells.join(" | ")} |`)
    }

  for (const episode of episodes.filter((e) => e.error !== undefined).slice(0, 5)) lines.push("", `Failed to run: ${episode.arm} ${episode.scenario} #${episode.repeat}: ${episode.error}`)
  return lines.join("\n")
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined) throw new Error("usage: bun scripts/memory-eval/report.ts <episodes.jsonl>")
  const text = await Bun.file(path).text()
  const episodes = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as EpisodeResult)
  console.log(report(episodes))
}
