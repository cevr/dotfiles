// The keychain rule on its own: which command lines start a Chrome for DevTools
// or headless without the two keychain flags, whatever the spelling; which
// scripts a line runs; which script texts start such a Chrome; and the words.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { bareLaunches, Inline, KEYCHAIN_FLAGS, keychainReason, type Remedy, runtimeRuns, ScriptFile, scriptLaunch, scriptLaunchesBare } from "./chrome.ts"
import { MAX_PATH_STATES } from "./executable.ts"

const HOME = "/home/owner"
const CWD = "/home/owner/work"
const place = { cwd: CWD, home: HOME }
const refused = (line: string) => bareLaunches(line, place).length > 0
const SAFE = KEYCHAIN_FLAGS.join(" ")
const CFT = "'/Users/owner/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'"
const SHELL = "~/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell"
const SHIM_PATH = "$HOME/Developer/personal/dotfiles/claude/bin/chrome-mock-keychain"

/** Lines that start a Chrome for DevTools or headless without both flags: each refused. */
const BARE = [
  `${CFT} --headless=new --remote-debugging-port=0 about:blank`,
  `${SHELL} --headless --remote-debugging-port=0 http://x/`,
  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --dump-dom http://x/',
  "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222",
  "chromium --headless --screenshot=x.png http://x/",
  "chromium-browser --remote-debugging-pipe",
  "google-chrome-stable --headless http://x/",
  "/opt/chrome-linux64/chrome --headless=new http://x/",
  '"$CHROME" --headless=new --remote-debugging-port=0',
  "${CHROMIUM_BIN} --headless",
  `${CFT} --headless --use-mock-keychain`,
  `${CFT} --headless --password-store=basic`,
  `env HOME=/tmp/h ${CFT} --headless`,
  `FOO=1 nice -n 10 ${SHELL} --headless`,
  `timeout 30 ${SHELL} --headless`,
  `cd /tmp && ${SHELL} --remote-debugging-port=9222 &`,
  `sh -c '${SHELL} --headless'`,
  `bash -lc "cd /tmp; chromium --headless"`,
  'open -a "Google Chrome" --args --remote-debugging-port=9222',
  'open -na "Google Chrome for Testing" --args --headless',
  "msedge --headless",
  "'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' --headless",
  // A bisect runs old commits, whose launchers may predate the flags: refused without the shim.
  "git bisect run bun tools/drive-web.ts web measure",
  "cd /x && git -C lane bisect run ./measure.sh",
  // CHROME set to something else is no shim.
  'CHROME=/opt/chromium "$CHROME" --headless',
] as const

/** Lines that start no such Chrome, or pass both flags: each left alone. */
const LEFT = [
  // The owner's own starts: no DevTools port, not headless.
  'open -a "Google Chrome"',
  "open -a 'Google Chrome' https://example.com",
  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --profile-directory=Default',
  "chromium https://example.com",
  // Both flags, in any order and spelling of the launch.
  `${CFT} --headless=new --remote-debugging-port=0 ${SAFE} about:blank`,
  `${SHELL} --password-store=basic --headless --use-mock-keychain`,
  `"$CHROME" ${SAFE} --remote-debugging-pipe`,
  `open -a "Google Chrome for Testing" --args --headless ${SAFE}`,
  // Lines that only read or name a Chrome.
  "pgrep -fl 'chrome --headless'",
  "ps -Ao pid,command | grep chrome-headless-shell",
  "echo chromium --headless",
  "pkill -f chrome-headless-shell",
  "git commit -m 'chromium --headless'",
  "ls ~/Library/Caches/ms-playwright/chromium-1255",
  // The launchers that pass both flags themselves.
  "agent-browser --session r5 open http://x/",
  "bunx playwright test",
  "rg -- --headless src",
  // CHROME set to the shim on the line: the launch goes through it, which adds both flags.
  `CHROME=${SHIM_PATH} "$CHROME" --headless=new --remote-debugging-port=0`,
  // A bisect with the shim: an old commit's launcher that reads CHROME gets both flags.
  `CHROME="${SHIM_PATH}" git bisect run bun tools/drive-web.ts web measure`,
  `export CHROME=${SHIM_PATH}; cd /x && git bisect run ./measure.sh`,
  "git bisect start HEAD v1",
  "git bisect good",
] as const

describe("a bare Chrome launch is found", () => {
  test("in every spelling of a binary, a variable, an app and a prefix", () => {
    for (const line of BARE) expect([line, refused(line)]).toEqual([line, true])
  })

  test("and nothing else is: the owner's own Chrome, a launch with both flags, a line that only names one", () => {
    for (const line of LEFT) expect([line, refused(line)]).toEqual([line, false])
  })

  test("each bare launch of a chained line, by its own command", () => {
    expect(bareLaunches(`chromium --headless; ${SHELL} --headless ${SAFE}; chromium --remote-debugging-pipe`, place).map((launch) => launch.command)).toEqual([
      "chromium --headless",
      "chromium --remote-debugging-pipe",
    ])
  })
})

