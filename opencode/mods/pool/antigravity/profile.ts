// The managed Antigravity profile, as T3 Code makes one
// (apps/server/src/provider/antigravityAuthSupport.ts at 55085df2,
// `antigravityEnvironment` lines 202-246 and `removedEnvironmentKeys` lines
// 62-82; the sign-in, Drivers/AntigravityDriver.ts lines 423-450): an agy
// process run with GEMINI_HOME on its own profile directory and file storage
// forced, so its Google sign-in lands in `antigravity-acp/` there as a token
// file and never in the OS keychain. For a personal sign-in the 1.5 CLI
// ignores AGY_ACP_FORCE_FILE_STORAGE unless it believes it runs over SSH, so
// SSH_CONNECTION is set when the caller's is unset or empty, as T3 sets it.
// Nothing T3 does not set is set; T3's own runtime paths (its browser capture
// command, its temp directory, a CA bundle) are left out. Pure.
import { Match, Option } from "effect"
import type { AuthMethod } from "./reader.ts"

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

/** What T3 sets for an SSH session the CLI believes it runs in (its line 233). */
export const LOCAL_SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0"

/** An agy process's environment on a managed profile: what to unset, then what to set, in order. */
export interface ManagedEnvironment {
  readonly unset: ReadonlyArray<string>
  readonly set: ReadonlyArray<readonly [string, string]>
}

/**
 * The environment T3 gives an agy process on the profile `profile` for a
 * sign-in of kind `auth`, the caller's SSH_CONNECTION being `ssh` (none when
 * unset): T3's removed keys unset, then GEMINI_HOME, file storage, no auto
 * update, unbuffered Python and Electron as Node, and for a personal sign-in
 * SSH_CONNECTION when the caller has none.
 */
export const managedEnvironment = (profile: string, auth: AuthMethod, ssh: Option.Option<string>): ManagedEnvironment => {
  const sshSet: ReadonlyArray<readonly [string, string]> = Match.value(auth).pipe(
    Match.when("personal", () => [["SSH_CONNECTION", Option.getOrElse(Option.filter(ssh, (value) => value !== ""), () => LOCAL_SSH_CONNECTION)] as const]),
    Match.orElse(() => []),
  )
  return {
    unset: REMOVED,
    set: [
      ...sshSet,
      ["GEMINI_HOME", profile],
      ["AGY_ACP_FORCE_FILE_STORAGE", "1"],
      ["AGY_CLI_DISABLE_AUTO_UPDATE", "1"],
      ["PYTHONUNBUFFERED", "1"],
      ["ELECTRON_RUN_AS_NODE", "1"],
    ],
  }
}

/** A value quoted for sh. */
const quoted = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

/** `environment` as a file sh sources: `unset` lines, then `export` lines. It holds no secret. */
export const envFileText = (environment: ManagedEnvironment) =>
  [
    "# The managed Antigravity profile's environment, as T3 Code sets it (written by bun cmd/pool/antigravity-read.ts --profile-env).",
    `unset ${environment.unset.join(" ")}`,
    ...environment.set.map(([name, value]) => `export ${name}=${quoted(value)}`),
    "",
  ].join("\n")

/** The one line that signs agy in on the managed profile: T3's `agy acp --login`, with no display so it prints its link. */
export const signInCommand = (envFile: string) => `. ${quoted(envFile)} && env -u DISPLAY -u WAYLAND_DISPLAY agy acp --login`
