// The managed profile's one description pinned, field by field, to T3 Code's
// values at 55085df2 (apps/server/src/provider/, the file and lines on each
// assertion), and every consumer shown to read it from that description.
import { describe, expect, test } from "bun:test"
import { APP_DATA_DIR, envFileText, LOCAL_SSH_CONNECTION, managedProfile, PaneLaunch, paneLaunch, REMOVED, settingsText, signInLine, tokenFilesOf } from "./profile.ts"

const profile = managedProfile("/s/profiles/default", "/h")

describe("the managed Antigravity profile, as T3 makes it", () => {
  test("its layout: GEMINI_HOME, the app data beneath it, made in that order (antigravityAuthSupport.ts 441-442, 514)", () => {
    expect(profile.root).toBe("/s/profiles/default")
    expect(APP_DATA_DIR).toBe("antigravity-acp")
    expect(profile.appData).toBe("/s/profiles/default/antigravity-acp")
    expect(profile.directories).toEqual(["/s/profiles/default", "/s/profiles/default/antigravity-acp"])
  })

  test("its settings: antigravity-acp/settings.json, the personal auth type and a newline (antigravityAuthSupport.ts 146-155, 532-533)", () => {
    expect(profile.settings).toEqual({ path: "/s/profiles/default/antigravity-acp/settings.json", text: '{"auth":{"type":"oauth-personal"}}\n' })
    expect(settingsText()).toBe('{"auth":{"type":"oauth-personal"}}\n')
  })

  test("its links into ~/.gemini: two skill directories, then three files (Drivers/AntigravitySkills.ts 27-35; antigravityAuthSupport.ts 256-260, 274-289)", () => {
    expect(profile.links).toEqual([
      { link: "/s/profiles/default/config/skills", target: "/h/.gemini/config/skills", kind: "directory" },
      { link: "/s/profiles/default/antigravity-cli/skills", target: "/h/.gemini/antigravity-cli/skills", kind: "directory" },
      { link: "/s/profiles/default/AGENTS.md", target: "/h/.gemini/AGENTS.md", kind: "file" },
      { link: "/s/profiles/default/GEMINI.md", target: "/h/.gemini/GEMINI.md", kind: "file" },
      { link: "/s/profiles/default/config/skills.json", target: "/h/.gemini/config/skills.json", kind: "file" },
    ])
  })

  test("its token files: the ones the reader reads, beneath the app data, in T3's order (antigravityUsageLimits.ts 331-336, antigravityAuthSupport.ts 469)", () => {
    expect(profile.tokenFiles).toEqual({ acp: "/s/profiles/default/antigravity-acp/acp_token.json", cli: "/s/profiles/default/antigravity-acp/antigravity-oauth-token" })
    expect(tokenFilesOf(profile.root)).toEqual(profile.tokenFiles)
  })

  test("its environment: T3's removed keys, then SSH_CONNECTION, GEMINI_HOME, file storage, no update, unbuffered, Electron as Node (antigravityAuthSupport.ts 62-82, 230-240)", () => {
    expect(REMOVED).toEqual([
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
    ])
    expect(profile.environment).toEqual({
      unset: REMOVED,
      sshConnectionDefault: "127.0.0.1 0 127.0.0.1 0",
      set: [
        ["GEMINI_HOME", "/s/profiles/default"],
        ["AGY_ACP_FORCE_FILE_STORAGE", "1"],
        ["AGY_CLI_DISABLE_AUTO_UPDATE", "1"],
        ["PYTHONUNBUFFERED", "1"],
        ["ELECTRON_RUN_AS_NODE", "1"],
      ],
    })
    expect(LOCAL_SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0")
  })

  test("its launch: acp --gemini-dir <profile> --app-data-dir antigravity-acp; the sign-in adds --login (antigravityAuthSupport.ts 556-562; Drivers/AntigravityDriver.ts 447)", () => {
    expect(profile.acpArgs).toEqual(["acp", "--gemini-dir", "/s/profiles/default", "--app-data-dir", "antigravity-acp"])
    expect(profile.signInArgs).toEqual([...profile.acpArgs, "--login"])
  })

  test("the env file and the lines all come from the description; the env file stores no caller's SSH_CONNECTION", () => {
    const text = envFileText(profile)
    expect(text).toBe(
      [
        "# The managed Antigravity profile's environment, as T3 Code sets it (written by bun cmd/pool/antigravity-read.ts --profile-env).",
        `unset ${REMOVED.join(" ")}`,
        'export SSH_CONNECTION="${SSH_CONNECTION:-127.0.0.1 0 127.0.0.1 0}"',
        "export GEMINI_HOME='/s/profiles/default'",
        "export AGY_ACP_FORCE_FILE_STORAGE='1'",
        "export AGY_CLI_DISABLE_AUTO_UPDATE='1'",
        "export PYTHONUNBUFFERED='1'",
        "export ELECTRON_RUN_AS_NODE='1'",
        "",
      ].join("\n"),
    )
    expect(profile.envFile).toBe("/s/profiles/default.env")
    // Without a display it prints the link (Drivers/AntigravityDriver.ts 443-444).
    expect(signInLine(profile)).toBe(". '/s/profiles/default.env' && env -u DISPLAY -u WAYLAND_DISPLAY agy acp --gemini-dir /s/profiles/default --app-data-dir antigravity-acp --login")
    expect(signInLine(managedProfile("/it's here", "/h"))).toBe(". '/it'\"'\"'s here.env' && env -u DISPLAY -u WAYLAND_DISPLAY agy acp --gemini-dir '/it'\"'\"'s here' --app-data-dir antigravity-acp --login")
  })

  test("an agy pane: an ACP session runs on the profile's own launch line; the interactive TUI has no flag for it, a typed unknown", () => {
    expect(paneLaunch(profile, "acp")).toEqual(PaneLaunch.cases.Acp.make({ line: ". '/s/profiles/default.env' && agy acp --gemini-dir /s/profiles/default --app-data-dir antigravity-acp" }))
    const tui = paneLaunch(profile, "tui")
    expect(tui._tag).toBe("TokenPathUnknown")
    expect(PaneLaunch.match(tui, { Acp: ({ line }) => line, TokenPathUnknown: ({ why }) => why })).toStartWith("pane mode: token path unknown: reads unavailable")
  })
})