describe("keychain trigger words used as data", () => {
  const chromeSwitchSpellings = {
    headless: "--headless",
    modernHeadless: "--headless=new",
    debugPort: "--remote-debugging-port=0",
    debugPipe: "--remote-debugging-pipe",
  }
  const triggers = [
    "git", "bisect", "run", "start", "stash", "branch", "checkout", "switch", "--detach", "worktree", "add", "rev-list",
    "for", "do", "git bisect run", "git checkout --detach", "git switch --detach", "'switch', '--detach'", "'bisect', 'run'",
    "google-chrome", "google-chrome-stable", "google-chrome-beta", "google-chrome-dev", "google-chrome-unstable",
    "Google Chrome for Testing", "Google Chrome Canary", "chrome", "chromium", "chromium-browser", "open", "--args",
    "chrome-headless-shell", "headless_shell", "Brave Browser", "Microsoft Edge", "msedge", "$CHROME", "${CHROMIUM_BIN}",
    "CHROME=chrome-mock-keychain", ...Object.values(chromeSwitchSpellings),
    ...KEYCHAIN_FLAGS, "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "execa", "execaSync", "launch", "ignoreDefaultArgs",
  ]
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

  for (const word of triggers) {
    const path = (part: string) => quote(`/nonexistent/loop-probe/${part}`)
    const lines = [
      `sh -n ${path(`${word}/receipt.sh`)} ${path("profile.sh")}`,
      `bash -vn ${path(`${word}.sh`)}`,
      `sh -n -- ${path("receipt.sh")} ${quote(word)} --headless`,
      `cat -- ${path(word)} --headless`,
      `grep -F -- ${quote(word)} ${path("receipt.sh")}`,
      `ls -- ${path(word)} --headless`,
      `git log -1 -- bisect run ${quote(word)}`,
      `shellcheck ${path(`${word}.sh`)}`,
      `vim ${path(`${word}.sh`)}`,
      `command -v ${quote(word)} --headless`,
    ]
    test(`${quote(word)} in paths, strings and read-only arguments`, () => {
      for (const line of lines) expect([line, refused(line), runtimeRuns(line, place)]).toEqual([line, false, []])
    })
  }
})

