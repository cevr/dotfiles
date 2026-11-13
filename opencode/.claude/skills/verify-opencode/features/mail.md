# Session mail

An agent lists the sessions it can write to with `sessions` and puts a message into one with `message({ to, text, wake?, replyTo? })`, by id or title. The receiver reads it as a steered synthetic message under a header that names the sender and how to answer; an idle receiver wakes (unless `wake: false`) and a running one reads it at its next step. The sender's answer says which happened. Hosts paired once (`bun cmd/mail/pair.ts invite` / `join`) list and message each other's sessions over signed HTTP.

## Sub-features

- `mail-list`: `sessions` lists the server's sessions with their state, the caller's marked `(you)`.
- `mail-wake`: a message to an idle session wakes it; the receipt says `It was idle and is now reading it.`
- `mail-steer`: a message to a running session is read at its next step; the receipt says `It is running and reads it at its next step.`
- `mail-quiet`: `wake: false` delivers without starting a turn.
- `mail-reply`: the letter's header names the sender's id, so the receiver answers it.
- `mail-peer`: a paired host's sessions list as `· on <host>` and take messages by id.
- `mail-faults`: a failed store write or a lost answer delivers once, never twice.

## How to get to it (user POV)

- The agent's `sessions` and `message` tools, direct.
- From a kernel cell, `tools.sessions()` and `tools.message(...)`.
- The receiver's transcript shows the letter as a notice row (`from <title> · <text>`).
- Pairing, once per host pair: `bun cmd/mail/pair.ts invite` on one, `join` on the other.

## Driving it with the world

- **Preconditions:** two or three sessions in one location; for peers, a second host (`sim/hosts.ts`) on the memory network.
- **States:** default, a woken idle receiver, a running receiver, refused (an unknown `to`), error (the faults suite). Loading is `n/a`.
- **World suites:** `cmd/mail/mail.sim.test.ts`, `cmd/mail/mail-faults.sim.test.ts`, `cmd/mail/mail-peer.sim.test.ts`, `cmd/mail/mail-start.sim.test.ts`
- **Code:** `mods/mail/`, `cmd/mail/`, `sim/`
- **Regression:** `mods/mail/*.test.ts`.

1. **List and wake.** Session A prompts `verify: call sessions {}` then `verify: call message {"to":"Mail B","text":"mail-ping: answer me"}`. A's `sessions` answer lists B by id and title; the `message` answer is `Delivered to session "Mail B" (<id>). It was idle and is now reading it.`; B's first request carries the letter under `✉ Message from session "Mail A"`.
2. **Steer.** While C runs a held tool, A messages C. The answer says C is running; C's next request, not the held one, carries the letter.
3. **Peers.** `mail-peer.sim.test.ts` pairs two hosts and sends a message each way over the memory network.

## Driving it with real OpenCode

- **Real:** `tests/mail.test.ts`, `tests/mail-peer.test.ts`

1. **Two sessions.** In the TUI, open a second session (the session list's new-session key) and title it by its first prompt: type `verify: say mail target`, Enter. Go back to the first session.
2. **List.** Type `verify: call sessions {}`, Enter. Wait for `(you)`. The answer lists both sessions, the second by its title `Verify run`.
3. **Message.** Type `verify: call message {"to":"<the second session's id from step 2>","text":"hello from the first"}`, Enter. Wait for `Delivered to session`. The answer says the receiver was idle and is now reading it.
4. **Second view.** Open the second session: its transcript shows the letter's notice row, `from Verify run · hello from the first`, and a new turn ending `verify: no directive; …`.
5. **Proof.** Snapshot after steps 3 and 4 into `$EVIDENCE/mail/`.

## Gotchas

- Every verify-model session is titled `Verify run`, so `to` by title is ambiguous on a real run: address by id.
- A woken receiver on the verify model answers the letter with `verify: no directive; you said …`: a turn, not a reply. A reply needs the letter's text to hold a `verify:` line.
- Peers are real only with two paired servers (`tests/mail-peer.test.ts`); a scratch root is one host.
