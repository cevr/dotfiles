// The tool catalog every arm shares: a fake `shell` and the distractors a
// coding agent carries (read, edit, write, grep, glob, webfetch, ...), with
// descriptions of real length, most of them OpenCode's own words, so finding
// the memory tools among them is as hard as in our catalog. Each call is
// answered from the scenario's fake repository and recorded.

export interface ToolDef {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const str = (description: string) => ({ type: "string", description })
const num = (description: string) => ({ type: "number", description })
const bool = (description: string) => ({ type: "boolean", description })

export const SHELL: ToolDef = {
  name: "shell",
  description: [
    "Execute a shell command in the project's working directory and return its output and exit code. Commands run on macOS using zsh.",
    "Quote file paths that contain spaces or special characters. Prefer the dedicated tools over shell commands when possible: read files with read, search with grep and glob, and edit with edit or write; use the shell for git, package managers, builds, tests and other programs.",
    "When output is large, the full result is saved to a file and a truncated preview is returned. Chain dependent commands with &&; run independent commands in separate calls.",
    "Never run destructive commands (rm -rf, git reset --hard, force pushes) unless the user asked for them.",
  ].join("\n\n"),
  input_schema: object(
    {
      command: str("The shell command string to execute."),
      description: str("A few words on what the command does, shown when the session's shells are listed."),
      timeout: num("Milliseconds before the command moves to the background. Defaults to 600000."),
    },
    ["command"],
  ),
}

export const DISTRACTORS: ReadonlyArray<ToolDef> = [
  {
    name: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    input_schema: object(
      {
        path: str("File or directory to read"),
        offset: num("The line or directory entry to start reading from (1-based)"),
        limit: num("The maximum number of lines or directory entries to read (defaults to and capped at 2000)"),
      },
      ["path"],
    ),
  },
  {
    name: "edit",
    description:
      "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence.",
    input_schema: object(
      {
        path: str("File to edit"),
        oldString: str("Exact text to find and replace"),
        newString: str("Text to replace oldString with (must differ from oldString)"),
        replaceAll: bool("Whether to replace every occurrence of oldString. Defaults to false."),
      },
      ["path", "oldString", "newString"],
    ),
  },
  {
    name: "write",
    description:
      "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",
    input_schema: object({ path: str("Path to the file to write to"), content: str("Content to write to the file") }, ["path", "content"]),
  },
  {
    name: "grep",
    description:
      "Search file contents with a regular expression (ripgrep). Returns matching lines grouped by file with their line numbers, most recently modified files first. Use include to filter by file pattern, literal for exact text, and path to narrow the search. Use this tool instead of running grep or rg through the shell. For open-ended searches that need several rounds of globbing and grepping, start a subagent instead.",
    input_schema: object(
      {
        pattern: str("Regular expression or literal text to match in file contents."),
        path: str("File or directory to search. Defaults to the current working directory."),
        include: str('Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")'),
        literal: bool("Treat `pattern` as exact text instead of a regular expression (default: false)."),
      },
      ["pattern"],
    ),
  },
  {
    name: "glob",
    description:
      'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx"). Returns matching paths sorted by modification time. Use it to find files by name; use grep to search their contents.',
    input_schema: object(
      { pattern: str("Glob pattern to match files against"), path: str("Directory to search. Defaults to the current working directory.") },
      ["pattern"],
    ),
  },
  {
    name: "webfetch",
    description:
      "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.",
    input_schema: object(
      {
        url: str("The HTTP or HTTPS URL to fetch content from"),
        format: { type: "string", enum: ["text", "markdown", "html"], description: "The format to return the content in. Defaults to markdown." },
      },
      ["url"],
    ),
  },
  {
    name: "websearch",
    description:
      "Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.\n\nThe current year is 2026. Use this year when searching for recent information or current events.",
    input_schema: object({ query: str("Websearch query") }, ["query"]),
  },
  {
    name: "todowrite",
    description:
      "Create and update a structured task list for the current session. Use it to track progress on multi-step work, to show the user what you are doing, and to make sure no requested step is forgotten. Mark exactly one task in_progress at a time, and mark each task completed as soon as it is done, not in batches. Skip it for a single trivial step or a purely conversational answer. The list lives only in this session.",
    input_schema: object(
      {
        todos: {
          type: "array",
          description: "The updated todo list",
          items: object(
            {
              content: str("Brief description of the task"),
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "Current status of the task" },
            },
            ["content", "status"],
          ),
        },
      },
      ["todos"],
    ),
  },
  {
    name: "question",
    description:
      'Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- A "Type your own answer" option is added automatically; don\'t include a separate option for free form answers\n- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
    input_schema: object(
      {
        questions: {
          type: "array",
          description: "Questions to ask",
          items: object({ question: str("The question"), options: { type: "array", items: { type: "string" }, description: "Choices" } }, ["question"]),
        },
      },
      ["questions"],
    ),
  },
  {
    name: "subagent",
    description:
      "Start a subagent to handle a self-contained task in its own context: a broad search across the codebase, a research question, or a piece of work that can run beside yours. Give it a short description and a complete prompt, since it sees nothing of this conversation. Its final answer comes back as this tool's result. Prefer doing a small task yourself; start several subagents at once for independent tasks.",
    input_schema: object(
      { description: str("A short (3-5 word) description of the task"), prompt: str("The task for the agent to perform"), background: bool("Run it in the background") },
      ["description", "prompt"],
    ),
  },
  {
    name: "skill",
    description:
      "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description. Available skills: code-review (review a change for correctness and minimality), writing-tests (write tests worth keeping), create-pr (commit, push and open a pull request with a focused summary), diagnosing-bugs (a diagnosis loop for hard bugs).",
    input_schema: object({ id: str("The ID of an available skill") }, ["id"]),
  },
]

/** The base system prompt every arm starts with: a coding agent in the scenario's repository. */
export const basePrompt = (cwd: string): string =>
  [
    "You are an interactive coding agent working in the user's terminal. You help with software engineering tasks: fixing bugs, adding features, refactoring, explaining code, running tests and committing work.",
    "",
    "# How you work",
    "- Do the task with the tools you have; read the code before changing it, and keep changes minimal and in the style of the surrounding code.",
    "- Run the project's tests after a change when there are any. When a command fails, read its output and fix the cause.",
    "- Be concise. Your answers are shown in a terminal; keep them to a few lines unless the user asks for detail.",
    "- Follow the user's instructions and this repository's conventions. Do not commit unless the user asks you to.",
    "- Never invent file contents, command output or results; run the tool and read what it returns.",
    "",
    "# Environment",
    `Working directory: ${cwd}`,
    "Is directory a git repo: yes",
    "Platform: darwin",
    "Today's date: Sun Nov 08 2026",
  ].join("\n")