describe("old checkouts in an executable position", () => {
  test("joins carry bindings, working directories and selections on the same reaching path", () => {
    const directory = { ...place, cwd: "/guard/probe/tree" }
    const decision = (line: string) => bareLaunches(line, directory).map(({ remedy }) => remedy)
    const run = 'git checkout "$REF"; npm --prefix /guard/probe/tree test'
    const telemetry = "REF=$(git describe)"
    for (const stop of ["exit 0", "return", "exec printf done", "false"]) {
      expect(decision(`${telemetry}; if test -n "$CI"; then REF=main; else ${stop}; fi; ${run}`)).toEqual([])
      expect(decision(`${telemetry}; if test -n "$CI"; then ${stop}; else :; fi; ${run}`)).toEqual(["unknown"])
    }
    expect(decision(`REF=HEAD~1; if test -n "$CI"; then cd ../tools; fi; ${run}`)).toEqual(["shim"])
    expect(decision(`REF=HEAD~1; if test -n "$CI"; then cd ../tools; else cd ../other; fi; ${run}`)).toEqual([])
    expect(decision(`if test -n "$CI"; then REF=HEAD~1; cd ../tools; else REF=main; fi; ${run}`)).toEqual([])
    expect(decision('if test -n "$CI"; then git checkout HEAD~1; exit; fi; npm test')).toEqual([])
    expect(decision('if test -n "$CI"; then git checkout HEAD~1; npm test; exit; fi; :')).toEqual(["shim"])
    expect(decision(`${telemetry}; case "$CI" in yes) REF=main ;; *) exit ;; esac; ${run}`)).toEqual([])
    expect(decision(`${telemetry}; case "$CI" in yes) REF=main ;; esac; ${run}`)).toEqual(["unknown"])
    expect(decision(`REF=HEAD~1; test -n "$CI" && cd ../tools; ${run}`)).toEqual(["shim"])
    expect(decision(`REF=HEAD~1; test -n "$CI" || cd ../tools; ${run}`)).toEqual(["shim"])
    expect(decision(`REF=HEAD~1; while test -n "$CI"; do cd ../tools; break; done; ${run}`)).toEqual(["shim"])
    expect(decision(`if test -n "$CI"; then cd ../tools; fi; sh -c 'git checkout HEAD~1'; npm --prefix /guard/probe/tree test`)).toEqual(["shim"])
    expect(decision(`sh -c 'if test -n "$CI"; then git checkout HEAD~1; fi'; npm test`)).toEqual(["shim"])
    expect(decision(`if test -n "$CI"; then ${telemetry}; else REF=HEAD~1; fi; ${run}`)[0]).toBe("shim")
  })

  test("stdout, not stderr, is the value of a command substitution", () => {
    const line = (redirect: string) => `REF=$(git log -1 ${redirect}; git branch --show-current); git checkout "$REF"; npm test`
    for (const redirect of [">&2", "1>&2", ">& 2", ">&2 2>&1", ">log.txt"])
      expect([redirect, bareLaunches(line(redirect), place).map(({ remedy }) => remedy)]).toEqual([redirect, []])
    expect(bareLaunches(line("2>&1 1>&2"), place).map(({ remedy }) => remedy)).toEqual(["unknown"])
    expect(bareLaunches(line("2>/dev/null"), place).map(({ remedy }) => remedy)).toEqual(["unknown"])
    expect(bareLaunches('REF=$({ git log -1; } >&2; git branch --show-current); git checkout "$REF"; npm test', place)).toEqual([])
  })

  test("independent conditions are not correlated at separate joins", () => {
    const line = 'if test "$IS_RELEASE" = true; then REF=$(git describe --tags); echo "$REF"; else REF="$CI_BRANCH"; fi; if test "$IS_RELEASE" = false; then git checkout "$REF" && npm test; fi'
    expect(bareLaunches(line, place).map(({ remedy }) => remedy)).toEqual(["unknown"])
  })

  test("the live path bound reports uncertainty rather than picking an arm", () => {
    const branches = (count: number) => Array.from({ length: count }, (_, id) =>
      `if test -n "$CI"; then BRANCH_${id}=one; else BRANCH_${id}=two; fi;`).join(" ")
    const atBound = Math.log2(MAX_PATH_STATES)
    expect(bareLaunches(`${branches(atBound)} git checkout main; npm test`, place)).toEqual([])
    const line = `${branches(atBound + 1)} git checkout main; npm test`
    const findings = bareLaunches(line, place)
    expect(findings.map(({ remedy }) => remedy)).toEqual(["unknown"])
    expect(findings.map(keychainReason).join(" ")).toContain(`cannot tell what runs after the shell produces more than ${MAX_PATH_STATES}`)
    expect(bareLaunches(`git checkout HEAD~1; npm test; ${line}`, place).map(({ remedy }) => remedy)).toEqual(["shim"])
    const exits = 'if test -n "$CI"; then exit; fi; '.repeat(MAX_PATH_STATES + 1)
    expect(bareLaunches(`${exits} git checkout main; npm test`, place)).toEqual([])
  })

  test("generated choices match an independent path-enumerating oracle", () => {
    const directory = { ...place, cwd: "/guard/probe/tree" }
    const choices = [
      { text: "REF=$(git describe)", binding: "unknown", move: false, exits: false },
      { text: "REF=main", binding: "allow", move: false, exits: false },
      { text: "REF=$(git log -1); REF=main", binding: "allow", move: false, exits: false },
      { text: "REF=HEAD~1", binding: "shim", move: false, exits: false },
      { text: "cd ../tools", binding: "keep", move: true, exits: false },
      { text: "exit 0", binding: "keep", move: false, exits: true },
      { text: ":", binding: "keep", move: false, exits: false },
    ] as const
    type Action = typeof choices[number]
    type Program = Action | { readonly yes: Program; readonly no: Program; readonly syntax: "if" | "case" }
    type Oracle = { readonly remedy: Remedy | "allow"; readonly elsewhere: boolean }
    const enumerate = (program: Program, prior: Oracle): ReadonlyArray<Oracle> => {
      if ("yes" in program) return [...enumerate(program.yes, prior), ...enumerate(program.no, prior)]
      if (program.exits) return []
      const binding = Option.getOrElse(Option.liftPredicate(program.binding, (value) => value !== "keep"), () => prior.remedy)
      return [{ remedy: binding, elsewhere: prior.elsewhere || program.move }]
    }
    const render = (program: Program): string => {
      if ("text" in program) return program.text
      const yes = render(program.yes)
      const no = render(program.no)
      if (program.syntax === "case") return `case "$BRANCH" in yes) ${yes} ;; *) ${no} ;; esac`
      return `if test -n "$BRANCH"; then ${yes}; else ${no}; fi`
    }
    const first = choices.flatMap((yes) => choices.map((no): Program => ({ yes, no, syntax: "if" })))
    const programs = first.flatMap((yes) => choices.map((no): Program => ({ yes, no, syntax: "case" })))
    for (const program of [...first, ...programs]) for (const prior of choices) {
      if (prior.binding === "keep") continue
      const states = enumerate(program, { remedy: prior.binding, elsewhere: false })
      const candidates = states.values().filter(({ elsewhere }) => !elsewhere).map(({ remedy }) => remedy).toArray()
      let expected: Remedy | "allow" = "allow"
      if (candidates.includes("unknown")) expected = "unknown"
      if (candidates.includes("shim")) expected = "shim"
      const line = `${prior.text}; ${render(program)}; git checkout "$REF"; npm --prefix /guard/probe/tree test`
      const actual = bareLaunches(line, directory)[0]?.remedy || "allow"
      expect([line, actual]).toEqual([line, expected])
    }
  })

  test("history provenance follows the stream through arbitrary stages and nested substitutions", () => {
    const producer = "git log -1 --format=%H HEAD~1"
    const consumer = 'read -r REV; git checkout "$REV"; npm test'
    const remedies = (line: string) => bareLaunches(line, place).map(({ remedy }) => remedy)
    const stages = ["head -1", "tail -1 | sed -n '1p'", "custom-filter | sort | cut -f1", "{ cat; }", "(cat)"]
    for (const filter of stages) {
      expect(remedies(`${producer} | ${filter} | (${consumer})`)).toEqual(["unknown"])
      expect(remedies(`printf '%s\\n' main | ${filter} | (${consumer})`)).toEqual([])
    }
    const nested = "printf '%s' \"$(printf '%s' \"$(" + producer + ")\")\""
    const assignment = 'REV=$(' + nested + ' | unknown-filter); git checkout "$REV"; npm test'
    expect(remedies(assignment)).toEqual(["unknown"])
    expect(remedies(`history() { ${producer} | unknown-filter; }; REV=$(history); git checkout "$REV"; npm test`)).toEqual(["unknown"])
    expect(remedies(`{ ${consumer}; } <<< "$(${producer})"`)).toEqual(["unknown"])
    expect(remedies(`{ ${consumer}; } <<< main`)).toEqual([])
    expect(remedies(`history() { ${producer}; }; git checkout "$BRANCH"; npm test`)).toEqual([])
    expect(remedies(`${nested} | unknown-filter | (read -r REV; git checkout "$BRANCH"; npm test)`)).toEqual([])
    expect(remedies(`${producer} | head -1 | (read -r REV; git checkout "$REV"; git status)`)).toEqual([])
    expect(remedies(`export CHROME="${SHIM_PATH}"; ${assignment}`)).toEqual([])
  })

  test("the same stream binding works in each compound form and in pairs of nested forms", () => {
    const wrap = [
      (body: string) => `(${body})`,
      (body: string) => `{ ${body}; }`,
      (body: string) => `if true; then ${body}; fi`,
      (body: string) => `if false; then true; elif true; then ${body}; fi`,
      (body: string) => `if false; then true; else ${body}; fi`,
      (body: string) => `while true; do ${body}; break; done`,
      (body: string) => `until false; do ${body}; break; done`,
      (body: string) => `for _ in once; do ${body}; done`,
      (body: string) => `case yes in yes) ${body} ;; esac`,
      (body: string, level = 0) => `{ fixture${level}() { ${body}; }; fixture${level}; }`,
      (body: string) => `{ true && ${body}; }`,
      (body: string) => `{ false || ${body}; }`,
    ]
    const body = 'read -r REV; git checkout "$REV"; npm test'
    const forms = [body, ...wrap.map((one) => one(body)), ...wrap.flatMap((outer) => wrap.map((inner) => outer(inner(body, 1))))]
    for (const [producer, expected] of [["git rev-list -n1 HEAD~1", "unknown"], ["printf '%s\\n' main", "allow"]] as const) {
      for (const form of forms) {
        const line = `${producer} | ${form}`
        const actual = bareLaunches(line, place)[0]?.remedy || "allow"
        expect([line, actual]).toEqual([line, expected])
      }
    }
  })

  const lines = [
    "git -C bisect -c advice.detachedHead=false bisect run ./measure.sh",
    "git bisect start HEAD v1 && sh ./measure.sh",
    "git stash && git checkout HEAD~1 && bun ./measure.ts",
    "git switch --detach v1 && ./measure.sh",
    "git worktree add --detach /nonexistent/loop-probe-old abc1234 && cd /nonexistent/loop-probe-old && ./measure.sh",
    "for c in a b; do git checkout --detach \"$c\"; bun measure.ts; done",
  ]
  for (const line of lines) {
    test(line, () => {
      expect(bareLaunches(line, place).map((launch) => launch.remedy)).toEqual(["shim"])
      expect(bareLaunches(`export CHROME="${SHIM_PATH}"; ${line}`, place)).toEqual([])
    })
  }

  test("an assignment prefixed to Git protects its bisect subprocess but not a separate launcher", () => {
    const prefix = `CHROME="${SHIM_PATH}"`
    expect(bareLaunches(`${prefix} git -C bisect bisect run ./measure.sh`, place)).toEqual([])
    const line = `${prefix} git switch --detach v1 && ./measure.sh`
    const launches = bareLaunches(line, place)
    expect(launches.map((launch) => launch.remedy)).toEqual(["shim"])
    expect(launches.map(keychainReason).join()).toContain(`export ${prefix};`)
  })

  test("a checkout with no run or a pathspec is not an old-commit run", () => {
    expect(bareLaunches("git switch main && git log --oneline", place)).toEqual([])
    expect(bareLaunches("git checkout -- src && bun lint.ts", place)).toEqual([])
    expect(bareLaunches("git stash list && sh ./measure.sh", place)).toEqual([])
    expect(bareLaunches("git checkout HEAD~1 && sh -c 'cat ./fixture.md'", place)).toEqual([])
  })

  test("both explicit relative paths and tree-qualified pathspecs restore files, not HEAD", () => {
    expect(bareLaunches("git checkout ./fixture.md && npm test", place)).toEqual([])
    expect(bareLaunches("git checkout fixture-old -- fixture.md && npm test", place)).toEqual([])
    expect(bareLaunches("git restore --source fixture-old -- fixture.md && npm test", place)).toEqual([])
    expect(bareLaunches("git checkout HEAD~1 && npm test", place).map((launch) => launch.remedy)).toEqual(["shim"])
    const unknown = bareLaunches("git checkout --future-option fixture-old && npm test", place).map(keychainReason).join()
    expect(unknown).toContain("cannot tell whether the Git operation selects another revision or restores files")
    expect(unknown).not.toContain("after selecting another Git revision")
  })

  test("revision selection and file restoration depend on the Git subcommand's grammar", () => {
    const files = [
      "checkout --ours -- fixture.md", "checkout --pathspec-from-file=./paths", "checkout 'notes with spaces'",
      "restore --source=HEAD~1 fixture.md", "reset HEAD~1 -- fixture.md", "reset --patch HEAD~1",
      "log -- rebase --detach", "worktree list", "rebase --show-current-patch",
      "reset --soft HEAD~1", "rebase fixture-old", "stash branch fixture-old",
    ]
    const moves = [
      "switch --detach fixture-old", "checkout -b experiment HEAD~1", "checkout HEAD~1", "reset --keep HEAD~1",
      "rebase --exec 'npm test' fixture-old",
    ]
    for (const args of files) expect([args, refused(`git ${args} && npm test`)]).toEqual([args, false])
    for (const args of moves) expect([args, refused(`git ${args} && npm test`)]).toEqual([args, true])
    expect(refused("git worktree add --detach /nonexistent/loop-probe-new fixture-old && npm test")).toBe(false)
    expect(refused("git worktree add --detach /nonexistent/loop-probe-new fixture-old && cd /nonexistent/loop-probe-new && npm test")).toBe(true)
  })

  test("bisect mode determines whether the checked-out commit moves", () => {
    const start = "git bisect start"
    for (const action of [
      "--no-checkout HEAD fixture-old",
      "--first-parent --no-checkout HEAD fixture-old",
      "--term-new=fixed --term-old=broken --no-checkout HEAD fixture-old",
      "--no-checkout HEAD fixture-old; git bisect good; git bisect skip; git bisect reset",
    ]) expect([action, refused(`${start} ${action} && npm test`)]).toEqual([action, false])
    expect(refused(`${start} --first-parent HEAD fixture-old && npm test`)).toBe(true)
    expect(refused(`${start} HEAD fixture-old -- --no-checkout && npm test`)).toBe(true)
    expect(refused(`${start} --no-checkout HEAD fixture-old; git bisect run ./verify.sh`)).toBe(true)
    expect(bareLaunches(`${start} --not-a-documented-option HEAD fixture-old && npm test`, place).map(keychainReason).join()).toContain("cannot tell")
  })

  test("only historical selectors parse options; integration and recording do not", () => {
    const unchanged = [
      "checkout -b fresh", "checkout -B fresh", "switch -c fresh", "switch -C fresh",
      "restore --source=HEAD~2 -- file.txt", "pull --dry-run", "pull --negotiate-only", "merge --squash fixture-old", "merge --no-ff --no-commit fixture-old",
      "rebase --show-current-patch", "stash pop", "stash -u", "worktree list --porcelain",
      "pull --no-rebase --no-ff --no-commit origin main", "pull --ff-only", "merge --ff-only fixture-old", "merge --no-commit fixture-old",
      "merge --squash --no-squash fixture-old", "rebase --onto target upstream", "reset --soft fixture-old", "reset --mixed fixture-old",
    ]
    const moved = [
      "switch -c fresh HEAD~1", "reset --keep HEAD~1", "reset --merge HEAD~1", "rebase -x 'npm test' fixture-old",
      "checkout HEAD~1 -- scripts/launch", "checkout HEAD~1 -- runner.sh", "restore --source=HEAD~2 -- package.json",
    ]
    for (const command of unchanged) expect([command, refused(`git ${command}; npm test`)]).toEqual([command, false])
    for (const command of moved) expect([command, refused(`git ${command}; npm test`)]).toEqual([command, true])
    for (const command of ["checkout", "switch", "restore", "reset", "bisect start", "bisect reset", "rebase -x 'npm test'", "worktree add"]) {
      const line = `git ${command} --not-a-documented-option; npm test`
      expect([command, bareLaunches(line, place).map((launch) => launch.remedy)]).toEqual([command, ["unknown"]])
    }
    for (const command of ["rebase", "pull", "merge", "stash push", "worktree list", "clone", "submodule update"]) {
      expect([command, refused(`git ${command} --not-a-documented-option; npm test`)]).toEqual([command, false])
    }
  })

  test("all current-commit spellings leave the runtime's checkout alone", () => {
    for (const rev of ["HEAD", "@", "HEAD~0", "HEAD^0", "@~0", "@^0", "@~0^0"]) {
      for (const form of ["checkout -b review-branch", "switch -c review-branch", "checkout --detach", "reset --keep", "bisect reset"]) {
        expect([form, rev, refused(`git ${form} ${rev}; npm test`)]).toEqual([form, rev, false])
      }
      expect(refused(`git restore --source=${rev} -- scripts/launch.sh; npm test`)).toBe(false)
    }
  })

  test("plain branch and tag names supply no historical evidence without detach", () => {
    const plainNames = ["main", "fixture-main", "fixture-old", "fixture.md", "v1.2.3"]
    for (const name of plainNames) {
      for (const verb of ["checkout", "switch"]) {
        expect(refused(`git ${verb} ${name}; npm test`)).toBe(false)
        expect(refused(`git ${verb} --detach ${name}; npm test`)).toBe(true)
      }
    }
    expect(refused("git reset --hard probe-old; npm test")).toBe(false)
    expect(refused("git reset --hard deadbee; npm test")).toBe(true)
    expect(refused("git restore --source fixture-old -- tools/run.sh; npm test")).toBe(false)
    expect(refused("git restore --source ':/old subject' -- tools/run.sh; npm test")).toBe(true)
    expect(refused("git worktree add ../old fixture-old; cd ../old && npm test")).toBe(false)
    expect(refused("git worktree add --detach ../old fixture-old; cd ../old && npm test")).toBe(true)
  })

  test("a subshell's checkout persists but its directory does not", () => {
    expect(refused("(cd ../other-project && git checkout --detach fixture-old && git log -1); npm test")).toBe(false)
    expect(refused("(cd ../work && git checkout --detach fixture-old && git log -1); npm test")).toBe(true)
    expect(refused("(cd ../other-project && git checkout --detach fixture-old && git log -1); cd ../other-project && npm test")).toBe(true)
    expect(refused("git clone --branch fixture-old /nonexistent/source ../copy; npm test")).toBe(false)
    expect(refused("git clone --branch fixture-old /nonexistent/source ../copy; cd ../copy && npm test")).toBe(false)
    expect(refused("git clone --no-checkout /nonexistent/source ../copy; cd ../copy && npm test")).toBe(false)
    expect(refused("git --git-dir=../other-project/.git switch --detach fixture-old; npm test")).toBe(true)
    expect(refused("git --git-dir=../other-project/.git switch --detach fixture-old; cd ../other-project && npm test")).toBe(false)
  })

  test("literal bindings preserve historical syntax", () => {
    const remedies = (line: string) => bareLaunches(line, place).map((launch) => launch.remedy)
    const targets: ReadonlyArray<{ readonly value: string; readonly expected: ReadonlyArray<Remedy> }> = [
      { value: "deadbee", expected: ["shim"] },
      { value: "HEAD~1", expected: ["shim"] },
      { value: "HEAD~0", expected: [] },
      { value: "release-track", expected: [] },
    ]
    const spellings = [
      (rev: string) => `git checkout ${rev}; npm test`,
      (rev: string) => `REV=${rev}; git checkout "$REV"; npm test`,
      (rev: string) => `REV=${rev}; AGAIN="$REV"; git checkout "\${AGAIN}"; npm test`,
      (rev: string) => `for rev in main ${rev}; do git checkout "$rev"; npm test; done`,
      (rev: string) => `for rev in ${rev} main; do git checkout "$rev"; npm test; done`,
      (rev: string) => `sh -c 'git checkout "\${1:-${rev}}"; npm test'`,
      (rev: string) => `sh -c 'git checkout "$1"; npm test' fixture ${rev}`,
      (rev: string) => `while read -r rev; do git checkout "$rev"; npm test; done <<< "main\n${rev}"`,
      (rev: string) => `printf '%s\\n' main ${rev} | while read -r rev; do git checkout "$rev"; npm test; done`,
    ]
    const cases = targets.flatMap(({ value, expected }) => spellings.map((render) => ({ line: render(value), expected })))
    for (const { line, expected } of cases) expect([line, remedies(line)]).toEqual([line, [...expected]])
  })

  test("only unresolved operands fed by history or iteration require the shim before a launch", () => {
    const remedies = (line: string) => bareLaunches(line, place).map((launch) => launch.remedy)
    for (const select of [
      'git checkout --detach "$REV"',
      'git checkout "$(git rev-parse HEAD~1)"',
      'REF=$(git -C . rev-list first..last); ALIAS="$REF"; git checkout "$ALIAS"',
      'git log --format=%H -1 | read -r REF; git checkout "$REF"',
      'git checkout "$REF~1"',
      'git restore --source="$(git describe)" -- runner.sh',
      'git checkout "$(git tag --list)"',
      'git checkout "$(git merge-base left right)"',
      'git checkout "$(git reflog --format=%H -1)"',
      'git checkout "$(git bisect log)"',
      'for rev in $(git rev-list first..last); do git checkout "$rev"; done',
      'for CI_BRANCH in $(git rev-list first..last); do git checkout "$CI_BRANCH"; done',
      'for rev in $INPUT; do COPY="$rev"; git checkout "$COPY"; done',
      'while read -r rev; do git checkout "$rev"; done < fixture.txt',
      'while read -r rev message; do git checkout "$rev"; done < fixture.txt',
      'while read -r; do git checkout "$REPLY"; done < fixture.txt',
      'while REV=$(cat fixture.txt); do git checkout "$REV"; done',
      'until read -r rev; do git checkout "$rev"; done < fixture.txt',
      'git rev-list first..last | xargs -n1 sh -c \'git checkout "$1"\' probe',
      'cat inputs.txt | xargs -I % git checkout %',
      'find fixture -type f -exec git checkout {} \\;',
    ]) {
      expect([select, remedies(`${select}; npm test`)]).toEqual([select, ["unknown"]])
      expect([select, remedies(`${select}; git status -sb`)]).toEqual([select, []])
      expect([select, remedies(`export CHROME="${SHIM_PATH}"; ${select}; npm test`)]).toEqual([select, []])
    }
    for (const select of [
      'git checkout "$1"',
      'git checkout "$CI_BRANCH"',
      'git checkout "refs/heads/$BRANCH"',
      'git checkout "origin/$CI_COMMIT_BRANCH"',
      'git checkout "$(cat choice.txt)"',
      'git checkout "$(git rev-parse HEAD)"',
      'git checkout "$(echo git rev-list)"',
      'git checkout "$(git tag fixture)"',
      'git checkout -- "$REV"',
      "git checkout '$REV'",
      'for item in $INPUT; do git checkout "$BRANCH"; done',
      'for ref in $INPUT; do git status -sb; done; git checkout "$ref"',
      'NAME=$(git rev-list first..last); NAME="$BRANCH"; git checkout "$NAME"',
      'git merge "$REV"',
      'git -C ../beta checkout --detach "$REV"',
      'git restore --source="$REV" -- runner.sh',
    ]) expect([select, remedies(`${select}; npm test`)]).toEqual([select, []])
  })

  test("a one-off computed hash without history evidence is a stated limit", () => {
    const target = '"$(printf %s deadbee)"'
    expect(refused(`git checkout ${target}; npm test`)).toBe(false)
    expect(bareLaunches(`git checkout --detach ${target}; npm test`, place).map(({ remedy }) => remedy)).toEqual(["unknown"])
  })

  test("branch creation uses the start point, not the branch name", () => {
    for (const creation of ["checkout -b", "checkout -B", "switch -c"]) {
      const command = `git ${creation} "$NEW_BRANCH"`
      for (const start of ["", "main", '"$START"']) expect(refused(`${command} ${start}; npm test`)).toBe(false)
      expect(refused(`${command} HEAD~2; npm test`)).toBe(true)
      expect(refused(`START=deadbee; ${command} "$START"; npm test`)).toBe(true)
      expect(refused(`for START in $INPUT; do ${command} "$START"; npm test; done`)).toBe(true)
    }
    expect(refused('for ref in $INPUT; do git switch "$ref"; npm test; done')).toBe(false)
  })

  test("generated sequences only guard a later launcher in the affected sibling tree", () => {
    const trees = ["alpha", "beta", "gamma"]
    const tree = (name: string) => `/nonexistent/loop-probe-trees/${name}`
    const where = { cwd: tree("alpha"), home: HOME }
    const git = "git switch --detach fixture-old"
    const selectors = [
      (name: string) => `(cd ../${name} && ${git} && git log -1)`,
      (name: string) => `(pushd ../${name} && ${git}; popd)`,
      (name: string) => `(cd ../${name} && ${git}) | cat`,
      (name: string) => `printf '%s\\n' fixture | (cd ../${name} && ${git})`,
      (name: string) => `git -C .. -C ./${name} switch --detach fixture-old`,
      (name: string) => `git -C ../${name} --git-dir=../metadata switch --detach fixture-old`,
      (name: string) => `git -C .. --git-dir=../metadata --work-tree=${name} switch --detach fixture-old`,
      (name: string) => `env -C ../${name} git switch --detach fixture-old`,
    ]
    const launchers = [
      (name: string) => `(cd ../${name} && npm test)`,
      (name: string) => `env -C ../${name}/./src/.. npm test`,
      (name: string) => `pushd ../${name}/src; npm test; popd`,
      (name: string) => `npm --prefix ../${name}/src/.. test`,
      (name: string) => `make -C ../${name} test`,
      (name: string) => `cargo test --manifest-path ../${name}/Cargo.toml`,
    ]
    const positions = trees.flatMap((first) => trees.flatMap((second) => trees.map((final) => ({ first, second, final }))))
    const spellings = selectors.flatMap((select) => launchers.map((launch) => ({ select, launch })))
    for (const { first, second, final } of positions) for (const { select, launch } of spellings) {
      const changes = `${select(first)}; git -C ../gamma log --oneline; ${select(second)}`
      const hazard = first === final || second === final
      const before = `${launch(final)}; ${changes}`
      const after = `${changes}; ${launch(final)}`
      expect([before, bareLaunches(before, where).length > 0]).toEqual([before, false])
      expect([after, bareLaunches(after, where).length > 0]).toEqual([after, hazard])
    }
    expect(bareLaunches("git -C ../beta switch --detach fixture-old; cd \"$TARGET\"; npm test", where).map((entry) => entry.remedy)).toEqual(["unknown"])
    expect(bareLaunches("git -C \"$TARGET\" switch --detach fixture-old; npm test", where).map((entry) => entry.remedy)).toEqual(["unknown"])
    expect(bareLaunches("git -C ../beta switch --detach fixture-old; cd \"$TARGET\"; cd /nonexistent/loop-probe-trees/gamma; npm test", where)).toEqual([])
  })
})

