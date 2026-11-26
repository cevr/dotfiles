// The managed Antigravity profile, as T3 Code makes one (at 55085df2), in one
// pure description. The profile writer (live.ts `prepareProfile`), the env
// file, the printed sign-in line, the reader's token paths (signin.ts) and the
// launch line for an agy pane all come from `managedProfile`, so none can
// disagree with another. T3's sources, all under apps/server/src/provider/:
// - antigravityAuthSupport.ts 441-443: the profile is GEMINI_HOME, its app
//   data `antigravity-acp/` beneath it;
// - 514-531: both directories made 0700 (T3 makes a third, its temp directory);
// - 146-155 and 532-538: `antigravity-acp/settings.json` is
//   `{"auth":{"type":"oauth-personal"}}` and a newline for a personal sign-in;
// - 256-260 and 263-330 (Drivers/AntigravitySkills.ts 27-35): the user's
//   ~/.gemini skills and rules linked into the profile, each only where its
//   target is;
// - 62-82 and 202-246: the environment: T3's removed keys unset, then
//   SSH_CONNECTION (the caller's, else T3's loopback value), GEMINI_HOME,
//   AGY_ACP_FORCE_FILE_STORAGE, AGY_CLI_DISABLE_AUTO_UPDATE, PYTHONUNBUFFERED
//   and ELECTRON_RUN_AS_NODE;
// - 554-563: agy runs as `agy acp --gemini-dir <profile> --app-data-dir
//   antigravity-acp`;
// - Drivers/AntigravityDriver.ts 443-447: the sign-in is that line with
//   `--login`, DISPLAY and WAYLAND_DISPLAY dropped so it prints its link.
// Left out, both local only: T3's BROWSER (its URL-capture helper, 238) and
// TMPDIR with its `antigravity-acp/tmp` (240-243, 443), and T3's Linux CA
// bundle (225-229). The managed profile is for a personal sign-in only, as
// T3's `--login` is (AntigravityDriver.ts 427).
import { Match, Schema } from "effect"

/** T3's app data directory beneath the profile (its line 443, and `--app-data-dir` at 559-561). */
export const APP_DATA_DIR = "antigravity-acp"

/** The variables T3 removes from an agy process's environment before it sets its own (its lines 62-82). */
export const REMOVED = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_DISABLE_AUTO_UPDATE",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
] as const

/** T3's SSH_CONNECTION when the caller has none, for a personal sign-in (its line 233). */
export const LOCAL_SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0"

/** A link T3 makes from the profile into the user's ~/.gemini: made only where `target` is. */
export interface UserLink {
  readonly link: string
  readonly target: string
  readonly kind: "directory" | "file"
}

/** The environment of an agy process on the profile. */
export interface ManagedEnvironment {
  /** Unset first. */
  readonly unset: ReadonlyArray<string>
  /** SSH_CONNECTION: the caller's when set and not empty, else this (T3's `baseEnv.SSH_CONNECTION || …`). */
  readonly sshConnectionDefault: string
  /** Then set, in T3's order. */
  readonly set: ReadonlyArray<readonly [string, string]>
}

/** Everything the managed profile is, derived from its directory and the user's home. */
export interface ManagedProfile {
  /** GEMINI_HOME and `--gemini-dir`. */
  readonly root: string
  /** `<root>/antigravity-acp`, the app data directory. */
  readonly appData: string
  /** Made 0700, in this order. */
  readonly directories: readonly [string, string]
  readonly settings: { readonly path: string; readonly text: string }
  readonly links: ReadonlyArray<UserLink>
  /** Where a sign-in on this profile lands, in the order T3 reads them (antigravityUsageLimits.ts 331-336). */
  readonly tokenFiles: { readonly acp: string; readonly cli: string }
  readonly environment: ManagedEnvironment
  /** `acp --gemini-dir <root> --app-data-dir antigravity-acp`. */
  readonly acpArgs: ReadonlyArray<string>
  /** The sign-in: `acpArgs` and `--login`. */
  readonly signInArgs: ReadonlyArray<string>
  /** The env file beside the profile (outside what agy writes). */
  readonly envFile: string
}

const ProfileSettings = Schema.fromJsonString(Schema.Struct({ auth: Schema.Struct({ type: Schema.Literal("oauth-personal") }) }))

/** T3's settings file text for a personal sign-in (its `antigravityProfileSettings`, lines 146-155). */
export const settingsText = () => `${Schema.encodeSync(ProfileSettings)({ auth: { type: "oauth-personal" } })}\n`

/** Where a sign-in on the profile at `root` lands, in the order T3 reads them: the refreshable `acp_token.json`, then the CLI's token. */
export const tokenFilesOf = (root: string) => ({ acp: `${root}/${APP_DATA_DIR}/acp_token.json`, cli: `${root}/${APP_DATA_DIR}/antigravity-oauth-token` })

