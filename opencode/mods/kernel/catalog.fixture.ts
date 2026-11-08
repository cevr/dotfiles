// The kernel's tool catalog as of 2026-11-08 (name and description), for the docs search's ranking test.
export const catalog: ReadonlyArray<{ readonly id: string; readonly description: string }> = [
  {
    id: "shell",
    description:
      'Execute a shell command and return its handle: its shell ID, state (running, exited, killed), exit code, runtime and output. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. A command that ends in the foreground returns its handle already exited, with its output. One still running after its timeout (default 10 min) moves to the background: the call returns its running handle with the output so far, and the command keeps running. background: true returns the handle at once. You are notified when a background command ends. Act on a handle with this same tool, its action and its id: { action: "check", id } shows its state and the output since your last look, { action: "wait", id, ms } waits up to ms for it to end, { action: "kill", id } stops it. { action: "list" } lists this session\'s shells.\n\nIn a cell, `tools.shell({ command, workdir?, timeout?, description?, background? })` only runs a command, and resolves to a live handle: `.id`, `.state`, `.exitCode`, `.signal`, `.runtimeMs`, `.output`, `.next`, and methods that act on that shell, update the handle in place and resolve to it: `.refresh()` (its state, and the output since the last look), `.read({ offset?, lines? })`, `.wait(ms?)` (up to 10 min by default), `.kill()`. `.output` is what the latest call showed. `await tools.shell.handle(id)` builds one for a shell this session started, and `await tools.shell.list()` one for each of them (with `.description` and `.command`). Example: `const h = await tools.shell({ command: \'bun dev\', background: true }); await h.wait(500); await h.kill()`. A kernel restart keeps a handle\'s data but not its methods, so rebuild it with `tools.shell.handle(h.id)`. The tool\'s other actions (check, wait, kill, list) are these methods in a cell: an input naming one throws, naming the method.',
  },
  {
    id: "monitor",
    description:
      'Poll a command on an interval until it exits 0 (or its stdout matches `until`), then wake this session with a message carrying the last output and your note. Use it for CI runs, deploys, ports, files, or URLs that change on their own.\n- One monitor replaces a loop of shell checks: give the check as a command that exits 0 when done, or an `until` regex on its output, then answer and stop.\n- Set intervalSeconds to how fast the thing changes; a CI run needs a check every minute, not every second.\n- The wake message carries the last output, so make the command print what you will need to decide the next step.\n- repeat watches something that changes more than once (several PRs\' review states, a queue): `repeat: "change"` wakes you each time the output changes, `repeat: "match"` on each new match; it keeps going until its timeout or wake_cancel. For pull requests prefer the pr tool\'s watch.\n- It runs while an OpenCode server runs; if none runs at its deadline, an OS job starts one to finish it.',
  },
  {
    id: "job",
    description:
      "Run a long command (a build, a test suite, a benchmark, a deploy) as a job outside the OpenCode server, so it survives a server restart. When it ends, a letter with its exit code, duration, log tail and your note starts a turn in this session, even if it ended while no server ran.\n- Use it instead of a background shell, nohup, setsid or systemd-run for anything that runs longer than a few minutes, and instead of polling with ps or pgrep: the end letter is the check.\n- After run, end your turn unless other work remains. A subagent, whose turn's end hands back to its parent, uses action wait.\n- The note is all the letter carries besides the log tail: say what to check and what result means done.\n- The command can append progress lines to the file named by $JOB_DRIP; they reach you at most once a minute without starting a turn.\n- Set heavy for CPU-heavy commands. Stop one you no longer need with action kill; list shows this session's jobs after a handoff.",
  },
  {
    id: "browse_secrets_run",
    description:
      "Run a local command with a captured profile injected as BC_SECRET_N environment variables. Known values are replaced with their references in stdout and stderr, which keeps them out of transcripts. The command receives the real values, so redaction does not protect them from a command that deliberately sends or encodes them: run only commands you wrote or trust.",
  },
  {
    id: "wake",
    description:
      'Set an alarm. When it fires, a wake message carrying your note starts a new turn in this session, even if no OpenCode server is running then (an OS job starts one). Use it to check on work that runs outside this session (CI, a deploy, a remote job) at a known time instead of polling, and for any later wake-up or reminder.\n- When you are waiting on something outside the session, set a wake with a note saying what to check, answer, and stop; do not poll in a loop.\n- The note is all the wake message carries, so name the command or URL to check and what result means done.\n- Pick afterSeconds from how fast the thing actually changes: one check after a CI run\'s usual length beats many short ones.\n- everySeconds makes the alarm repeat; each fire starts a turn, so cancel it with wake_cancel as soon as the work it checks on is done.\n- mode: "notify" is for a reminder the user should see now and you should read next time you run; it never starts a turn.\n- newSession starts a fresh session at that time with its prompt, for work that should not run in this one.',
  },
  {
    id: "patch",
    description:
      'Use the `patch` tool to edit files. Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:\n\n*** Begin Patch\n[ one or more file sections ]\n*** End Patch\n\nWithin that envelope, you get a sequence of file operations.\nYou MUST include a header to specify the action you are taking.\nEach operation starts with one of three headers:\n\n*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\n*** Delete File: <path> - remove an existing file. Nothing follows.\n*** Update File: <path> - patch an existing file in place (optionally with a rename).\n\nExample patch:\n\n```\n*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n```\n\nIt is important to remember:\n\n- You must include a header with your intended action (Add/Delete/Update)\n- You must prefix new lines with `+` even when creating a new file',
  },
  {
    id: "rift",
    description:
      'Isolated workspaces (Rifts): a copy-on-write copy of the repository\'s warm source, with its installed packages and build output, on its own branch. Use it in place of git worktrees, and in place of any script of your own around rift or workrift.\n\ncreate ({ action: "create", branch, name? }) answers the Rift\'s directory and branch; it does not move this session. On the workbox it runs `workrift create <branch>`, which first refreshes the warm source and carries over gh stack metadata, and names the Rift after the branch.\n\nlist ({ action: "list" }) shows each Rift with its branch and its unsaved work. remove ({ action: "remove", name | path, withChildren? }) moves a Rift to the trash once its work is committed and pushed; it refuses one with uncommitted changes, stashes or unpushed commits and names them, unless force: true.\n\nland ({ action: "land", rifts: ["feat-x", "feat-y"] }) lands the Rifts (each by path, name or branch) as one batch, in the warm source\'s integration Rift (`integrate`): it starts at origin\'s newest default branch, merges each Rift\'s branch in order (a conflict in lock files or the repository\'s generated files is settled by writing them again; any other stops the batch, aborts the merge and names the Rift and the files), writes the generated files again after every batch (`rift.regenerate`, its changes committed), runs the repository\'s gate once (`rift.gate` in the warm source\'s Git config), pushes to the default branch and trashes the landed Rifts. Then its accept check (`rift.accept`) runs once, in the background, on everything the batch changed, and wakes this session with the result; a red one is fixed forward. A red gate stops before the push. Commit everything first. A repository that lands through pull requests sets `rift.push` false: land then merges, gates and checks the same way but pushes no default branch and keeps every Rift, and answers each Rift green or red (a conflict makes only that Rift red); with `rift.pushBranches` true a green Rift\'s own branch is pushed, for its PR.\n\nOn the workbox, { action: "refresh" | "check" | "deps" | "sources" | "prune" | "storage" | "init" } runs `workrift <action>` (prune only as --dry-run; storage is the Rift file system\'s check and use; init needs repository). Elsewhere they answer that they need the workbox.\n\nNever do feature work in the warm source itself.',
  },
  {
    id: "write",
    description:
      "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",
  },
  {
    id: "opencode_session_move",
    description:
      "Move a session to another directory, or omit sessionID to move the current session. The current session moves at the next safe boundary; do not run destination-dependent tools in the same execute call.",
  },
  {
    id: "browse_execute",
    description:
      "Execute Playwright JavaScript against the browse session. Code runs in a restricted JavaScript realm on the relay without process, require, import(), fs, child_process, http/https or Node fetch; save and read files with the files helper inside the execute file roots, and cookie access is limited to the session's pages. Synchronous code stops after about 2 seconds. It is not a security boundary, so treat code as running as the user. The result includes console logs, warnings, a bounded execution-context diagnostic when relevant, and an aftermath summary (URL movement, navigations, error counts, handoffs, and a bot challenge or block page when one appears: hand interactive ones to the user with handoff(), never solve or retry-loop them).",
  },
  {
    id: "queue",
    description:
      "Your live queue, shown to the owner in the session sidebar like a to-do list. Keep it current as work starts, finishes, gets scheduled, waits on someone, or needs the owner: call it the moment an item changes, not at the end of the turn. Prefer a patch (upsert, remove) to rewriting the whole list (set).\n\nEach item: id (a short slug you choose and keep), text (one line), state (needs-you, running, waiting, scheduled, next, done), owner (mine, the default, or other for another session's or agent's work, with who), at (ISO 8601; required for scheduled), detail (a few words: a pane, what it waits on).\n\nneeds-you is what only the owner can do (a decision, a login, an irreversible action); done items stay visible for ten minutes.\n\nWhen you start a subagent, add an item with session set to its sessionID (from the subagent tool's result): the sidebar then shows that session's live state (running, blocked, done, failed), so do not copy its status into state or update it as it runs. A subagent without an item does not show in the queue.\n\nAnswers with the queue as it now stands.",
  },
  {
    id: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
  },
  {
    id: "message",
    description:
      "Send a message to another OpenCode session (find it with the sessions tool), to coordinate with it without the owner relaying. It arrives in that session as a message from you, with your session's id and title and how to answer.\n\nA running session reads it at its next step; an idle one wakes to read it (wake: false leaves it for its next turn). Answers come back the same way, as a message in your session. A session on a host paired with this one (listed `on <host>`) is reached by its id. You cannot write to your own session.\n\nAnswer a message only when it asks for something, so two sessions do not reply to each other forever.",
  },
  {
    id: "sessions",
    description:
      "List the other OpenCode sessions on this server that you can write to with the message tool: each one's id, title, whether it is running or idle, its agent, its directory and when it was last active, newest first. Main sessions by default; children: true adds subagents' sessions (with their parent). search narrows by text in the title, directory or id.\n\nYour own session is marked (you). Sessions on a host paired with this one (mail pairing) are listed too, marked `on <host>`; write to one by its id.",
  },
  {
    id: "experimental_image_generate",
    description:
      "Generates a new image, or edits existing ones.\nOnly call this when the user asks you to create or edit an image. If you think an image would help but the user didn't ask for one, ask them first instead of generating it.\nImages you pass are used as the source to edit, or as references for style and subject.\nEach call makes one image. For several images, call it once per image.\nIt runs in the background: the call starts a job and returns right away, and you are notified automatically when the image is saved, with its path. Never poll, sleep, or check for the file while you wait.\nDon't repeat a request unless the user asks.",
  },
  {
    id: "subagent",
    description:
      "Spawns an agent in a child session to work on the specified task.\nThe output includes a sessionID you can pass back later to continue that specific conversation with the subagent.\nNew child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.\nForeground (default) runs the subagent to completion and returns its final response.\nBackground mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.\nUse background only for independent work that can run while you continue elsewhere.",
  },
  {
    id: "browse_tabs_cleanup",
    description:
      "Close tabs agents opened that nobody has used for a while (no agent command and not visited by the user). Tabs the user shared or pinned, the active tab, tabs playing audio, recording, or waiting for a handoff stay open. This covers agent tabs from every session; to finish your own work use `session_reset` or `session_delete` instead. browse also does this automatically after the user's idle setting (10 minutes unless they changed it).",
  },
  {
    id: "question",
    description:
      'Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- A "Type your own answer" option is added automatically; don\'t include a separate option for free form answers\n- Set `multiple: true` to allow selecting more than one option\n- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
  },
  {
    id: "edit",
    description:
      "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
  },
  {
    id: "pr",
    description:
      "GitHub pull requests and CI, without polling them by hand.\n- status: per request, the head commit, its checks grouped fail/pending/pass/cancelled (each failing job with its failing tests and a log excerpt), the review decision and latest reviews, unresolved threads, requested reviewers and mergeability. A cancelled run is not a failure.\n- watch: the server watches the requests for you and sends a notice into this session when what you wait for comes (until green, reviewed or changed), with what changed. Set it and end your turn or do other work; never poll with gh, sleep or a monitor.\n- unwatch, list: stop or list this session's watches.\n- create: opens a request for the session's branch (push it first) with title and body, asking the configured reviewers unless reviewers says otherwise.\nOnce you used the tool on a repository, a notice also comes when its default branch turns red, and when it is green again.",
  },
  {
    id: "memory_save",
    description:
      'Save a note to long-term memory, kept on this machine across sessions. Later sessions start with the most useful notes in their system prompt, and memory_search finds the rest.\n\nSave what a later session could not read off the code or the screen and would want: a durable fact about the user, a preference or correction they gave ("use bun, not npm"), a convention of this project, a fix that took real effort and its cause. Save it when the user asks you to remember something, and when something is clearly worth keeping.\n\nDo not save task state, progress, plans, what you just did, anything the repository or its docs already say, or a guess you have not checked. Never save a secret, token or credential.\n\nA note that repeats one already kept updates that note instead of adding another. To correct a wrong note, save with its id; to remove it, memory_forget. A subagent does not save: it puts what is worth keeping in its answer.',
  },
  {
    id: "opencode_read_mcp_resource",
    description:
      "Read one MCP resource by server and URI. Not for local files. Always return the full contents rather than slicing or filtering them; oversized output is truncated automatically and the full content is saved to a file you can read. Images and PDFs are shown to you directly.",
  },
  {
    id: "browse_session_allowlist",
    description:
      "Set the domain allowlist of a session (the current one by default): the hosts or origins its tabs may load. Pass an empty list to remove it. Use it before typing secrets or working on sites with untrusted content.",
  },
  {
    id: "opencode_models",
    description:
      "Search the models available to use. Use this to turn a model name the user mentions into an exact reference for a tool that takes a model. Check your own provider first.",
  },
  {
    id: "wake_cancel",
    description:
      "Cancel a pending alarm or monitor by id, or every pending one of this session when no id is given. Use it when the thing you were waiting for is already done. A notice still shown to the user is dismissed the same way.",
  },
  {
    id: "opencode_list_mcp_resources",
    description:
      "List documents, records, and other data exposed by MCP servers. Use this when the user refers to something that is not a local file, such as a URI with a custom scheme, then load a match with read_mcp_resource. Each entry names the server to read it from. Templates are resources addressed by a parameter such as a record ID; fill in the uriTemplate placeholders before reading.",
  },
  {
    id: "browse_settings",
    description:
      "Read or change the user's browse settings from the extension's options page: where agent tabs open (window), how they're grouped (grouping), when untouched agent tabs close (idleMinutes), the agent cursor (cursor), human-like input (humanInput) and handoff notifications (handoffNotifications). Update behaviour is not available here: only the user changes it, with `browse settings` or the extension's options page, and `status` reports its current value. Use this tool only when the user asks to change how browse behaves, never on your own initiative. Without `set` it returns each setting's stored value, the value in effect, and the relay environment variable that overrides it, if any. With `set` it validates every value strictly, applies the change at once (the options page updates live) and returns what changed: tell the user what you changed. A setting an environment variable fixes is not changed, and the result says so. Security switches (OPENCODE_BROWSER_ALLOW_NODE, OPENCODE_BROWSER_ALLOW_ALL_COOKIES, OPENCODE_BROWSER_ALLOW_FOREGROUND, OPENCODE_BROWSER_ALLOW_ALL_STORAGE, OPENCODE_BROWSER_ALLOW_FILE_URLS, OPENCODE_BROWSER_UPDATE_CHECK) are environment-only and can never be read or changed here.",
  },
  {
    id: "webfetch",
    description:
      "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.",
  },
  {
    id: "grep",
    description:
      "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
  },
  {
    id: "memory_search",
    description:
      "Search long-term memory: the notes earlier sessions saved with memory_save, this project's and the global ones, ranked by how well they match.\n\nSearch before you ask the user something they may have told an earlier session, and when the start-of-session memory block hints there is more. Past conversations themselves are not here; this holds only the saved notes.",
  },
  {
    id: "browse_network",
    description:
      "Start, inspect, stop, or cancel session-scoped network capture. browse records normalized Playwright exchanges; HAR is only the optional export format. Bodies are embedded by default with per-body and total memory limits. Actions: start begins a capture; status returns bounded metadata for the active capture without captured values; stop ends it and optionally writes a credential-redacted HAR and stores lossless credential values in a reusable secret profile (at least one of outputPath or secrets is required); cancel ends it and discards the in-memory exchanges.",
  },
  {
    id: "opencode_session_rename",
    description:
      "Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the work being done.",
  },
  {
    id: "glob",
    description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
  },
  {
    id: "browse_recording",
    description:
      "Record the current session tab. Actions: start begins recording (CDP mode records video to WebM or MP4; tab-capture mode supports WebM and optional audio; outputPath is required); stop finalizes the artifact; status returns bounded status and quality counters; cancel discards the unfinished artifact.",
  },
  {
    id: "wake_list",
    description:
      "List the alarms and monitors pending in this session and the notices not yet read, with ISO times and the current time as `now`. Use it after a context handoff, or before you set a wake that may already exist.",
  },
  {
    id: "browse_flight_recorder",
    description:
      "Keep a rolling in-memory video buffer for the current session tab. Actions: start begins buffering; status returns bounded rolling-buffer duration, frame, byte and drop counters; save_last encodes and saves the most recent buffered video without stopping the buffer (outputPath is required); cancel stops and discards the buffer.",
  },
  {
    id: "ask_user_async",
    description:
      "Ask the user questions in the background and continue at once on a stated assumption. Returns immediately; your turn does not wait, and an unanswered question never blocks you.\n\nThe user sees the open questions in a tray above the prompt and answers them with /answer when they choose. An answer arrives later as a message in this session (it wakes you if you are idle), naming the question, your assumption and the answer, and saying whether they differ; when they differ, revise the work that rests on the assumption.\n\nUse it when you can go on with a reasonable assumption; when you cannot, ask in your reply and stop. While a question is open, state its assumption in your final answer. Asking the same question again replaces the open one; withdraw a question that no longer matters with withdraw: [id]. At most 8 stay open; past that the oldest drops.",
  },
  {
    id: "browse_session_reset",
    description: "Reset a browse session's state and page.",
  },
  {
    id: "browse_session_new",
    description: "Create a browse session and make it current for this MCP server.",
  },
  {
    id: "browse_session_adopt",
    description:
      "Make an attached tab the browse session's default page for subsequent bare execute calls. Omit targetUrl and targetIndex when only one user-attached tab is available.",
  },
  {
    id: "browse_secrets_refresh",
    description:
      "Reload a session page, observe fresh credentials, and update a secret profile while preserving stable BC_SECRET_N references.",
  },
  {
    id: "browse_session_delete",
    description: "Delete a browse session.",
  },
  {
    id: "skill",
    description:
      "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.\n\nThe skill ID must match an available skill or a skill explicitly referenced by the user.",
  },
  {
    id: "browse_status",
    description: "Return relay, extension, target, session, and connected browser status.",
  },
  {
    id: "memory_forget",
    description:
      "Delete a long-term memory note by its id (#12 → 12): one that turned out wrong, outdated, or not worth keeping. To correct a note instead, call memory_save with its id.",
  },
  {
    id: "browse_session_list",
    description: "List browse sessions.",
  },
  {
    id: "browse_session_use",
    description: "Set this MCP server's current browse session id.",
  },
  {
    id: "browse_secrets_list",
    description:
      "List what agents may type without seeing: site secrets the user stored (names, kinds and allowed origins; type them with secrets.type(target, name) in execute; only the user adds them with `browse secrets add`).",
  },
  {
    id: "websearch",
    description:
      "Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.\n\nThe current year is 2026. Use this year when searching for recent information or current events.",
  },
  {
    id: "browse_secrets_status",
    description:
      "Return secret profile references, sources, and expiration metadata without revealing credential values.",
  },
];
