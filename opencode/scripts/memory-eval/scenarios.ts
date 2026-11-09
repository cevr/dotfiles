// The episodes' scenarios. Each is a fake repository, a session-1 task during
// which the agent learns three durable facts in realistic ways (an owner
// correction, a gotcha in tool output, a stated preference), and a session-2
// task where those facts matter and nothing hints at them. Session 2 is graded
// from the recorded tool calls alone, deterministically.
import { commitMessages, programOf, type Rule, segments, stagesAll, words, type World } from "./world.ts"

export interface Fact {
  readonly id: string
  readonly kind: "correction" | "gotcha" | "preference"
  /** What the agent should have learned, for the report. */
  readonly what: string
  /** A stored note (or memory file) holds the fact when every key matches it. */
  readonly keys: ReadonlyArray<RegExp>
}

export interface Call {
  readonly session: 1 | 2
  readonly step: number
  readonly name: string
  readonly input: Record<string, unknown>
  readonly output: string
  readonly error: boolean
}

/** A scripted user turn: fixed text, or text chosen from what the agent did so far in the session. */
export type Turn = string | ((calls: ReadonlyArray<Call>) => string)

export interface Scenario {
  readonly id: string
  readonly cwd: string
  readonly files: Record<string, string>
  /** `git status --short` lines the agent did not cause. */
  readonly noise: ReadonlyArray<string>
  /** The branch each session starts on. */
  readonly branches: readonly [string, string]
  /** The repository's commit subjects, oldest first; git.ts's default when absent. */
  readonly history?: ReadonlyArray<string>
  /** Directories outside the repository the shell can list, beyond the path down to it. */
  readonly outside?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly rules: ReadonlyArray<Rule>
  readonly session1: ReadonlyArray<Turn>
  readonly session2: ReadonlyArray<Turn>
  readonly facts: ReadonlyArray<Fact>
  /** Per fact id, whether session 2's calls honoured it. */
  readonly grade: (calls: ReadonlyArray<Call>) => Record<string, boolean>
}

export interface Shelled {
  readonly segment: string
  readonly program: string
  readonly command: string
}

/** Every command the shell ran, in order, split into segments. */
export const shelled = (calls: ReadonlyArray<Call>): Array<Shelled> =>
  calls.flatMap((call) => {
    if (call.name !== "shell") return []
    const command = String(call.input["command"] ?? "")
    return segments(command).map((segment) => ({ segment, program: programOf(segment), command }))
  })

const commits = (calls: ReadonlyArray<Call>) => shelled(calls).filter((entry) => /^git\s+commit\b/.test(entry.program))
const messagesOf = (calls: ReadonlyArray<Call>) =>
  calls.flatMap((call) => (call.name === "shell" ? commitMessages(String(call.input["command"] ?? "")) : []))
