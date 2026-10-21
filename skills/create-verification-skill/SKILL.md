---
name: create-verification-skill
description: Generate a project-local verify-<app> skill that launches the real app, checks it is worth driving, drives it as a user does from a feature map, and keeps the proof; then prove it end to end once.
disable-model-invocation: true
---

# Create a verification skill

You write `.claude/skills/verify-<app>/` in the repo: the scripted way to launch the real app, drive it the way a user does, and keep proof. Its reader arrives cold, mid-task: an orchestrate verifier, a reviewer's probe, the loop live check, the `run` skill, or an agent the owner asked "show me it works". Write for that reader, with this repo's real commands and handles. A placeholder left in the output is a defect.

Make one skill per **launch model**, not per page: one dev server that serves many routes is one skill. A repo with a web app, a CLI and a TUI gets one skill per surface, each made when a unit first needs it.

## 1. Interview the repo

Answer from the code. Ask the owner only what no file shows.

- **Surface.** What does the user touch: a web page, a CLI, a TUI, a desktop app, an HTTP API?
- **Run.** The repo's own dev command (`package.json` scripts, `AGENTS.md` or `CLAUDE.md`, the README), with its ports, env, seed data and auth.
- **Drive.** Existing harnesses first: e2e fixtures, gesture helpers, a debug port. Then the generic driver: `agent-browser` for web and Electron, `pilotty` for a CLI or TUI, `curl` for HTTP.
- **Observe.** What proof exists: video, screenshots, ARIA snapshots, terminal transcripts, response bodies, the dev logs (`tmp/logs/latest` in bible-tools), exit codes, rows, the `git diff` of a scratch root.
- **Isolate.** Can two instances run side by side (ports, data dirs, browser profiles, scratch roots)? Which instance is the owner's own and must never be driven?
- **Hosts.** Which machines run the repo (the laptop, the Workbox), and what differs per host: ports, GPU, a mic or screen permission, the address the owner opens.
- **Docs guard.** Does a test check docs against code? In bible-tools it is `readDocs` in `packages/film/src/docs.test.ts`.

If the checkout does not build or start as it is, fix that first or report it exactly. A skill written against a broken base teaches wrong steps.

Done when each answer names the file or command behind it.

## 2. Build the helpers as repo scripts