describe("the scripts a line runs", () => {
  const runs = (line: string) => runtimeRuns(line, place).map((run) => run.ran)

  test("a script file, resolved where it runs; inline code; bun test and bare runtimes run none", () => {
    expect(runs("bun probe.ts")).toEqual([ScriptFile.make({ path: `${CWD}/probe.ts` })])
    expect(runs("bun run ../scratch/probe.ts --flag")).toEqual([ScriptFile.make({ path: "/home/owner/scratch/probe.ts" })])
    expect(runs("cd /tmp/run && nice bun --smol rebind.mts a b")).toEqual([ScriptFile.make({ path: "/tmp/run/rebind.mts" })])
    expect(runs("node ~/probe.mjs")).toEqual([ScriptFile.make({ path: `${HOME}/probe.mjs` })])
    expect(runs('FOO=1 bun "$T/x.ts"')).toEqual([ScriptFile.make({ path: `${CWD}/$T/x.ts` })])
    // A variable the line sets is put in, as the agents' probes are run.
    expect(runs("D=/tmp/opencode/unit; bun $D/rebind.ts")).toEqual([ScriptFile.make({ path: "/tmp/opencode/unit/rebind.ts" })])
    expect(runs('export T=/tmp/opencode R="${T}/r3" && cd /x && bun "${R}/probe.ts"')).toEqual([ScriptFile.make({ path: "/tmp/opencode/r3/probe.ts" })])
    expect(runs("bun -e 'Bun.spawn([c])'")).toEqual([Inline.make({ code: "Bun.spawn([c])" })])
    expect(runs("bun test mods/rex/process/browser.test.ts")).toEqual([])
    expect(runs("bun install && bun run gate")).toEqual([])
    expect(runs("cat probe.ts")).toEqual([])
  })

  test("only the runtime's entry point is read, not forwarded arguments or syntax-check input", () => {
    for (const line of [
      "sh -nc 'git bisect run ./measure.sh'",
      "bash -o noexec /tmp/receipt.sh /tmp/profile.sh",
      "sh -s /tmp/receipt.sh",
      "bash /tmp/entry /tmp/bisect.sh",
      "bun --version /tmp/bisect.ts",
      "node --check /tmp/bisect.js",
      "bun --help /tmp/bisect.ts",
      "node server --eval /tmp/bisect.ts",
    ]) expect([line, refused(line)]).toEqual([line, false])
    expect(runs("sh -n +n /tmp/bisect.sh")).toEqual([ScriptFile.make({ path: "/tmp/bisect.sh" })])
    expect(runs("sh /tmp/entry /tmp/bisect.sh")).toEqual([ScriptFile.make({ path: "/tmp/entry" })])
    expect(runs("node server --eval /tmp/bisect.ts")).toEqual([ScriptFile.make({ path: `${CWD}/server` })])
    expect(runs("bash -o noexec /tmp/receipt.sh /tmp/profile.sh")).toEqual([])
  })

  test("Node's startup modules precede the entry, including environment and repeated CLI options", () => {
    const line = "env NODE_OPTIONS='--import /m/env.mjs -r /m/env.cjs' node --import=/m/cli.mjs --require /m/cli.cjs /m/app.js"
    expect(runs(line)).toEqual(["env.cjs", "cli.cjs", "env.mjs", "cli.mjs", "app.js"].map((name) => ScriptFile.make({ path: `/m/${name}` })))
  })
})

