// The input each kernel catalog line shows, for the tools other than memory's,
// as the production kernel description of 2026-11-08 rendered them (a frozen
// `kernel-catalog:` entry of the Mac's OpenCode, its 50-tool catalog, the same
// tools as mods/kernel/catalog.fixture.ts). catalog.fixture.ts keeps each
// tool's name and description but not its input schema, so the inputs are
// kept here as the catalog printed them. Memory's three lines are rendered
// from their real schemas, so they follow notebook.ts.
export const KERNEL_INPUTS: Readonly<Record<string, string>> = {
  ask_user_async:
    "{ questions?: { question: string, header?: string | null, options?: { label: string, description?: string | null }[] | null, assume: string }[] | null, withdraw?: string[] | null }",
  browse_execute: "{ code: string, session?: string, targetUrl?: string, targetIndex?: number, browser?: string, timeoutMs?: number }",
  browse_flight_recorder:
    '{ action: "start" | "status" | "save_last" | "cancel", session?: string, retentionMs?: number, frameRate?: number, cursor?: boolean, outputPath?: string, durationMs?: number }',
  browse_network:
    '{ action: "start" | "status" | "stop" | "cancel", session?: string, urlFilter?: string, resourceTypes?: string[], content?: "embed" | "omit", maxBodyBytes?: number, maxTotalBodyBytes?: number, maxEntries?: number, maxDurationMs?: number, outputPath?: string, secrets?: string }',
  browse_recording:
    '{ action: "start" | "stop" | "status" | "cancel", session?: string, outputPath?: string, mode?: "auto" | "tab-capture" | "cdp", audio?: boolean, frameRate?: number, maxDurationMs?: number, cursor?: boolean }',
  browse_secrets_list: "{ session?: string }",
  browse_secrets_refresh: "{ name: string, session?: string, urlFilter?: string, timeoutMs?: number }",
  browse_secrets_run: "{ name: string, command: string, args?: string[], cwd?: string, timeoutMs?: number }",
  browse_secrets_status: "{ name: string }",
  browse_session_adopt: "{ session?: string, targetUrl?: string, targetIndex?: number, tabId?: number }",
  browse_session_allowlist: "{ session?: string, allowedOrigins: string[] }",
  browse_session_delete: "{ id?: string, session?: string }",
  browse_session_list: "{}",
  browse_session_new: "{ browser?: string, id?: string, readOnly?: boolean, allowedOrigins?: string[] }",
  browse_session_reset: "{ id?: string, session?: string }",
  browse_session_use: "{ id: string }",
  browse_settings:
    '{ set?: { window?: "current" | "separate", grouping?: "shared" | "session" | "none", idleMinutes?: 10 | 30 | 60 | "never", cursor?: "off" | "always", humanInput?: "on" | "off", handoffNotifications?: "recording" | "always" } }',
  browse_status: "{}",
  browse_tabs_cleanup: "{ idleMinutes?: number }",
  edit: "{ path: string, oldString: string, newString: string, replaceAll?: boolean }",
  experimental_image_generate: "{ prompt: string, images?: string[], model?: string, path?: string }",
  glob: "{ pattern: string, path?: string, hidden?: boolean, limit?: number }",
  grep: "{ pattern: string, path?: string, include?: string, literal?: boolean, caseSensitive?: boolean, limit?: number }",
  job: '{ action?: "run" | "check" | "wait" | "kill" | "list" | null, command?: string | null, cwd?: string | null, note?: string | null, heavy?: boolean | null, timeoutSeconds?: number | "Infinity" | "-Infinity" | "NaN" | null, id?: string | null, ms?: number | "Infinity" | "-Infinity" | "NaN" | null }',
  message: "{ to: string, text: string, wake?: boolean | null, replyTo?: string | null }",
  monitor:
    '{ command: string, cwd?: string | null, intervalSeconds?: number | "Infinity" | "-Infinity" | "NaN" | null, until?: string | null, timeoutSeconds?: number | "Infinity" | "-Infinity" | "NaN" | null, mode?: "wake" | "notify" | null, note: string, repeat?: "match" | "change" | null }',
  opencode_list_mcp_resources: "{ server?: string }",
  opencode_models: '{ query?: string, provider?: string, type?: "chat" | "image", all?: boolean, limit?: number, offset?: number }',
  opencode_read_mcp_resource: "{ server: string, uri: string }",
  opencode_session_move: "{ sessionID?: string, directory: string }",
  opencode_session_rename: "{ sessionID?: string, title: string }",
  patch: "{ patchText: string }",
  pr: '{ action: "status" | "watch" | "unwatch" | "list" | "create", prs?: number | "Infinity" | "-Infinity" | "NaN" | string[] | null, until?: "green" | "reviewed" | "changed" | null, note?: string | null, title?: string | null, body?: string | null, base?: string | null, draft?: boolean | null, reviewers?: string[] | "default" | "none" | null }',
  question: "{ questions: { question: string, header: string, options: { label: string, description: string }[], multiple?: boolean }[] }",
  queue:
    "{ set?: { id: string, text?: string | null, state?: string | null, owner?: string | null, who?: string | null, at?: string | null, detail?: string | null, session?: string | null }[] | null, upsert?: { id: string, text?: string | null, state?: string | null, owner?: string | null, who?: string | null, at?: string | null, detail?: string | null, session?: string | null }[] | null, remove?: string[] | null }",
  read: "{ path: string, offset?: number, limit?: number }",
  rift: '{ action: "create" | "list" | "remove" | "land" | "init" | "refresh" | "deps" | "check" | "sources" | "prune" | "storage", name?: string | null, branch?: string | null, source?: string | null, path?: string | null, rifts?: string[] | null, repository?: string | null, force?: boolean | null, withChildren?: boolean | null }',
  sessions: "{ search?: string | null, children?: boolean | null, limit?: number | null }",
  shell: "{ command: string, workdir?: string, timeout?: number, description?: string, background?: boolean }",
  skill: "{ id: string }",
  subagent: "{ agent: string, description: string, prompt: string, model?: string, sessionID?: string, background?: boolean }",
  wake: '{ afterSeconds?: number | "Infinity" | "-Infinity" | "NaN" | null, at?: string | null, everySeconds?: number | "Infinity" | "-Infinity" | "NaN" | null, mode?: "wake" | "notify" | null, note: string, newSession?: { directory?: string | null, prompt: string } | null }',
  wake_cancel: "{ id?: string | null }",
  wake_list: "{}",
  webfetch: '{ url: string, format?: "text" | "markdown" | "html", timeout?: number }',
  websearch: "{ query: string }",
  write: "{ path: string, content: string }",
}
