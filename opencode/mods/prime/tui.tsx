// Temporary: the old entry point. A cli.json written before Prime moved to
// cmd/prime loads this directory, and OpenCode resolves its `./tui` export
// here; the next `bun run daily` rewrites that entry to cmd/prime, after
// which this file can go.
export { default } from "../../cmd/prime/tui.tsx"