// The copied probes, Exact's launches and its CLI words are fixtures/keychain-scripts.test.ts's.
describe("a script that starts a bare Chrome", () => {
  const spawn = (binary: string, flags: string) => `const chrome = Bun.spawn(["${binary}", ${flags}, "about:blank"])`

  test("hands a Chrome it names a DevTools or headless list without both keychain flags", () => {
    expect(scriptLaunchesBare(spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", '"--headless=new"'))).toBe(true)
    expect(scriptLaunchesBare(spawn("chrome-headless-shell", '"--remote-debugging-port=0"'))).toBe(true)
    expect(scriptLaunchesBare(spawn("Google Chrome for Testing", '"--remote-debugging-pipe", "--use-mock-keychain"'))).toBe(true)
    // spawn(program, list), a name bound to the path, a list over lines with a template flag, a spread list.
    expect(scriptLaunchesBare("const CHROME = join(HOME, 'chrome-headless-shell')\nspawn(CHROME, [\n  '--no-first-run',\n  `--remote-debugging-port=${port}`,\n])")).toBe(true)
    expect(scriptLaunchesBare('const BASE = ["--headless"]\nexecFileSync("chromium", [...BASE, "--dump-dom", url])')).toBe(true)
    expect(scriptLaunchesBare('Bun.spawn({ cmd: ["google-chrome", "--headless", url], stdout: "pipe" })')).toBe(true)
  })

  test("a Chrome named through another module is its launcher's: no launch here", () => {
    expect(scriptLaunchesBare("const child = spawn(chromium().executable, ['--headless=new', '--remote-debugging-pipe', 'about:blank'])")).toBe(false)
  })

  test("is no launch where a flag is only looked for, or prose", () => {
    expect(scriptLaunchesBare("// Bun starts a headless Chrome\nconst orphan = args.includes('--headless') && name === 'chrome'")).toBe(false)
    expect(scriptLaunchesBare("const HELP = ['--device · --reader · --headless', 'headless Chrome over a pipe']")).toBe(false)
  })

  test("is left alone with both flags, with no DevTools or headless flag, with no Chrome named, or through Puppeteer's own defaults", () => {
    expect(scriptLaunchesBare(spawn("Google Chrome for Testing", '"--headless=new", "--use-mock-keychain", "--password-store=basic"'))).toBe(false)
    expect(scriptLaunchesBare(spawn("chromium", '"--window-size=800,600"'))).toBe(false)
    expect(scriptLaunchesBare('Bun.spawn(["ffmpeg", "--headless"])')).toBe(false)
    expect(scriptLaunchesBare("// agent-browser drives Chrome; nothing is spawned here\nawait fetch(url)")).toBe(false)
    expect(scriptLaunchesBare("const browser = await launch({ executablePath: CHROME, args: ['--headless'] })")).toBe(false)
    expect(scriptLaunchesBare("await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })")).toBe(false)
  })

  test("is a launch of the command that ran it, named by its script, with both flags as its way through", () => {
    const run = { command: "bun /tmp/probe.ts", ran: ScriptFile.make({ path: "/tmp/probe.ts" }), shimmed: false }
    expect(scriptLaunch(run, spawn("chromium", '"--headless"'))).toEqual(Option.some({ command: "bun /tmp/probe.ts", script: Option.some("/tmp/probe.ts"), remedy: "flags" }))
    expect(scriptLaunch(run, "console.log(1)")).toEqual(Option.none())
  })
})

describe("a script that runs other commits", () => {
  const run = (path: string, shimmed = false) => ({ command: `bun ${path}`, ran: ScriptFile.make({ path }), shimmed })

  test("a script named for a bisect and a detached checkout loop are refused without the shim, which is their way through", () => {
    expect(Option.map(scriptLaunch(run("/m/bisect-budget.ts"), "console.log(1)"), (launch) => launch.remedy)).toEqual(Option.some("shim"))
    expect(Option.isSome(scriptLaunch(run("/m/walk.sh"), "for c in $(git rev-list a..b); do git checkout --detach $c; bun measure.ts; done"))).toBe(true)
    expect(Option.isSome(scriptLaunch(run("/m/walk.ts"), "sh(['git', 'switch', '--detach', sha])"))).toBe(true)
  })

  test("with CHROME set to the shim on the line, or with no checkout of another commit, they run", () => {
    expect(scriptLaunch(run("/m/bisect-budget.ts", true), "sh(['git', 'switch', '--detach', sha])")).toEqual(Option.none())
    expect(scriptLaunch(run("/m/walk.ts"), "sh(['git', 'switch', 'main'])")).toEqual(Option.none())
    expect(runtimeRuns(`CHROME="${SHIM_PATH}" bun /m/bisect.ts a b`, place).map((each) => each.shimmed)).toEqual([true])
    expect(runtimeRuns("bun /m/bisect.ts a b", place).map((each) => each.shimmed)).toEqual([false])
  })

  test("comments, logs, and Git arguments are not commands; a vendor launcher's actual command is", () => {
    const shell = [
      "# git checkout --detach v1",
      "printf '%s\\n' 'git bisect run ./measure.sh'",
      "git log --oneline -- checkout --detach",
      "grep -F 'git checkout --detach' receipt.sh",
    ].join("\n")
    const js = [
      "// sh(['git', 'checkout', '--detach', sha])",
      "console.log(['git', 'switch', '--detach', sha])",
      "sh(['git', 'log', '--', 'bisect', 'run'])",
      "const sample = \"git bisect run ./measure.sh\"",
      "/* spawn('git', ['bisect', 'run', './measure.sh']) */",
    ].join("\n")
    expect(scriptLaunch(run("/m/receipt.sh"), shell)).toEqual(Option.none())
    expect(scriptLaunch(run("/m/receipt.ts"), js)).toEqual(Option.none())
    expect(Option.map(scriptLaunch(run("/m/vendor/measure.sh"), "git -C old checkout HEAD~1 && cd old && ./launcher.sh"), (launch) => launch.remedy)).toEqual(Option.some("shim"))
    expect(Option.map(scriptLaunch(run("/m/vendor/measure.sh"), "chromium --headless"), (launch) => launch.remedy)).toEqual(Option.some("flags"))
  })

  test("JS process calls actually running Bisect or a detached checkout are still refused", () => {
    for (const code of [
      'execSync("git bisect run ./measure.sh")',
      'Bun.spawn(["git", "-C", "/nonexistent/loop-probe", "bisect", "run", "./measure.sh"])',
      'spawn("sh", ["-c", "git switch --detach HEAD~1 && sh ./measure.sh"])',
      "await $`git bisect run ./measure.sh`",
    ]) {
      expect([code, Option.map(scriptLaunch(run("/m/walk.ts"), code), (launch) => launch.remedy)]).toEqual([code, Option.some("shim")])
      expect(scriptLaunch(run("/m/walk.ts", true), code)).toEqual(Option.none())
    }
  })

  test("without a loader an invoked child supplies no evidence", () => {
    expect(scriptLaunch(run("/m/parent.sh"), "sh /m/child.sh")).toEqual(Option.none())
  })
})

describe("the refusal", () => {
  test("names the launch, both flags, the dialog and the testing tools to use", () => {
    const reason = keychainReason({ command: "chromium --headless", script: Option.none(), remedy: "flags" })
    expect(reason).toStartWith("`chromium --headless` starts Chrome with a DevTools port or headless and without --use-mock-keychain --password-store=basic")
    expect(reason).toContain("keychain dialog on the owner's screen")
    expect(reason).toContain("Use Playwright for tests or the browse tool")
    expect(keychainReason({ command: "bun /tmp/p.ts", script: Option.some("/tmp/p.ts"), remedy: "flags" })).toStartWith("`bun /tmp/p.ts` runs /tmp/p.ts, which starts Chrome")
  })

  test("for a bisect, names the shim prefix, the command written with it", () => {
    const reason = keychainReason({ command: "git bisect run ./m.sh", script: Option.none(), remedy: "shim" })
    expect(reason).toStartWith("`git bisect run ./m.sh` runs a bisect, whose browser launchers may predate --use-mock-keychain --password-store=basic")
    expect(reason).toEndWith(`CHROME="${SHIM_PATH}" git bisect run ./m.sh`)
  })
})
