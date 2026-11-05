// The reader's prompt as the transcript shows it, without rendering: its
// text, and one line for what came with it.
import type { UserMessage } from "./session.ts"

/** The prompt's text, trimmed. */
export function promptText(message: UserMessage | undefined) {
  return message?.text.trim() ?? ""
}

/** What came with a prompt (files, skills, agents), as one line: `file a.ts · image shot.png · skill review`. */
export function attachedLine(message: UserMessage | undefined) {
  if (!message) return ""
  return [
    ...(message.files ?? []).map((file) => {
      const label = file.mime === "application/x-directory" ? "dir" : file.mime.startsWith("image/") ? "image" : "file"
      return `${label} ${file.name ?? (file.source.type === "uri" ? file.source.uri : "attachment")}`
    }),
    ...(message.skills ?? []).map((skill) => `skill ${skill.name}`),
    ...(message.agents ?? []).map((agent) => `agent ${agent.name}`),
  ].join(" · ")
}
