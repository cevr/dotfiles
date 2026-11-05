// Pull requests through a stand-in `gh` on a scratch PATH: a shell script
// (shell builtins only, as PATH holds nothing else) that answers `gh pr view --json <the fields>` as the law's world says, and
// fails any other call, so the laws also pin how `gh` is asked. The missing
// world's PATH holds no `gh` at all.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { type GhWorld, OPEN_REQUEST, pullRequestsLaws } from "../laws.ts"
import { PULL_REQUEST_FIELDS } from "../pull-request.ts"
import * as GhPullRequests from "./pull-requests.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "git-pull-requests-")))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** What the stand-in does once it is asked the expected question, as shell. */
const ANSWERS: Record<Exclude<GhWorld, "missing">, string> = {
  open: `printf '%s\\n' '${JSON.stringify(OPEN_REQUEST)}'`,
  none: `echo 'no pull requests found for branch "feature"' >&2; exit 1`,
  "signed-out": `echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4`,
  failing: `echo 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' >&2; exit 1`,
  garbage: `echo 'this is not json'`,
}

/** A `gh` that answers `world` to `gh pr view --json PULL_REQUEST_FIELDS`, and fails anything else. */
const standInGh = (world: Exclude<GhWorld, "missing">) => `#!/bin/sh
if [ "$*" != "pr view --json ${PULL_REQUEST_FIELDS}" ]; then echo "unexpected: gh $*" >&2; exit 9; fi
${ANSWERS[world]}
`

pullRequestsLaws("gh's PullRequests", (world) =>
  Effect.gen(function* () {
    const dir = yield* scratch
    const bin = join(dir, "bin")
    mkdirSync(bin)
    if (world !== "missing") {
      writeFileSync(join(bin, "gh"), standInGh(world))
      chmodSync(join(bin, "gh"), 0o755)
    }
    return { layer: GhPullRequests.layer({ ...process.env, PATH: bin }), root: dir }
  }),
)
