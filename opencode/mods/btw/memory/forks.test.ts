import { forkReadingsLaws, forksLaws } from "../laws.ts"
import { forksLayer, probe, readingsLayer, world } from "./forks.ts"

const bench = (turns: number) => {
  const host = world({ main: turns })
  return { forks: forksLayer(host), readings: readingsLayer(host), host: probe(host) }
}

forksLaws("Forks in memory", bench)
forkReadingsLaws("ForkReadings in memory", bench)
