// The golden frames: each converted frame's text from one real run of its
// scenario at the base (`golden/<scenario>/<frame>.txt`, as the scenario wrote
// it), and the comparison a simulated frame is held to. These fields may
// differ, and are masked on both sides before the lines are compared (MASKS):
// - a duration the real run measured in wall time (`· 12s`, `0.4s`);
// - an id the real server drew (`ses_…`, `msg_…`, `call_…` keep their prefix);
// - the working directory, the fixture's temporary one against the drive's;
// - a glyph animated in wall time (a spinner, a pulsing dot or diamond).
import { readFileSync } from "node:fs"
import path from "node:path"

const DIR = path.join(import.meta.dir, "golden")

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
  [/[◆◇] worker\b/g, "<pulse> worker"],
]

const mask = (line: string) => MASKS.reduce((text, [pattern, by]) => text.replace(pattern, by), line.trimEnd())

/** The golden frame `name` of `scenario`, as its lines. */
export const frame = (scenario: string, name: string): ReadonlyArray<string> =>
  readFileSync(path.join(DIR, scenario, `${name}.txt`), "utf8").split("\n")

/** The lines where `actual` and `expected` differ once masked, as `row: actual ≠ expected`; empty when they agree. */
export const same = (actual: ReadonlyArray<string> | undefined, expected: ReadonlyArray<string>): ReadonlyArray<string> => {
  const rows = Math.max(actual?.length ?? 0, expected.length)
  return Array.from({ length: rows }, (_, row) => [mask(actual?.[row] ?? ""), mask(expected[row] ?? "")] as const).flatMap(([got, want], row) =>
    got === want ? [] : [`${row}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`],
  )
}
