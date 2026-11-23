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

describe("a script that starts a bare Chrome", () => {
  const spawn = (binary: string, flags: string) => `const chrome = Bun.spawn(["${binary}", ${flags}, "about:blank"])`

  test("names a Chrome and a DevTools or headless flag without both keychain flags", () => {
    expect(scriptLaunchesBare(spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", '"--headless=new"'))).toBe(true)
    expect(scriptLaunchesBare(spawn("chrome-headless-shell", '"--remote-debugging-port=0"'))).toBe(true)
    expect(scriptLaunchesBare(spawn("Google Chrome for Testing", '"--remote-debugging-pipe", "--use-mock-keychain"'))).toBe(true)
    // A list over lines, a template flag, a flag first in its list (the shapes of the 2026-11-22 probes).
    expect(scriptLaunchesBare("const CHROME = join(HOME, 'chrome-headless-shell')\nspawn(CHROME, [\n  '--no-first-run',\n  `--remote-debugging-port=${port}`,\n])")).toBe(true)
    expect(scriptLaunchesBare('const c = "/opt/chromium"; Bun.spawn([c].concat(["--headless=new"]))')).toBe(true)
  })

  test("is no launch where the flag is only looked for or written in prose", () => {
    // skills/reclaim's leftover finder reads a process's command line; Exact's help text names the flag.
    expect(scriptLaunchesBare("// Bun starts a headless Chrome\nconst orphan = args.includes('--headless') && name === 'chrome'")).toBe(false)
    expect(scriptLaunchesBare("const HELP = ['--device · --reader · --headless', 'headless Chrome over a pipe']")).toBe(false)
  })

  test("is left alone with both flags, with no DevTools or headless flag, or with no Chrome named", () => {
    expect(scriptLaunchesBare(spawn("Google Chrome for Testing", '"--headless=new", "--use-mock-keychain", "--password-store=basic"'))).toBe(false)
    expect(scriptLaunchesBare(spawn("chromium", '"--window-size=800,600"'))).toBe(false)
    expect(scriptLaunchesBare('Bun.spawn(["ffmpeg", "--headless"])')).toBe(false)
    expect(scriptLaunchesBare("// agent-browser drives Chrome; nothing is spawned here\nawait fetch(url)")).toBe(false)
  })

  test("is a launch of the command that ran it, named by its script", () => {
    const run = { command: "bun /tmp/probe.ts", ran: ScriptFile.make({ path: "/tmp/probe.ts" }) }
    expect(Option.map(scriptLaunch(run, spawn("chromium", '"--headless"')), (launch) => launch.script)).toEqual(Option.some(Option.some("/tmp/probe.ts")))
    expect(scriptLaunch(run, "console.log(1)")).toEqual(Option.none())
  })
})

describe("the refusal", () => {
  test("names the launch, both flags, the dialog and the launcher to use", () => {
    const reason = keychainReason({ command: "chromium --headless", script: Option.none() })
    expect(reason).toStartWith("`chromium --headless` starts Chrome with a DevTools port or headless and without --use-mock-keychain --password-store=basic")
    expect(reason).toContain("keychain dialog on the owner's screen")
    expect(reason).toContain("bun ~/Developer/personal/dotfiles/opencode/scripts/chrome.ts launch")
    expect(keychainReason({ command: "bun /tmp/p.ts", script: Option.some("/tmp/p.ts") })).toStartWith("`bun /tmp/p.ts` runs /tmp/p.ts, which starts Chrome")
  })
})