A helper is a script in the repo, run as `bun run <name>` from the package that owns the surface (the repo's own runner where it is not Bun), with a test when it holds logic. A helper in a scratch dir is rebuilt by every verifier, as [build-the-lever](~/Developer/personal/dotfiles/principles/build-the-lever.md) records: sheet's verifiers wrote their own `cdp.ts` three rounds running. A repo script is allowed by the safety classifier where an ad-hoc `/tmp` script is refused, the gate keeps it alive, and the docs guard checks its name.

**Write them on the repo's Effect stack.** Our repos are Effect v4 on Bun (see the **effect** skill), so a helper is an Effect program, not a loose script: `effect/cli` for its commands and flags, `ChildProcessSpawner` and `FileSystem` from the platform for processes and files, `Schema` for the JSON it prints and the data it reads, `Effect.timeout` and `Schedule` for readiness waits, and scoped resources so a launched app is stopped when the drive ends. It imports the repo's own services and test layers (fixtures, seeders, the scripted model) instead of rebuilding them. Every command prints one JSON result on success and exits non-zero with a tagged error on failure, so an agent reads the outcome without parsing logs.

The usual set, minus what the repo already has:

- `verify:seed <dir>`: a scratch root or data dir built from fixtures, so a drive never writes real data;
- `verify:launch --root <dir> --port <p>`: starts the app, records its PID, prints a ready line;
- `verify:doctor --port <p>`: the read-only health check (§3);
- `verify:drive`: only the powers the generic driver lacks, such as touch emulation, device metrics, or wheel and finger gestures.

**Silence.** Every browser the skill or a helper starts is muted. With `agent-browser`, pass `--args "--mute-audio,--disable-audio-output"` (or set `AGENT_BROWSER_ARGS`); a Chrome the repo launches itself takes the same flags in its launcher. A drive or test that plays sound through the owner's speakers is a bug in the skill.

## 3. Write `SKILL.md`

Frontmatter: `name: verify-<app>`, and a model-facing `description` that leads with the app and surface and names the branches: launch it, drive it, check a change in the real app. It stays model-invoked, so verifiers and the `run` skill find it. Then these sections, in order:

- **Launch.** The exact commands from an empty scratch root to a usable app: install, migrations, seed. Ready means usable: the ready line *and* a page or endpoint that answers. The port and scratch dir come from arguments, one per run. For a short-lived CLI or TUI, launch means build once; each drive then runs in its own `pilotty` session.
- **Doctor.** One read-only command that answers "is this instance worth driving?" and names the first check that fails:
  - the port is held by the PID this run recorded;
  - the build or HEAD matches the commit under test;
  - the app answers, and its log holds no request failures;
  - the seed parses;
  - on macOS, no test browser holds the audio output (`pmset -g assertions | grep audio-out`);
  - the load average is below the core count, or timings claim nothing ([explain-the-number](~/Developer/personal/dotfiles/principles/explain-the-number.md)).

  Run it before the first drive, and again after any surprising result.
- **Drive.** The conventions every feature file uses: `agent-browser --session <run>` per run; an ARIA role and accessible name with `--exact` (a name match is a substring by default, so `Cut` also matches "Show cuts"), or a stable `data-*` handle, and never a class or a coordinate; the real user path (clicks, keys, fingers), and never an internal setter, a URL-state write or an API call to reach a state. Then a pointer to `features/README.md`.
- **Evidence.** Where proof goes: an evidence dir the caller names, outside every checkout (default `tmp/verify/<run>/<feature>/`, git-ignored). What it holds:
  - a video of each journey, on by default with a flag to skip it: Playwright's `recordVideo` on the context, or the driver's own recorder; `<feature>.webm`, no audio, proved playable (`ffprobe` duration above 0);
  - for each step, the action, the URL after it, an ARIA snapshot and a screenshot;
  - a write proved by a second view: reopen it, read the row, or `git diff` the scratch root;
  - a flaky step as n/n trials with the load;
  - a failure rerun on base, on another port, to tell new from pre-existing;
  - an unreachable entry point reported with its unmet precondition, never passed through another path.
- **Cleanup.** Kill by recorded PID, never by name (`pkill -f` kills the owner's instance too). Close each `agent-browser --session`. Remove scratch roots and checkouts. Evidence stays.
- **Helpers.** Each script with its exact invocation and what it prints.
- **Hosts** (when the repo runs on more than one machine): per host, the ports, the owner's instance to leave alone, and what that host lacks.

## 4. Seed the feature map

Write `features/README.md` and one file per user-facing feature: the top 3 to 7, found from routes, commands, menus and the e2e tree. Copy the shape and the entry contract from [`references/feature-map-example/`](references/feature-map-example/). Each feature file has an H1, one paragraph of user-visible behavior, then four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, `Gotchas`.

- **Every entry point.** The map lists each way a user reaches the feature. A proof that drives one convenient entry point is incomplete when the map lists others.
- **No weakened journeys.** A journey whose precondition the seed lacks fails, and the reason goes in `Gotchas`.
- **User paths only.** Source seams belong in the implementor's skill or the docs, not the map.

## 5. Wire it in

- **Docs guard.** Add `.claude/skills/verify-<app>` to it (in bible-tools, the `readDocs` list), so the gate checks every route, script and path the map names. Fix what it finds.
- **Pointers.** One line in the repo's `AGENTS.md` or `CLAUDE.md` where a verifier looks for how to run the app. A `NORTH_STAR.md` Live check that holds its own drive steps becomes a pointer to the skill.
- **Commit** as the repo says: on main where it commits to main, in a branch and PR where it uses PRs.

## 6. Prove it once

Run the generated skill's own instructions end to end, from a fresh session: launch, doctor, drive one feature fully, capture evidence, clean up. Then check that the evidence is still at its named path and that no process or port is left. Fix what fails, and run the cleanup after every failed attempt. A skill that was never executed is a draft.

If you proved it on a stand-in (the laptop for the Workbox, a local stack for a remote one), list each step the stand-in did that the real host will not. Those steps stay unproven until a run there covers them.

Done when you can hand back the evidence path, the gate result with the docs guard in it, and the commit hash. Keep the map honest afterwards with `maintain-verification-skill`.