/** The managed profile at `root` for the user whose home is `home`. */
export const managedProfile = (root: string, home: string): ManagedProfile => {
  const appData = `${root}/${APP_DATA_DIR}`
  const gemini = `${home}/.gemini`
  const acpArgs = ["acp", "--gemini-dir", root, "--app-data-dir", APP_DATA_DIR]
  return {
    root,
    appData,
    directories: [root, appData],
    settings: { path: `${appData}/settings.json`, text: settingsText() },
    links: [
      { link: `${root}/config/skills`, target: `${gemini}/config/skills`, kind: "directory" },
      { link: `${root}/antigravity-cli/skills`, target: `${gemini}/antigravity-cli/skills`, kind: "directory" },
      { link: `${root}/AGENTS.md`, target: `${gemini}/AGENTS.md`, kind: "file" },
      { link: `${root}/GEMINI.md`, target: `${gemini}/GEMINI.md`, kind: "file" },
      { link: `${root}/config/skills.json`, target: `${gemini}/config/skills.json`, kind: "file" },
    ],
    tokenFiles: tokenFilesOf(root),
    environment: {
      unset: REMOVED,
      sshConnectionDefault: LOCAL_SSH_CONNECTION,
      set: [
        ["GEMINI_HOME", root],
        ["AGY_ACP_FORCE_FILE_STORAGE", "1"],
        ["AGY_CLI_DISABLE_AUTO_UPDATE", "1"],
        ["PYTHONUNBUFFERED", "1"],
        ["ELECTRON_RUN_AS_NODE", "1"],
      ],
    },
    acpArgs,
    signInArgs: [...acpArgs, "--login"],
    envFile: `${root}.env`,
  }
}

/** A value quoted for sh. */
export const quoted = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

/**
 * The profile's environment as a file sh sources: `unset` lines, then
 * `export` lines. It holds no secret and no value of the caller's: the
 * SSH_CONNECTION line keeps the caller's own when it has one, at source time.
 */
export const envFileText = (profile: ManagedProfile) =>
  [
    "# The managed Antigravity profile's environment, as T3 Code sets it (written by bun cmd/pool/antigravity-read.ts --profile-env).",
    `unset ${profile.environment.unset.join(" ")}`,
    `export SSH_CONNECTION="\${SSH_CONNECTION:-${profile.environment.sshConnectionDefault}}"`,
    ...profile.environment.set.map(([name, value]) => `export ${name}=${quoted(value)}`),
    "",
  ].join("\n")

/** `args` as sh words. */
const words = (args: ReadonlyArray<string>) =>
  args.map((arg) => Match.value(/^[\w./=-]+$/.test(arg)).pipe(Match.when(true, () => arg), Match.orElse(() => quoted(arg)))).join(" ")

/** The one line that signs agy in on the profile: its environment, no display (so it prints its link), and T3's sign-in arguments. */
export const signInLine = (profile: ManagedProfile) => `. ${quoted(profile.envFile)} && env -u DISPLAY -u WAYLAND_DISPLAY agy ${words(profile.signInArgs)}`

/**
 * How an agy pane runs on the profile. The ACP server takes T3's flags; the
 * interactive TUI the orchestrator's panes run (`agy
 * --dangerously-skip-permissions [--conversation=<id>|--continue] -i <text>`)
 * lists neither `--gemini-dir` nor `--app-data-dir` in `agy --help` (agy as
 * installed on 2026-11-24), and its help names no environment variable, so
 * where a TUI pane's sign-in lands is not known: a pane cannot be pointed at
 * the profile, and the profile's token, which nothing refreshes, expires about
 * an hour after its sign-in.
 */
export const PaneLaunch = Schema.TaggedUnion({
  /** An ACP session on the profile: this line keeps its token file current, as T3's sessions do. */
  Acp: { line: Schema.String },
  /** The interactive TUI: not on the profile; its token path unknown, so reads from the profile go stale. */
  TokenPathUnknown: { why: Schema.String },
})
export type PaneLaunch = typeof PaneLaunch.Type

/** The launch for an agy pane on `profile`, `mode` being the ACP server or the interactive TUI. */
export const paneLaunch = (profile: ManagedProfile, mode: "acp" | "tui"): PaneLaunch =>
  Match.value(mode).pipe(
    Match.when("acp", () => PaneLaunch.cases.Acp.make({ line: `. ${quoted(profile.envFile)} && agy ${words(profile.acpArgs)}` })),
    Match.orElse(() =>
      PaneLaunch.cases.TokenPathUnknown.make({
        why: "pane mode: token path unknown: reads unavailable (agy's interactive TUI takes no --gemini-dir or --app-data-dir; start agy panes as ACP sessions on the profile, or sign in again within the hour before a read)",
      }),
    ),
  )
