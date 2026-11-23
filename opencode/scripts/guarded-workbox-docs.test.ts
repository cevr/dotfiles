// Tracked Markdown/text docs across the repository, plus shell entry points.
// @reads ../README.md ../**/*.{md,mdx,rst,txt,org,adoc,markdown} **/*.{md,mdx,rst,txt,org,adoc,markdown} ../**/*.sh **/*.sh ../workbox/bin/** ../linux/hetzner-workbox/**
import { expect, test } from "bun:test"
import { basename } from "node:path"

const root = new URL("../../", import.meta.url).pathname
const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, env })
if (tracked.exitCode !== 0) throw new Error(tracked.stderr.toString())
const paths = [...new Set(tracked.stdout.toString().split("\0").filter(Boolean))]
const text = (path: string) => Bun.file(`${root}${path}`).text()
const matches = (source: string, re: RegExp) => [...source.matchAll(re)]

const localPin = "WORKBOX_EXPECT_MACHINE_ID"
const guard = String.raw`(?:hb_require_host|workbox_require_host)`
const arg = String.raw`"?\$\{1:-\}"?`
const mode = String.raw`([\w-]+)`

/** Read the guard call sites, not the usage comments or a second list of commands. */
function contract(path: string, source: string) {
  const lines = source.split("\n").map((line) => line.replace(/\s+#.*$/, "").trim()).filter((line) => line && !line.startsWith("#"))
  const calls = lines.flatMap((line, i) => new RegExp(String.raw`(?:^|[|;&\s])${guard}(?:$|[;\s])`).test(line) ? [i] : [])
  if (!calls.length) return
  const first = lines[calls[0]!]!
  const unless = new RegExp(String.raw`^\[{1,2} ${arg} ={1,2} ${mode} \]{1,2} \|\| ${guard}$`).exec(first)
  const only = /^([\w|-]+)\)$/.exec(lines[calls[0]! - 4] ?? "")
  const noArgs = /^\[ "\$#" -eq 0 \]; then$/.test((lines[calls[0]! - 4] ?? "").replace(/^if /, ""))
  const peer = matches(source, /^\s+\[\[ \$\{([A-Z_]+):-\} =~ \^\[a-f0-9\]\{32\}\$ \]\] \|\|/gm)
    .map((match) => match[1]!)
  const pins = [localPin, ...peer]
  if (calls.length > 1) {
    // Fleet --apply can use an enrolled identity (or legacy caller authority).
    // Human examples may not rely on that automated exception. The unqualified
    // manual branch still calls the same guard.
    if (!new RegExp(String.raw`^if \[ ${arg} = --apply \]; then$`, "m").test(source) ||
        lines[calls.at(-1)! - 1] !== "else") throw new Error(`${path}: unrecognized multi-branch host guard`)
    return { pins, requires: () => true }
  }
  if (unless) return { pins, requires: (firstArg: string) => firstArg !== unless[1] }
  if (only && lines[calls[0]! - 5] === 'case ${1:-} in') {
    return { pins, requires: (firstArg: string) => only[1]!.split("|").includes(firstArg) }
  }
  if (noArgs) return { pins, requires: (firstArg: string) => firstArg === "" }
  if (first === "hb_require_host" || first === "workbox_require_host") return { pins, requires: () => true }
  throw new Error(`${path}: unrecognized host guard: ${first}`)
}

const shells = await Promise.all(paths.filter((path) => path.endsWith(".sh") ||
  (path.startsWith("workbox/bin/") || path.startsWith("linux/hetzner-workbox/")) && !basename(path).includes(".")).map(async (path) =>
  [path, await text(path)] as const,
))
const commands = new Map(shells.flatMap(([path, source]) => {
  if (!source.startsWith("#!")) return []
  const entry = contract(path, source)
  return entry ? [[basename(path), entry] as const] : []
}))

/** CommonMark fenced examples, including nested list indentation, ~ fences and unlabelled fences. */
function blocks(source: string) {
  let open: { fence: string; lines: string[]; start: number } | undefined
  const out: Array<{ code: string; start: number }> = []
  for (const [i, line] of source.split("\n").entries()) {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (open === undefined) {
      if (fence) open = { fence: fence[1]!, lines: [], start: i + 2 }
    } else if (fence && fence[1]!.startsWith(open.fence) && !fence[2]!.trim()) {
      out.push({ code: open.lines.join("\n"), start: open.start })
      open = undefined
    } else {
      open.lines.push(line)
    }
  }
  if (open) out.push({ code: open.lines.join("\n"), start: open.start })
  return out
}

/** Shell words with quoting preserved; an unquoted separator is a command boundary. */
const words = /(?:[^ \t"';&|]+|"[^"]*"|'[^']*')+|&&|\|\||[;&|]/g
const unquote = (word: string) => word.replace(/["']/g, "")
const assignment = /^[A-Z_][A-Z_0-9]*=/i
const separator = /^(?:&&|\|\||[;&|])$/
const sourceNote = /# Pin source: .*deployment record.*see \[Host identity\]\(#host-identity\)/
const warning = "Reading the ID from whichever machine you are logged into defeats the check."

function violations(path: string, contents: string): string[] {
  const problems = []
  for (const block of blocks(contents)) {
    let command = ""
    let start = block.start
    let note = ""
    for (const [i, raw] of block.code.split("\n").entries()) {
      const line = raw.trim()
      if (line.startsWith("#") || !line) { note = line; continue }
      if (!command) start = block.start + i
      command += line.replace(/\\$/, " ")
      if (line.endsWith("\\")) continue
      const tokens = (command.match(words) ?? []).filter((_, at, all) => {
        const comment = all.findIndex((word) => word.startsWith("#"))
        return comment === -1 || at < comment
      })
      let from = 0
      for (const [at, token] of tokens.entries()) {
        if (separator.test(token)) { from = at + 1; continue }
        const entry = commands.get(basename(unquote(token)))
        if (!entry || (tokens[at + 1] ?? "").startsWith("=")) continue
        const where = `${path}:${start}: ${basename(unquote(token))}`
        if (!entry.requires(separator.test(tokens[at + 1] ?? "") ? "" : unquote(tokens[at + 1] ?? ""))) {
          if (!/^# No pin needed: /.test(note)) problems.push(`${where}: mark the read-only example as no pin needed`)
          continue
        }
        const before = tokens.slice(from, at)
        const sudo = before.indexOf("sudo")
        const prefix = sudo === -1 ? before : before.slice(sudo + 1).filter((word) => word !== "-n")
        if (sudo !== -1 && prefix.shift() !== "env") problems.push(`${where}: pass the pin through sudo env`)
        const commandAt = prefix.findIndex((word) => !assignment.test(word))
        const assignments = prefix.slice(0, commandAt < 0 ? prefix.length : commandAt)
        const launcher = commandAt < 0 ? [] : prefix.slice(commandAt)
        if (launcher.length > 1 || (launcher.length === 1 && !/^(?:bash|sh)$/.test(basename(launcher[0]!)))) {
          problems.push(`${where}: use a direct invocation or sh/bash after the inline assignments`)
        }
        const variables = new Set<string>()
        for (const pin of entry.pins) {
          const variable = assignments.map((word) => new RegExp(`^${pin}="\\$([A-Z_][A-Z0-9_]*)"$`).exec(word)?.[1]).find(Boolean)
          if (!variable) {
            problems.push(`${where}: missing inline ${pin} from the deployment record`)
          } else if (variables.has(variable)) problems.push(`${where}: source and destination must have separate deployment record pins`)
          else variables.add(variable)
        }
        if (!sourceNote.test(note) || contents.split(warning).length !== 2) {
          problems.push(`${where}: name the deployment record beside the command and link the document's single Host identity warning`)
        }
      }
      command = ""
      note = ""
    }
  }
  return problems
}

test("tracked documentation passes the script-derived host guard inline", async () => {
  expect(commands.size).toBeGreaterThan(0)
  const docs = paths.filter((path) => /\.(md|mdx|rst|txt|org|adoc|markdown)$/i.test(path))
  const results = await Promise.all(docs.map(async (path) => violations(path, await text(path))))
  expect(results.flat()).toEqual([])
})

test("a new guarded example cannot omit the pin, put it before sudo, or drop the transfer destination", () => {
  const doc = `## Host identity\n${warning}\n\n~~~sh\n# Pin source: deployment record; see [Host identity](#host-identity).\n`
  const check = (command: string) => violations("skills/new/SKILL.md", `${doc}${command}\n~~~\n`)
  expect(check("sudo -n env \"$d/backup.sh\" list")).toContain("skills/new/SKILL.md:6: backup.sh: missing inline WORKBOX_EXPECT_MACHINE_ID from the deployment record")
  expect(check('WORKBOX_EXPECT_MACHINE_ID="$RECORDED_ID" sudo "$d/backup.sh" list').length).toBeGreaterThan(0)
  expect(check('sudo env WORKBOX_EXPECT_MACHINE_ID="$SOURCE_ID" "$d/sync.sh" --dry-run pass 1')).toContain(
    "skills/new/SKILL.md:6: sync.sh: missing inline HB_TARGET_MACHINE_ID from the deployment record",
  )
  expect(check('sudo -n env WORKBOX_EXPECT_MACHINE_ID="$RECORDED_ID" \\\n  bash "$d/backup.sh" list')).toEqual([])
  expect(check('sudo env WORKBOX_EXPECT_MACHINE_ID="$RECORDED_ID" HB_TARGET_MACHINE_ID="$RECORDED_ID" "$d/sync.sh" rest').length).toBeGreaterThan(0)
  expect(check('sudo env WORKBOX_EXPECT_MACHINE_ID="$RECORDED_ID" env -i "$d/backup.sh" list').length).toBeGreaterThan(0)
})

test("only the source-derived no-pin modes may be marked read-only", () => {
  const noPin = (command: string) => violations("fixture.md", `\`\`\`sh\n# No pin needed: read-only.\n${command}\n\`\`\``)
  expect(noPin("sudo ./layout.sh --dry-run")).toEqual([])
  expect(noPin("./storage.sh check")).toEqual([])
  expect(noPin("./bootstrap.sh --check")).toEqual([])
  expect(noPin("workbox-rift-storage --check")).toEqual([])
  expect(noPin("workbox-rift-storage --fstab").length).toBeGreaterThan(0)
  expect(noPin("install-node").length).toBeGreaterThan(0)
  expect(noPin("install-node --check")).toEqual([])
  expect(noPin("./sync.sh --dry-run pass 2").length).toBeGreaterThan(0)
})
