// The kernel's limits, shared by the host and its worker process. This file
// imports nothing, so the worker loads it without Effect.

/** One frame, in bytes, before its newline. */
export const MAX_FRAME_BYTES = 1024 * 1024
/** A snapshot or restore frame, in bytes, all its lines together: room for 256 MiB of clones as base64. */
export const MAX_SNAPSHOT_FRAME_BYTES = 512 * 1024 * 1024
/** A host reply's value, in bytes, leaving room for its envelope. */
export const MAX_REPLY_BYTES = MAX_FRAME_BYTES - 4 * 1024
/** The source of one call, in characters. */
export const MAX_SOURCE_CHARS = 256 * 1024
/** What one call shows: console output then the last value, in characters. */
export const MAX_DISPLAY_CHARS = 64 * 1024
/** The head the display keeps when it overflows; the rest of `MAX_DISPLAY_CHARS` is its tail. */
export const MAX_DISPLAY_HEAD_CHARS = 48 * 1024
/** Host calls one cell may have in flight at once. */
export const MAX_PENDING_CALLS = 32
/** Host calls one cell may make in all. */
export const MAX_CALLS_PER_CELL = 4096
/** One stored binding, in bytes of its structured clone. */
export const MAX_BINDING_BYTES = 16 * 1024 * 1024
/** Every stored binding together, in bytes. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
/** How long a new worker may take to say it is ready, in ms. */
export const READY_MS = 10_000
