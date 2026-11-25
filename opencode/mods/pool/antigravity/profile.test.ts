// The managed profile's environment pinned to T3 Code's
// (apps/server/src/provider/antigravityAuthSupport.ts at 55085df2: lines 62-82
// for the removed keys, 202-246 for the values set; Drivers/AntigravityDriver.ts
// lines 423-450 for `agy acp --login` with no display).
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { envFileText, LOCAL_SSH_CONNECTION, managedEnvironment, REMOVED, signInCommand } from "./profile.ts"

describe("the managed Antigravity profile", () => {
  test("a personal sign-in: T3's keys unset, then GEMINI_HOME, file storage and the local SSH connection", () => {
    expect(managedEnvironment("/p/default", "personal", Option.none())).toEqual({
      unset: REMOVED,
      set: [
        ["SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 0"],
        ["GEMINI_HOME", "/p/default"],
        ["AGY_ACP_FORCE_FILE_STORAGE", "1"],
        ["AGY_CLI_DISABLE_AUTO_UPDATE", "1"],
        ["PYTHONUNBUFFERED", "1"],
        ["ELECTRON_RUN_AS_NODE", "1"],
      ],
    })
    expect(LOCAL_SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0")
    expect(REMOVED).toContain("GOOGLE_API_KEY")
    expect(REMOVED).toContain("CHROME_CRASHPAD_PIPE_NAME")
    expect(REMOVED.length).toBe(18)
  })

  test("the caller's SSH connection is kept; an empty one is replaced; a business sign-in sets none", () => {
    expect(managedEnvironment("/p", "personal", Option.some("10.0.0.1 22 10.0.0.2 22")).set[0]).toEqual(["SSH_CONNECTION", "10.0.0.1 22 10.0.0.2 22"])
    expect(managedEnvironment("/p", "personal", Option.some("")).set[0]).toEqual(["SSH_CONNECTION", LOCAL_SSH_CONNECTION])
    expect(managedEnvironment("/p", "business", Option.none()).set.map(([name]) => name)).not.toContain("SSH_CONNECTION")
  })

  test("the env file and the sign-in line", () => {
    expect(envFileText(managedEnvironment("/it's/here", "personal", Option.none()))).toMatchInlineSnapshot(`
      "# The managed Antigravity profile's environment, as T3 Code sets it (written by bun cmd/pool/antigravity-read.ts --profile-env).
      unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_LOCATION GOOGLE_CLOUD_QUOTA_PROJECT GOOGLE_GENAI_USE_VERTEXAI GCLOUD_PROJECT CLOUDSDK_CORE_PROJECT AGY_ACP_CCPA_PROJECT AGY_ACP_ENABLE_OAUTH GEMINI_HOME AGY_ACP_FORCE_FILE_STORAGE AGY_CLI_DISABLE_AUTO_UPDATE BROWSER PYTHONUNBUFFERED ELECTRON_RUN_AS_NODE CHROME_CRASHPAD_PIPE_NAME
      export SSH_CONNECTION='127.0.0.1 0 127.0.0.1 0'
      export GEMINI_HOME='/it'"'"'s/here'
      export AGY_ACP_FORCE_FILE_STORAGE='1'
      export AGY_CLI_DISABLE_AUTO_UPDATE='1'
      export PYTHONUNBUFFERED='1'
      export ELECTRON_RUN_AS_NODE='1'
      "
    `)
    expect(signInCommand("/s/agy.env")).toBe(". '/s/agy.env' && env -u DISPLAY -u WAYLAND_DISPLAY agy acp --login")
  })
})
