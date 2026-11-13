// The verify-opencode feature map (`.claude/skills/verify-opencode/features/`) as data: each feature file's
// id, the world suites its drive runs (`**World suites:**`), the real checks for what the world cannot show
// (`**Real:**`), and the code it covers (`**Code:**`, prefixes under opencode/). `bun run verify:drive` reads
// the map through this, so the map is the one list of what a drive runs; the docs guard
// (scripts/verify-docs.test.ts) holds every path it names to the tree.
import { Array as Arr, Option } from "effect"

/** Where the skill lives, from opencode/. */
export const SKILL_DIR = ".claude/skills/verify-opencode"
/** Where its feature files live, from opencode/. */
export const FEATURES_DIR = `${SKILL_DIR}/features`

/** One feature file of the map, as a drive reads it. */
export interface Feature {
  readonly id: string
  readonly title: string
  /** `*.sim.test.ts(x)` files, from opencode/: the drive on the world. */
  readonly world: ReadonlyArray<string>
  /** Acceptance tests and scenarios on real OpenCode, from opencode/: what the world cannot show. */
  readonly real: ReadonlyArray<string>
  /** Path prefixes, from opencode/, whose change makes this feature's drive due. */
  readonly code: ReadonlyArray<string>
}

/** The backticked words of the line that opens `- **<label>:**`, in order; none when the file lacks the line. */
export const listed = (text: string, label: string): ReadonlyArray<string> =>
  Option.match(
    Arr.findFirst(text.split("\n"), (line) => line.trim().startsWith(`- **${label}:**`)),
    { onNone: () => [], onSome: (line) => Arr.map(Array.from(line.matchAll(/`([^`]+)`/g)), (match) => match[1] ?? "") },
  )

/** A feature file's map entry: its id is the file's name without `.md`, its title the H1. */
export const parseFeature = (file: string, text: string): Feature => ({
  id: file.replace(/\.md$/, ""),
  title: Option.getOrElse(
    Option.map(Arr.findFirst(text.split("\n"), (line) => line.startsWith("# ")), (line) => line.slice(2).trim()),
    () => file,
  ),
  world: listed(text, "World suites"),
  real: listed(text, "Real"),
  code: listed(text, "Code"),
})

/** The features a change touches: each whose code holds a changed path (from opencode/). */
export const touched = (features: ReadonlyArray<Feature>, changed: ReadonlyArray<string>): ReadonlyArray<Feature> =>
  features.filter((feature) => feature.code.some((prefix) => changed.some((path) => path.startsWith(prefix))))

/** The prefix every feature claims (the world itself): a suite under it is a world law's, no one feature's drive. */
export const SHARED = "sim/"

/**
 * The world suites under a feature's own code that its drive skips: each of `suites` (from opencode/) under one of
 * its `Code` prefixes, `sim/` aside, that its `World suites` leave out. A change under that code is due this
 * feature's drive, so a suite it skips there could go red under a green receipt.
 */
export const undriven = (feature: Feature, suites: ReadonlyArray<string>): ReadonlyArray<string> =>
  suites.filter(
    (suite) => /\.sim\.test\.tsx?$/.test(suite) && feature.code.some((prefix) => prefix !== SHARED && suite.startsWith(prefix)) && !feature.world.includes(suite),
  )

/** A changed path from the repository's root, as one from opencode/; none outside opencode/. */
export const underOpencode = (path: string): Option.Option<string> =>
  Option.map(
    Option.filter(Option.some(path), (each) => each.startsWith("opencode/")),
    (each) => each.slice("opencode/".length),
  )

/** The seeds a drive plays first: a number from the head's hash, so a head always plays the same fresh seeds and another head others. */
export const swarmFrom = (head: string): number => Number.parseInt(head.slice(0, 7) || "0", 16) % 1_000_000_000
