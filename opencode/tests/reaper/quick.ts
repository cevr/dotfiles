// A test process that ends at once, as a quick test file's does: it imports testbeds/reaper/start.ts and exits,
// so its reaper's `sh` may start after it is gone and read `$PPID` 1. tests/reaper.test.ts checks that reaper ends.
import "../../testbeds/reaper/start.ts"