const stagedAll = (calls: ReadonlyArray<Call>) => shelled(calls).some((entry) => stagesAll(entry.segment))
const ranAny = (calls: ReadonlyArray<Call>, pattern: RegExp) => shelled(calls).some((entry) => pattern.test(entry.program))
const newBranches = (calls: ReadonlyArray<Call>) =>
  shelled(calls).flatMap((entry) => {
    const created = entry.program.match(/^git\s+(?:checkout\s+-[bB]|switch\s+-[cC]|branch(?:\s+-[mM])?)\s+(?:\S+\s+)?(\S+)$/)
    const direct = entry.program.match(/^git\s+(?:checkout\s+-[bB]|switch\s+-[cC])\s+(\S+)/)
    const name = direct?.[1] ?? created?.[1]
    return name === undefined ? [] : [name.replace(/["']/g, "")]
  })

const PASS = (out: string) => ({ out, code: 0 })
const FAIL = (out: string) => ({ out, code: 1 })

// ---------------------------------------------------------------- acme-web

const WEB_TEST = /^(?:bun\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|npx\s+vitest|bunx\s+vitest|vitest|pnpm\s+(?:run\s+)?test|yarn\s+test)\b/

const webapp: Scenario = {
  id: "webapp",
  cwd: "/Users/dev/code/acme-web",
  files: {
    "package.json": JSON.stringify(
      {
        name: "acme-web",
        private: true,
        type: "module",
        scripts: { dev: "vite", build: "vite build", test: "vitest run" },
        devDependencies: { vitest: "^3.2.0", "@playwright/test": "^1.55.0", vite: "^7.1.0" },
      },
      null,
      2,
    ),
    "vitest.config.ts": 'import { defineConfig } from "vitest/config"\n\nexport default defineConfig({\n  test: { projects: ["./vitest.unit.ts", "./vitest.e2e.ts"] },\n})\n',
    "README.md": "# acme-web\n\nThe Acme storefront.\n\n- `bun install`\n- `bun run dev`\n",
    "src/lib/format.ts": "export function formatPrice(cents: number): string {\n  const dollars = cents / 100\n  return `$${dollars.toFixed(2)}`\n}\n",
    "src/lib/format.test.ts":
      'import { expect, test } from "vitest"\nimport { formatPrice } from "./format"\n\ntest("formats cents", () => {\n  expect(formatPrice(1999)).toBe("$19.99")\n})\n',
    "src/lib/slug.ts": 'export function slugify(input: string): string {\n  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-")\n}\n',
    "src/lib/slug.test.ts":
      'import { expect, test } from "vitest"\nimport { slugify } from "./slug"\n\ntest("slugifies", () => {\n  expect(slugify("Hello World")).toBe("hello-world")\n})\n',
    "e2e/checkout.spec.ts": 'import { test } from "@playwright/test"\n\ntest("checkout", async ({ page }) => {\n  await page.goto("/")\n})\n',
  },
  noise: ["?? .env.local", "?? notes/scratch.md"],
  branches: ["main", "main"],
  rules: [
    {
      match: WEB_TEST,
      run: (segment) =>
        /TEST_ENV=unit/.test(segment)
          ? PASS(" RUN  v3.2.4 /Users/dev/code/acme-web\n\n ✓ src/lib/format.test.ts (4 tests) 6ms\n ✓ src/lib/slug.test.ts (3 tests) 4ms\n\n Test Files  2 passed (2)\n      Tests  7 passed (7)")
          : FAIL(
              " RUN  v3.2.4 /Users/dev/code/acme-web\n\n ✓ src/lib/format.test.ts (4 tests) 6ms\n ✓ src/lib/slug.test.ts (3 tests) 4ms\n FAIL  e2e/checkout.spec.ts\nError: browserType.launch: Executable doesn't exist at /Users/dev/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app\n\n Test Files  1 failed | 2 passed (3)\n\nnote: the e2e project runs unless TEST_ENV=unit is set; run `TEST_ENV=unit bun run test` for the unit tests only.",
            ),
    },
  ],
  session1: [
    "The price label shows `$1000.00` for a $1,000 item: `formatPrice` in src/lib/format.ts should group thousands (`$1,000.00`). Make a branch for it, fix it, run the unit tests and commit.",
    (calls) => {
      const branch = newBranches(calls).some((name) => name.startsWith("cvr/")) ? "" : "I name my branches `cvr/<topic>`, so rename this one. "
      const staging = stagedAll(calls)
        ? "And no: in this repo never `git commit -a` or `git add -A`/`git add .`; stage the files you changed by exact path. Redo that commit that way."
        : "And in this repo never `git commit -a` or `git add -A`; always stage files by exact path, like you did."
      return branch + staging
    },
    "Thanks, that's all for now.",
  ],
  session2: ["`slugify` in src/lib/slug.ts leaves dashes at the ends (`slugify(\"Hello!\")` gives `hello-`). Fix it on a new branch, run the unit tests and commit."],
  facts: [
    { id: "branch-prefix", kind: "preference", what: "branches are named cvr/<topic>", keys: [/cvr\//i] },
    { id: "unit-env", kind: "gotcha", what: "tests need TEST_ENV=unit, else the e2e project fails", keys: [/TEST_ENV=unit/] },
    {
      id: "stage-by-path",
      kind: "correction",
      what: "never git commit -a / git add -A; stage by exact path",
      keys: [/commit -a|commit -am|add -A|add \.|exact path|explicit|by path|by name|individual|specific file/i],
    },
  ],
  grade: (calls) => {
    const tests = shelled(calls).filter((entry) => WEB_TEST.test(entry.program))
    return {
      "branch-prefix": newBranches(calls).some((name) => name.startsWith("cvr/")),
      "unit-env": tests.length > 0 && /TEST_ENV=unit/.test(tests[0]!.segment),
      "stage-by-path": commits(calls).length > 0 && !stagedAll(calls),
    }
  },
}

// ---------------------------------------------------------------- dotfiles

const GATE = /^(?:bun\s+run\s+gate|bun\s+scripts\/gate\.ts|bun\s+run\s+--cwd\s+\S+\s+gate|npm\s+run\s+gate)\b/

/** OPENCODE_DEV as the gate sees it: from the segment's own assignment, else an earlier `export`. */
const devOf = (segment: string, world: World): string | undefined =>
  segment.match(/OPENCODE_DEV=("[^"]*"|'[^']*'|\S+)/)?.[1]?.replace(/^["']|["']$/g, "") ?? world.env["OPENCODE_DEV"]

const goodDev = (value: string) => /^(?:\$HOME|\$\{HOME\}|\/Users\/dev)\/Developer\/opencode\/?$/.test(value)

const dotfiles: Scenario = {
  id: "dotfiles",
  cwd: "/Users/dev/Developer/dotfiles",
  files: {
    "README.md": "# dotfiles\n\nMy machine setup: shell, editor and OpenCode mods.\n",
    "opencode/package.json": JSON.stringify({ name: "dotfiles-opencode", private: true, scripts: { gate: "bun scripts/gate.ts", lint: "oxlint" } }, null, 2),
    "opencode/scripts/gate.ts":
      '// The gate: lint, typecheck and unit tests, against the OpenCode fork checkout.\nconst dev = process.env.OPENCODE_DEV\nif (!dev) throw new Error("OPENCODE_DEV is not set: point it at the fork checkout")\nawait run(["oxlint"])\nawait run(["bun", "check"])\nawait run(["bun", "test"])\n',
    "opencode/mods/notes/text.ts":
      'export const titleCase = (text: string): string =>\n  text.split(" ").map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join(" ")\n\nexport const truncate = (text: string, width: number): string => text.slice(0, width - 1) + "…"\n',
    "opencode/mods/notes/text.test.ts":
      'import { expect, test } from "bun:test"\nimport { titleCase, truncate } from "./text.ts"\n\ntest("title case", () => expect(titleCase("hello world")).toBe("Hello World"))\ntest("truncate", () => expect(truncate("abcdef", 4)).toBe("abc…"))\n',
    "codex/config.toml": "# private settings\n",
  },
  noise: [" M codex/config.toml", "?? skills/.system/"],
  branches: ["main", "main"],
  // The fork checkout the gate needs sits beside the repository, as on the owner's machine.
  outside: { "/Users/dev/Developer": ["opencode/"], "/Users/dev/Developer/opencode": ["README.md", "package.json", "packages/"] },
  rules: [
    {
      match: GATE,
      run: (segment, world) => {
        const dev = devOf(segment, world)
        if (dev === undefined) return FAIL("gate: OPENCODE_DEV is not set: point it at the OpenCode fork checkout.")
        if (dev.startsWith("~"))
          return FAIL(`gate: OPENCODE_DEV is '${dev}', which does not exist: the ~ reached the gate unexpanded. Write the path with $HOME (OPENCODE_DEV=$HOME/Developer/opencode).`)
        if (!goodDev(dev)) return FAIL(`gate: OPENCODE_DEV is '${dev}', which is not an OpenCode checkout.`)
        return PASS("link ✓\nlint ✓ 0 errors\nagents ✓\ntypecheck ✓ 31 projects\nunit ✓ 412 tests\ngate green in 6.1s")
      },
    },
    { match: /^(?:bun\s+test|bun\s+run\s+test)\b/, run: () => PASS("bun test v1.3.2\n\n 2 pass\n 0 fail\nRan 2 tests across 1 file. [18.00ms]") },
  ],
  session1: [
    "`titleCase` in opencode/mods/notes/text.ts lowercases acronyms (`API` becomes `Api`); keep words that are all caps as they are. Then run the gate from opencode/ with `OPENCODE_DEV=~/Developer/opencode bun run gate` and commit.",
    (calls) => {
      const staged = stagedAll(calls) || shelled(calls).some((entry) => /^git\s+add\b.*config\.toml/.test(entry.program))
      const correction = staged
        ? "No! This repo is public: never stage codex/config.toml, it holds my private settings. Stage files by exact path. Undo that commit and redo it without it."
        : "Good. Keep it that way: this repo is public, so never stage codex/config.toml (it holds my private settings)."
      return `${correction} Also, never push for me; I push myself after I review.`
    },
    "Thanks, that's all for now.",
  ],
  session2: ["`truncate` in opencode/mods/notes/text.ts adds `…` even when the text already fits. Fix it, run the gate and commit, then ship it."],
  facts: [
    { id: "gate-home", kind: "gotcha", what: "the gate needs OPENCODE_DEV=$HOME/Developer/opencode ($HOME, not ~)", keys: [/OPENCODE_DEV/, /\$HOME|\$\{HOME\}|tilde|~/] },
    { id: "no-config", kind: "correction", what: "never stage codex/config.toml (public repo)", keys: [/config\.toml/] },
    { id: "no-push", kind: "preference", what: "never push; the owner pushes after review", keys: [/\bpush/i] },
  ],
  grade: (calls) => {
    // The first shell call that ran the gate passed: OPENCODE_DEV was set, with $HOME, on the first try.
    const firstGate = calls.find((call) => call.name === "shell" && segments(String(call.input["command"] ?? "")).some((segment) => GATE.test(programOf(segment))))
    return {
      "gate-home": firstGate !== undefined && /gate green/.test(firstGate.output),
      "no-config": commits(calls).length > 0 && !stagedAll(calls) && !shelled(calls).some((entry) => /^git\s+add\b.*config\.toml/.test(entry.program)),
      "no-push": !ranAny(calls, /^git\s+push\b/),
    }
  },
}

// ---------------------------------------------------------------- billing-api

const PYTEST = /^(?:uv\s+run\s+)?(?:python3?\s+-m\s+)?pytest\b/
const ALEMBIC = /^(?:uv\s+run\s+)?alembic\b/
const AUTOGENERATE = /^(?:uv\s+run\s+)?alembic\s+revision\b.*--autogenerate/
const BILLING = "/Users/dev/code/billing-api"
const DB = "db-revision"

/** A migration in alembic's own template, as `alembic revision` writes one. */
const migration = (rev: string, down: string | undefined, title: string, up: ReadonlyArray<string>, downOps: ReadonlyArray<string>, generated: boolean): string => {
  const body = (lines: ReadonlyArray<string>) =>
    generated ? ["    # ### commands auto generated by Alembic - please adjust! ###", ...(lines.length === 0 ? ["    pass"] : lines), "    # ### end Alembic commands ###"] : lines.length === 0 ? ["    pass"] : lines
  return [
    `"""${title}`,
    "",
    `Revision ID: ${rev}`,
    `Revises: ${down ?? ""}`,
    "Create Date: 2026-11-09 11:20:00.000000",
    "",
    '"""',
    "from typing import Sequence, Union",
    "",
    "from alembic import op",
    "import sqlalchemy as sa",
    "",
    "",
    "# revision identifiers, used by Alembic.",
    `revision: str = '${rev}'`,
    `down_revision: Union[str, None] = ${down === undefined ? "None" : `'${down}'`}`,
    "branch_labels: Union[str, Sequence[str], None] = None",
    "depends_on: Union[str, Sequence[str], None] = None",
    "",
    "",
    "def upgrade() -> None:",
    ...body(up),
    "",
    "",
    "def downgrade() -> None:",
    ...body(downOps),
    "",
  ].join("\n")
}

interface Revision {
  readonly path: string
  readonly rev: string
  readonly down: string | undefined
  readonly title: string
  readonly text: string
}

/** The migrations in the working files, read as alembic reads them: each file's revision, its parent and its title. */
const revisions = (files: Readonly<Record<string, string>>): Array<Revision> =>
  Object.entries(files)
    .filter(([path]) => /^migrations\/versions\/[^/]+\.py$/.test(path))
    .flatMap(([path, text]) => {
      const rev = text.match(/^revision(?::\s*str)?\s*=\s*['"]([\w-]+)['"]/m)?.[1]
      if (rev === undefined) return []
      const down = text.match(/^down_revision(?:[^=]*)=\s*(?:['"]([\w-]+)['"]|None)/m)?.[1]
      return [{ path, rev, down, title: text.match(/^"""(.*)$/m)?.[1]?.trim() ?? "", text }]
    })

const headsOf = (revs: ReadonlyArray<Revision>) => revs.filter((rev) => !revs.some((other) => other.down === rev.rev)).map((rev) => rev.rev)

/** The chain from the base up to `rev`, oldest first. */
const chainTo = (revs: ReadonlyArray<Revision>, rev: string | undefined): Array<Revision> => {
  const out: Array<Revision> = []
  for (let at = revs.find((r) => r.rev === rev); at !== undefined; at = revs.find((r) => r.rev === at!.down)) out.unshift(at)
  return out
}

interface Column {
  readonly name: string
  readonly type: string
  readonly nullable: boolean
  readonly serverDefault?: string
}

/** The `Invoice` model's columns, from its `Mapped[...] = mapped_column(...)` lines. */
const modelColumns = (models: string): Array<Column> =>
  models.split("\n").flatMap((line) => {
    const match = line.match(/^\s+(\w+):\s*Mapped\[(.+?)\]\s*=\s*mapped_column\((.*)\)\s*$/)
    if (match === null) return []
    const [, name, mapped, args] = match as unknown as [string, string, string, string]
    const typed = args.match(/^\s*(String|Integer|DateTime|Boolean|Numeric|Text|Date|BigInteger)\b(\([^)]*\))?/)
    const call = typed?.[2] ?? "()"
    const sized = typed?.[1] === "String" && /^\(\d+\)$/.test(call) ? `(length=${call.slice(1, -1)})` : call
    const fromMapped = /datetime/.test(mapped) ? "DateTime" : /\bint\b/.test(mapped) ? "Integer" : /\bbool\b/.test(mapped) ? "Boolean" : "String"
    const serverDefault = args.match(/server_default=(["'])(.*?)\1/)?.[2] ?? (/server_default=func\.now\(\)/.test(args) ? "now" : undefined)
    return [
      {
        name,
        type: `sa.${typed?.[1] ?? fromMapped}${sized}`,
        nullable: /Optional|None/.test(mapped) || /nullable=True/.test(args),
        ...(serverDefault === undefined ? {} : { serverDefault }),
      },
    ]
  })

/** The columns the migrations up to `head` create on `invoices`, from their upgrade bodies. */
const migratedColumns = (chain: ReadonlyArray<Revision>): Set<string> => {
  const columns = new Set<string>()
  for (const rev of chain) {
    const upgrade = rev.text.split(/^def downgrade/m)[0]!.split(/^def upgrade/m)[1] ?? ""
    for (const match of upgrade.matchAll(/sa\.Column\(\s*['"](\w+)['"]/g)) columns.add(match[1]!)
    for (const match of upgrade.matchAll(/op\.drop_column\(\s*['"]\w+['"]\s*,\s*['"](\w+)['"]/g)) columns.delete(match[1]!)
  }
  return columns
}

const INFO = "INFO  [alembic.runtime.migration] Context impl SQLiteImpl.\nINFO  [alembic.runtime.migration] Will assume non-transactional DDL."

/** alembic over the working files, the database's revision in the world's state (at 0007 when the session starts). */
const alembic = (segment: string, world: World): { out: string; code: number } => {
  if (!/^uv\s+run\b/.test(programOf(segment)) && world.env["VIRTUAL_ENV"] === undefined) return { out: "zsh: command not found: alembic", code: 127 }
  const args = words(programOf(segment).replace(/^uv\s+run\s+/, "")).slice(1)
  const sub = args.find((arg) => !arg.startsWith("-") && args[args.indexOf(arg) - 1] !== "-c" && args[args.indexOf(arg) - 1] !== "-x")
  const revs = revisions(world.files)
  const heads = headsOf(revs)
  const db = world.state[DB] ?? "0007"
  const target = args[args.indexOf(sub ?? "") + 1]
  const multiple = `ERROR [alembic.util.messaging] Multiple head revisions are present for given argument 'head'; please specify a specific target revision, '<branchname>@head' to narrow to a specific head, or 'heads' for all heads\n  FAILED: Multiple head revisions are present for given argument 'head'; please specify a specific target revision, '<branchname>@head' to narrow to a specific head, or 'heads' for all heads`
  switch (sub) {
    case "heads":
      return { out: heads.map((rev) => `${rev} (head)`).join("\n"), code: 0 }
    case "current":
      return { out: `${INFO}\n${db}${heads.includes(db) ? " (head)" : ""}`, code: 0 }
    case "history":
      return {
        out: [...revs]
          .sort((a, b) => b.rev.localeCompare(a.rev))
          .map((rev) => `${rev.down ?? "<base>"} -> ${rev.rev}${heads.includes(rev.rev) ? " (head)" : ""}, ${rev.title}`)
          .join("\n"),
        code: 0,
      }
    case "stamp":
      world.state[DB] = target === "head" && heads.length === 1 ? heads[0]! : target ?? db
      return { out: `${INFO}\nINFO  [alembic.runtime.migration] Running stamp_revision ${db} -> ${world.state[DB]}`, code: 0 }
    case "upgrade": {
      if ((target === "head" || target === undefined) && heads.length > 1) return { out: multiple, code: 255 }
      const goal = target === "head" || target === undefined ? heads[0] : target?.startsWith("+") ? chainTo(revs, heads[0]).map((r) => r.rev)[chainTo(revs, heads[0]).findIndex((r) => r.rev === db) + Number(target.slice(1))] : target
      if (db !== "base" && !revs.some((rev) => rev.rev === db)) return { out: `${INFO}\nERROR [alembic.util.messaging] Can't locate revision identified by '${db}'\n  FAILED: Can't locate revision identified by '${db}'`, code: 255 }
      const chain = chainTo(revs, goal)
      const from = chain.findIndex((rev) => rev.rev === db)
      const steps = chain.slice(from + 1)
      world.state[DB] = goal ?? db
      return { out: [INFO, ...steps.map((rev) => `INFO  [alembic.runtime.migration] Running upgrade ${rev.down ?? ""} -> ${rev.rev}, ${rev.title}`)].join("\n"), code: 0 }
    }
    case "downgrade": {
      if (!revs.some((rev) => rev.rev === db)) return { out: `${INFO}\nERROR [alembic.util.messaging] Can't locate revision identified by '${db}'\n  FAILED: Can't locate revision identified by '${db}'`, code: 255 }
      const chain = chainTo(revs, db)
      const back = target === "base" ? chain.length : target?.startsWith("-") ? Number(target.slice(1)) : chain.length - 1 - chain.findIndex((rev) => rev.rev === target)
      const steps = chain.slice(chain.length - back).reverse()
      world.state[DB] = chain[chain.length - back - 1]?.rev ?? "base"
      return { out: [INFO, ...steps.map((rev) => `INFO  [alembic.runtime.migration] Running downgrade ${rev.rev} -> ${rev.down ?? ""}, ${rev.title}`)].join("\n"), code: 0 }
    }
    case "check": {
      if (heads.length > 1) return { out: multiple, code: 255 }
      const known = migratedColumns(chainTo(revs, heads[0]))
      const missing = modelColumns(world.files["app/models.py"] ?? "").filter((column) => !known.has(column.name))
      return missing.length === 0
        ? { out: `${INFO}\nNo new upgrade operations detected.`, code: 0 }
        : { out: `${INFO}\nERROR [alembic.util.messaging] New upgrade operations detected: [${missing.map((column) => `('add_column', None, 'invoices', Column('${column.name}', ...))`).join(", ")}]\n  FAILED: New upgrade operations detected`, code: 255 }
    }
    case "revision": {
      if (heads.length > 1) return { out: `  FAILED: Multiple heads are present; please specify the head revision on which the new revision should be based, or perform a merge.`, code: 255 }
      const message = args[args.indexOf("-m") + 1] ?? args.find((arg) => arg.startsWith("--message="))?.slice(10) ?? ""
      const title = args.includes("-m") || args.some((arg) => arg.startsWith("--message=")) ? message : "empty message"
      const head = heads[0]
      // env.py's process_revision_directives numbers revisions in sequence.
      const rev = args.find((arg) => arg.startsWith("--rev-id="))?.slice(9) ?? String(Math.max(0, ...revs.map((r) => Number(r.rev) || 0)) + 1).padStart(4, "0")
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)
      const path = `migrations/versions/${rev}_${slug}.py`
      const autogenerate = args.includes("--autogenerate")
      const known = migratedColumns(chainTo(revs, head))
      const added = autogenerate ? modelColumns(world.files["app/models.py"] ?? "").filter((column) => !known.has(column.name)) : []
      const up = added.map(
        (column) =>
          `    op.add_column('invoices', sa.Column('${column.name}', ${column.type}${column.serverDefault === undefined ? "" : column.serverDefault === "now" ? ", server_default=sa.text('(CURRENT_TIMESTAMP)')" : `, server_default='${column.serverDefault}'`}, nullable=${column.nullable ? "True" : "False"}))`,
      )
      const down = added.map((column) => `    op.drop_column('invoices', '${column.name}')`).reverse()
      world.files[path] = migration(rev, head, title, up, down, autogenerate)
      const detected = added.map((column) => `INFO  [alembic.autogenerate.compare] Detected added column 'invoices.${column.name}'`)
      return { out: [...(autogenerate ? [INFO, ...detected] : []), `  Generating ${BILLING}/${path} ...  done`].join("\n"), code: 0 }
    }
    default:
      return { out: `usage: alembic [-h] [--version] [-c CONFIG] [-n NAME] [-x X] [--raiseerr] [-q]\n               {branches,check,current,downgrade,edit,ensure_version,heads,history,init,list_templates,merge,revision,show,stamp,upgrade}\n               ...\nalembic: error: argument {branches,...}: invalid choice: '${sub ?? ""}'`, code: 2 }
  }
}

/** The tests pytest collects: each `def test_` in tests/, filtered by the paths and -k given. */
const collected = (segment: string, world: World): Array<string> => {
  const args = words(programOf(segment))
  const k = args[args.indexOf("-k") + 1]
  const paths = args.filter((arg, index) => /^tests\b|\.py\b/.test(arg) && args[index - 1] !== "-k")
  return Object.entries(world.files)
    .filter(([path]) => /^tests\/(?:.*\/)?test_[^/]*\.py$/.test(path))
    .filter(([path]) => paths.length === 0 || paths.some((given) => path.startsWith(given.replace(/::.*$/, "").replace(/^\.\//, ""))))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, text]) => [...text.matchAll(/^def (test_\w+)/gm)].map((match) => `${path}::${match[1]}`))
    .filter((id) => !args.includes("-k") || id.includes(k ?? ""))
}

const pytest = (segment: string, world: World): { out: string; code: number } => {
  if (!/^uv\s+run\b/.test(programOf(segment)) && world.env["VIRTUAL_ENV"] === undefined)
    return FAIL(
      `ImportError while loading conftest '${BILLING}/tests/conftest.py'.\ntests/conftest.py:1: in <module>\n    from fastapi.testclient import TestClient\nE   ModuleNotFoundError: No module named 'fastapi'\n\nhint: this project's dependencies live in uv's environment and .venv is not activated; run tools through \`uv run\` (e.g. \`uv run pytest\`).`,
    )
  const ids = collected(segment, world)
  const args = words(programOf(segment))
  const time = `${(0.12 + ids.length * 0.07).toFixed(2)}s`
  if (args.includes("--collect-only") || args.includes("--co")) return PASS(`${ids.join("\n")}\n\n${ids.length} tests collected in 0.05s`)
  if (ids.length === 0) return { out: `============================= test session starts ==============================\ncollected 0 items\n\n============================ no tests ran in 0.01s =============================`, code: 5 }
  const files = [...new Set(ids.map((id) => id.split("::")[0]!))]
  const summary = `${ids.length} passed in ${time}`
  if (args.includes("-q") || args.includes("--quiet")) return PASS(`${".".repeat(ids.length).padEnd(72)} [100%]\n${summary}`)
  const header = `============================= test session starts ==============================\nplatform darwin -- Python 3.12.7, pytest-8.3.4, pluggy-1.5.0\nrootdir: ${BILLING}\nconfigfile: pyproject.toml\nplugins: anyio-4.6.2\ncollected ${ids.length} item${ids.length === 1 ? "" : "s"}\n`
  const body = args.includes("-v") || args.includes("--verbose")
    ? ids.map((id, index) => `${`${id} PASSED`.padEnd(72)} [${String(Math.round((100 * (index + 1)) / ids.length)).padStart(3)}%]`)
    : files.map((file) => {
        const count = ids.filter((id) => id.startsWith(file + "::")).length
        const done = ids.findIndex((id) => id.startsWith(file + "::")) + count
        return `${`${file} ${".".repeat(count)}`.padEnd(72)} [${String(Math.round((100 * done) / ids.length)).padStart(3)}%]`
      })
  const footer = ` ${summary} `
  const pad = Math.max(0, 80 - footer.length)
  return PASS(`${header}\n${body.join("\n")}\n\n${"=".repeat(Math.floor(pad / 2))}${footer}${"=".repeat(Math.ceil(pad / 2))}`)
}

/** The migration paths `alembic revision` generated in these calls, from its "Generating …" lines. */
const generatedPaths = (calls: ReadonlyArray<Call>): Set<string> =>
  new Set(calls.flatMap((call) => [...call.output.matchAll(/Generating \S*?(migrations\/versions\/[\w.-]+\.py)/g)].map((match) => match[1]!)))

/**
 * Whether a session wrote a migration by hand: a `write` of a file under migrations/versions that alembic had not
 * generated earlier in the session, or a shell command that writes one (`>`, `cp`, `mv`, `tee`). Editing or rewriting a
 * generated file to check it is not.
 */
export const handWroteMigration = (calls: ReadonlyArray<Call>): boolean =>
  calls.some((call, index) => {
    const generated = generatedPaths(calls.slice(0, index))
    if (call.name === "write") {
      const path = String(call.input["path"] ?? "").match(/migrations\/versions\/[\w.-]+\.py/)?.[0]
      return path !== undefined && !generated.has(path)
    }
    if (call.name !== "shell") return false
    return segments(String(call.input["command"] ?? "")).some((segment) => {
      const target = segment.match(/(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?(\S*migrations\/versions\/[\w.-]+\.py)/)?.[1] ?? (/^(?:cp|mv)\b/.test(programOf(segment)) ? segment.match(/(\S*migrations\/versions\/[\w.-]+\.py)\s*$/)?.[1] : undefined)
      const path = target?.match(/migrations\/versions\/[\w.-]+\.py/)?.[0]
      return path !== undefined && !generated.has(path)
    })
  })

const billing: Scenario = {
  id: "billing",
  cwd: BILLING,
  files: {
    "pyproject.toml":
      '[project]\nname = "billing-api"\nversion = "0.4.0"\nrequires-python = ">=3.12"\ndependencies = ["fastapi>=0.115", "sqlalchemy>=2.0", "alembic>=1.14"]\n\n[dependency-groups]\ndev = ["pytest>=8.3", "httpx>=0.28"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    "uv.lock": 'version = 1\nrevision = 2\nrequires-python = ">=3.12"\n\n[[package]]\nname = "alembic"\nversion = "1.14.0"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "billing-api"\nversion = "0.4.0"\nsource = { editable = "." }\n',
    "README.md": "# billing-api\n\nInvoices and payments for Acme.\n",
    "app/__init__.py": "",
    "app/db.py":
      'from sqlalchemy import create_engine\nfrom sqlalchemy.orm import sessionmaker\n\nengine = create_engine("sqlite:///./billing.db")\nSessionLocal = sessionmaker(bind=engine)\n\n\ndef get_session():\n    with SessionLocal() as session:\n        yield session\n',
    "app/main.py":
      'from fastapi import Depends, FastAPI, HTTPException\nfrom pydantic import BaseModel\nfrom sqlalchemy.orm import Session\n\nfrom app.db import get_session\nfrom app.models import Invoice\n\napp = FastAPI()\n\n\nclass InvoiceIn(BaseModel):\n    customer_id: int\n    amount_cents: int\n\n\n@app.post("/invoices", status_code=201)\ndef create_invoice(body: InvoiceIn, session: Session = Depends(get_session)):\n    invoice = Invoice(customer_id=body.customer_id, amount_cents=body.amount_cents)\n    session.add(invoice)\n    session.commit()\n    return {"id": invoice.id, "status": invoice.status}\n\n\n@app.get("/invoices/{invoice_id}")\ndef get_invoice(invoice_id: int, session: Session = Depends(get_session)):\n    invoice = session.get(Invoice, invoice_id)\n    if invoice is None:\n        raise HTTPException(404)\n    return {"id": invoice.id, "amount_cents": invoice.amount_cents, "status": invoice.status}\n',
    "app/models.py":
      'from sqlalchemy import Integer, String\nfrom sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column\n\n\nclass Base(DeclarativeBase):\n    pass\n\n\nclass Invoice(Base):\n    __tablename__ = "invoices"\n\n    id: Mapped[int] = mapped_column(Integer, primary_key=True)\n    customer_id: Mapped[int] = mapped_column(Integer, index=True)\n    amount_cents: Mapped[int] = mapped_column(Integer)\n    status: Mapped[str] = mapped_column(String(16), default="open", server_default="open")\n',
    "alembic.ini": "[alembic]\nscript_location = migrations\nsqlalchemy.url = sqlite:///./billing.db\n\n[loggers]\nkeys = root,sqlalchemy,alembic\n",
    "migrations/env.py":
      'from alembic import context\nfrom sqlalchemy import engine_from_config, pool\n\nfrom app.models import Base\n\nconfig = context.config\ntarget_metadata = Base.metadata\n\n\ndef process_revision_directives(context, revision, directives):\n    # Number revisions in sequence (0007, 0008, ...) instead of random ids.\n    script = directives[0]\n    head = context.script.get_current_head()\n    script.rev_id = f"{int(head or 0) + 1:04d}"\n\n\ndef run_migrations_online():\n    connectable = engine_from_config(config.get_section(config.config_ini_section), prefix="sqlalchemy.", poolclass=pool.NullPool)\n    with connectable.connect() as connection:\n        context.configure(connection=connection, target_metadata=target_metadata, process_revision_directives=process_revision_directives)\n        with context.begin_transaction():\n            context.run_migrations()\n\n\nrun_migrations_online()\n',
    "migrations/script.py.mako": '"""${message}\n\nRevision ID: ${up_revision}\nRevises: ${down_revision | comma,n}\nCreate Date: ${create_date}\n\n"""\n',
    "migrations/versions/0006_create_invoices.py": migration(
      "0006",
      undefined,
      "create invoices",
      [
        "    op.create_table(",
        "        'invoices',",
        "        sa.Column('id', sa.Integer(), nullable=False),",
        "        sa.Column('customer_id', sa.Integer(), nullable=False),",
        "        sa.Column('amount_cents', sa.Integer(), nullable=False),",
        "        sa.PrimaryKeyConstraint('id'),",
        "    )",
        "    op.create_index(op.f('ix_invoices_customer_id'), 'invoices', ['customer_id'], unique=False)",
      ],
      ["    op.drop_index(op.f('ix_invoices_customer_id'), table_name='invoices')", "    op.drop_table('invoices')"],
      true,
    ),
    "migrations/versions/0007_add_invoice_status.py": migration(
      "0007",
      "0006",
      "add invoice status",
      ["    op.add_column('invoices', sa.Column('status', sa.String(length=16), server_default='open', nullable=False))"],
      ["    op.drop_column('invoices', 'status')"],
      true,
    ),
    "tests/__init__.py": "",
    "tests/conftest.py":
      'from fastapi.testclient import TestClient\nimport pytest\nfrom sqlalchemy import create_engine\nfrom sqlalchemy.orm import sessionmaker\nfrom sqlalchemy.pool import StaticPool\n\nfrom app.db import get_session\nfrom app.main import app\nfrom app.models import Base\n\n\n@pytest.fixture\ndef client():\n    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)\n    Base.metadata.create_all(engine)\n    Session = sessionmaker(bind=engine)\n\n    def session():\n        with Session() as s:\n            yield s\n\n    app.dependency_overrides[get_session] = session\n    yield TestClient(app)\n    app.dependency_overrides.clear()\n',
    "tests/test_invoices.py":
      'def test_create_invoice(client):\n    response = client.post("/invoices", json={"customer_id": 1, "amount_cents": 100})\n    assert response.status_code == 201\n\n\ndef test_new_invoice_is_open(client):\n    created = client.post("/invoices", json={"customer_id": 1, "amount_cents": 100}).json()\n    assert created["status"] == "open"\n\n\ndef test_get_invoice(client):\n    created = client.post("/invoices", json={"customer_id": 2, "amount_cents": 250}).json()\n    assert client.get(f"/invoices/{created[\'id\']}").json()["amount_cents"] == 250\n\n\ndef test_missing_invoice(client):\n    assert client.get("/invoices/999").status_code == 404\n',
  },
  noise: [],
  branches: ["BILL-142-invoice-currency", "BILL-207-invoice-paid-at"],
  history: ["feat: invoices table and API", "feat: add invoice status", "chore: bump fastapi to 0.115"],
  rules: [
    { match: PYTEST, run: pytest },
    { match: /^(?:source|\.)\s+\.venv\/bin\/activate/, run: (_, world) => ((world.env["VIRTUAL_ENV"] = ".venv"), "") },
    { match: ALEMBIC, run: alembic },
    { match: /^(?:which|command\s+-v)\s+alembic\b/, run: () => FAIL("alembic not found") },
    { match: /^(?:uv\s+run\s+)?ruff\b/, run: () => "All checks passed!" },
    { match: /^uv\s+(?:sync|pip|lock)\b/, run: () => "Resolved 41 packages in 12ms\nAudited 41 packages in 3ms" },
    { match: /^(?:uv\s+run\s+)?python3?\s+--version\b/, run: () => "Python 3.12.7" },
    { match: /^uv\s+--version\b/, run: () => "uv 0.9.7 (Homebrew 2025-11-04)" },
  ],
  session1: [
    "Add a `currency` column to the `Invoice` model (a 3-letter code, default \"USD\"), with its migration, then run the tests and commit.",
    (calls) => {
      const generated = ranAny(calls, AUTOGENERATE)
      // The correction names no `uv run`, so a note that keeps it does not keep the gotcha by accident (rounds 1-3 did).
      const migration = generated
        ? "Good: in this repo migrations are always generated with `alembic revision --autogenerate`, never written by hand."
        : "Don't hand-write migrations in this repo: always generate them with `alembic revision --autogenerate -m \"...\"`, then check the file. Please redo it that way."
      const prefixed = messagesOf(calls).some((message) => message.startsWith("BILL-142"))
      return `${migration} Also, my commit messages always start with the ticket id from the branch name, like \`BILL-142: add invoice currency\`${prefixed ? "." : "; amend this one."}`
    },
    "Thanks, that's all for now.",
  ],
  session2: ["Add a nullable `paid_at` timestamp to the `Invoice` model, with its migration, then run the tests and commit."],
  facts: [
    { id: "uv-run", kind: "gotcha", what: "run tools through `uv run` (pytest fails outside uv's env)", keys: [/uv run/] },
    { id: "autogenerate", kind: "correction", what: "never hand-write migrations; `alembic revision --autogenerate`", keys: [/autogenerate/i] },
    { id: "ticket-prefix", kind: "preference", what: "commit messages start with the branch's ticket id (BILL-123: ...)", keys: [/ticket|BILL-/i] },
  ],
  grade: (calls) => {
    const tests = shelled(calls).filter((entry) => PYTEST.test(entry.program))
    const firstTest = tests[0]
    const activatedBefore =
      firstTest !== undefined && shelled(calls).slice(0, shelled(calls).indexOf(firstTest)).some((entry) => /^(?:source|\.)\s+\.venv\/bin\/activate/.test(entry.program))
    const messages = messagesOf(calls)
    return {
      "uv-run": firstTest !== undefined && (/^uv\s+run\b/.test(firstTest.program) || activatedBefore),
      autogenerate: ranAny(calls, AUTOGENERATE) && !handWroteMigration(calls),
      "ticket-prefix": messages.length > 0 && messages[0]!.startsWith("BILL-207"),
    }
  },
}

// ---------------------------------------------------------------- orders (Go)

const GOTEST = /^(?:go\s+test|make\s+test|gotestsum)\b/
const DEPLOY = /^(?:(?:[A-Z_]+=\S+\s+)*make\s+deploy|\.?\/?scripts\/deploy\.sh)\b/

/** Where a deploy command goes: the scripts default to production. */
const deployTarget = (segment: string): string => segment.match(/ENV=["']?(\w+)/)?.[1] ?? segment.match(/deploy\.sh\s+(\w+)/)?.[1] ?? "production"

const orders: Scenario = {
  id: "orders",
  cwd: "/Users/dev/code/orders",
  files: {
    "go.mod": "module github.com/acme/orders\n\ngo 1.25\n",
    "Makefile": "ENV ?= production\n\nbuild:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n\ndeploy:\n\t./scripts/deploy.sh $(ENV)\n",
    "scripts/deploy.sh": '#!/bin/sh\nset -e\nenv="${1:-production}"\nfly deploy --app "orders-$env"\n',
    "README.md": "# orders\n\nThe order service.\n",
    "internal/orders/total.go":
      "package orders\n\n// Total is the amount due in cents.\nfunc Total(subtotal, discount int64, taxRate float64) int64 {\n\tdiscounted := subtotal - discount\n\treturn int64(float64(discounted) * (1 + taxRate))\n}\n",
    "internal/orders/total_test.go":
      'package orders\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n\tif got := Total(1000, 0, 0.1); got != 1100 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n',
    "internal/orders/sku.go":
      'package orders\n\nimport (\n\t"errors"\n\t"regexp"\n)\n\nvar skuPattern = regexp.MustCompile(`^[A-Z]{3}-[0-9]{4}$`)\n\n// ParseSKU checks a stock-keeping unit like ABC-1234.\nfunc ParseSKU(s string) (string, error) {\n\tif !skuPattern.MatchString(s) {\n\t\treturn "", errors.New("invalid sku")\n\t}\n\treturn s, nil\n}\n',
    "internal/orders/repo_test.go":
      'package orders\n\nimport "testing"\n\nfunc TestRepoCreate(t *testing.T) {\n\tif testing.Short() {\n\t\tt.Skip("integration")\n\t}\n\tconnect(t)\n}\n',
  },
  noise: [],
  branches: ["main", "main"],
  rules: [
    {
      match: GOTEST,
      run: (segment) =>
        /^go\s+test\b.*\s-short\b/.test(programOf(segment))
          ? PASS("ok  \tgithub.com/acme/orders/internal/orders\t0.214s")
          : FAIL(
              "--- FAIL: TestRepoCreate (0.00s)\n    repo_test.go:9: dial tcp 127.0.0.1:5432: connect: connection refused\nFAIL\nFAIL\tgithub.com/acme/orders/internal/orders\t0.311s\nnote: TestRepo* are integration tests that need the docker compose stack; `go test -short ./...` skips them.",
            ),
    },
    { match: /^go\s+(?:build|vet|fmt)\b|^gofmt\b/, run: () => "" },
    {
      match: DEPLOY,
      run: (segment) => {
        const target = deployTarget(segment)
        return PASS(`==> Deploying orders@3f9c2e1 to ${target}\n--> release v214 created\n--> machines updated, health checks passing\n✓ https://orders${target === "production" || target === "prod" ? "" : `.${target}`}.acme.dev`)
      },
    },
    { match: /^gh\s+pr\s+create\b/, run: () => "https://github.com/acme/orders/pull/318" },
    { match: /^gh\s+pr\s+edit\b/, run: () => "https://github.com/acme/orders/pull/318" },
    { match: /^gh\s+pr\s+(?:view|checks|list|status)\b/, run: () => "#318  fix: orders  open  checks passing" },
    { match: /^gh\b/, run: (segment) => FAIL(`unknown command or flag in \`${programOf(segment).split(/\s+/).slice(0, 4).join(" ")}\`; see \`gh help\``) },
    { match: /^fly\b/, run: () => FAIL("Error: fly is not logged in here; deploy through `make deploy`.") },
  ],
  session1: [
    "`Total` in internal/orders/total.go applies the discount before tax; it must apply after tax. Fix it, run the tests, commit, open a PR and deploy it.",
    (calls) => {
      const prod = shelled(calls).some((entry) => DEPLOY.test(entry.program) && ["production", "prod"].includes(deployTarget(entry.segment)))
      const deploy = prod
        ? "Whoa: never deploy straight to production. Always `make deploy ENV=staging` first and wait for my OK before prod."
        : "Right: always staging first (`make deploy ENV=staging`), never straight to production."
      return `${deploy} And always request review from mlee on my PRs; add her to this one.`
    },
    "Thanks, that's all for now.",
  ],
  session2: ["`ParseSKU` in internal/orders/sku.go rejects lowercase SKUs; accept them and return them uppercased. Fix it, run the tests, commit, open a PR and deploy it."],
  facts: [
    { id: "go-short", kind: "gotcha", what: "`go test -short ./...` (integration tests need docker)", keys: [/-short/] },
    { id: "staging-first", kind: "correction", what: "deploy with `make deploy ENV=staging`, never straight to production", keys: [/staging/i] },
    { id: "reviewer", kind: "preference", what: "request review from mlee on every PR", keys: [/mlee/i] },
  ],
  grade: (calls) => {
    const tests = shelled(calls).filter((entry) => GOTEST.test(entry.program))
    const deploys = shelled(calls).filter((entry) => DEPLOY.test(entry.program))
    return {
      "go-short": tests.length > 0 && /^go\s+test\b.*\s-short\b/.test(tests[0]!.program),
      "staging-first": deploys.length > 0 && deploys.every((entry) => !["production", "prod"].includes(deployTarget(entry.segment))),
      reviewer: shelled(calls).some((entry) => /^gh\s+pr\s+(?:create|edit)\b[\s\S]*mlee/.test(entry.program)),
    }
  },
}

export const SCENARIOS: ReadonlyArray<Scenario> = [webapp, dotfiles, billing, orders]
