// The golden frames: each converted frame's text from one real run of its
// scenario at the base (`golden/<scenario>/<frame>.txt`, as the scenario wrote
// it), and the comparison a simulated frame is held to. These fields may
// differ, and are masked on both sides before the lines are compared (MASKS):
// - a duration the real run measured in wall time (`· 12s`, `0.4s`);
// - an id the real server drew (`ses_…`, `msg_…`, `call_…` keep their prefix);
// - the working directory, the fixture's temporary one against the drive's;
// - a glyph animated in wall time (a spinner, a pulsing dot or diamond).
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Path, Schema } from "effect"

/** The fields a real run and a simulated one may disagree on, and what each is masked as. */
export const MASKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b\d+(\.\d+)?(ms|s|m)\b/g, "<duration>"],
  [/\b(ses|msg|call|sh|evt)_[0-9A-Za-z]+/g, "$1_<id>"],
  // The working directory (the splash's `cwd`, the sidebar's `dir:branch`): the fixture's here,
  // under the drive's home there; the padding after it takes up the difference in length.
  [/(\bcwd )\S+ */g, "$1<directory> "],
  [/ +\S+(:main)$/g, " <directory>$1"],
  // A glyph that moves in wall time: a spinner, the DevTools bar's UI activity dot, a running worker's diamond.
  [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /g, "<spinner> "],
  [/[○●⦿] UI\b/g, "<pulse> UI"],
  [/[◆◇] (worker|general)\b/g, "<pulse> $1"],
  // A running call's dot, which pulses ● / ○.
  [/^( +)[●○] Running /g, "$1<pulse> Running "],
]

const mask = (line: string) => MASKS.reduce((text, [pattern, by]) => text.replace(pattern, by), line.trimEnd())
const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String))

/** The golden frame `name` of `scenario`, as its lines. */
export const frame = (scenario: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* path.fromFileUrl(new URL("./golden", import.meta.url))
    const text = yield* fs.readFileString(path.join(dir, scenario, `${name}.txt`))
    return text.split("\n")
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie)

/** The lines where `actual` and `expected` differ once masked, as `row: actual ≠ expected`; empty when they agree. */
export const same = (actual: ReadonlyArray<string> = [], expected: ReadonlyArray<string>): ReadonlyArray<string> => {
  const rows = Math.max(actual.length, expected.length)
  return Array.from({ length: rows }, (_, row) => [mask(actual[row] ?? ""), mask(expected[row] ?? "")] as const).flatMap(([got, want], row) => {
    if (got === want) return []
    return [`${row}: ${quoted(got)} ≠ ${quoted(want)}`]
  })
}

/** `actual` held to the golden frame `name` of `scenario`: the lines that differ, as `same` gives them. */
export const check = (scenario: string, name: string, actual: ReadonlyArray<string> = []) => Effect.map(frame(scenario, name), (expected) => same(actual, expected))
