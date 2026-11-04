import { createHash } from 'node:crypto'

/** The header Claude Code sends to name its session. */
export const CLAUDE_CODE_SESSION_HEADER = 'x-claude-code-session-id'

/**
 * A stable, version-4-shaped UUID for an OpenCode session: the same session
 * always sends the same id, and the id reveals nothing of the session's own.
 */
export function claudeCodeSessionID(sessionID: string): string {
  const hex = createHash('sha256')
    .update(`opencode-claude-code-session\u0000${sessionID}`)
    .digest('hex')
  const variant = '89ab'[Number.parseInt(hex[16] ?? '0', 16) % 4]
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}
