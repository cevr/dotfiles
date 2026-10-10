# baton

An event-sourced relay for [herdr](https://herdr.dev) agent tracks. Whoever holds the baton works next.

Each run keeps one append-only log in SQLite. Every view of a run is a fold of that log: which agent holds each track's baton, what step it is at, and which messages are still owed. Commands append events. The messages those events imply are delivered with `herdr agent prompt`, and each delivery is recorded too. So a crash, a compaction or a second process changes nothing that the log does not already know.

    { view, messages } = fold(log)

baton is the runtime of the [orchestrate skill](https://github.com/cevr/dotfiles/tree/main/skills/orchestrate).
