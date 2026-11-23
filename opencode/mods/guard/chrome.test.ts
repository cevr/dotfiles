// The keychain rule on its own: which command lines start a Chrome for DevTools
// or headless without the two keychain flags, whatever the spelling; which
// scripts a line runs; which script texts start such a Chrome; and the words.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { bareLaunches, Inline, KEYCHAIN_FLAGS, keychainReason, runtimeRuns, ScriptFile, scriptLaunch, scriptLaunchesBare } from "./chrome.ts"

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
  "bun ~/Developer/personal/dotfiles/opencode/scripts/chrome.ts launch -- --window-size=800,600",
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
})

describe("the refusal", () => {
  test("names the launch, both flags, the dialog and the launcher to use", () => {
    const reason = keychainReason({ command: "chromium --headless", script: Option.none(), remedy: "flags" })
    expect(reason).toStartWith("`chromium --headless` starts Chrome with a DevTools port or headless and without --use-mock-keychain --password-store=basic")
    expect(reason).toContain("keychain dialog on the owner's screen")
    expect(reason).toContain("Add both flags to the launch, or start Chrome with `bun ~/Developer/personal/dotfiles/opencode/scripts/chrome.ts launch")
    expect(keychainReason({ command: "bun /tmp/p.ts", script: Option.some("/tmp/p.ts"), remedy: "flags" })).toStartWith("`bun /tmp/p.ts` runs /tmp/p.ts, which starts Chrome")
  })

  test("for a bisect, names the shim prefix, the command written with it", () => {
    const reason = keychainReason({ command: "git bisect run ./m.sh", script: Option.none(), remedy: "shim" })
    expect(reason).toStartWith("`git bisect run ./m.sh` runs a bisect, whose browser launchers may predate --use-mock-keychain --password-store=basic")
    expect(reason).toEndWith(`CHROME="${SHIM_PATH}" git bisect run ./m.sh`)
  })
})
