---
type: Issue
title: Move a Claude Code session between the Mac and dev-home from an hc terminal
description: hc-teleport carries the git state and the transcript, resumes on the other machine, then stops the source.
status: open
timestamp: 2026-11-10T02:48:33Z
---

## 0001. Move a Claude Code session between the Mac and dev-home from an hc terminal

An `hc-teleport <terminal> <machine>` command moves a Claude Code session that runs in a herdr-core (`hc`) terminal from the owner's Mac to `dev-home`, and back. No existing tool does this for `hc` terminals; see research 0001.

### Context

- **Same project paths.** The Mac and `dev-home` keep projects at the same path, `/Volumes/Developer/www/<org>/` (dev-fleet issue 0002). The transcript directory Claude Code derives from the cwd is therefore the same on both. Only the home differs: `/Users/ejklock` on the Mac, `/home/ejklock` on the box.
- **Who has SSH.** The Mac reaches `dev-home` over SSH. `dev-home` holds no credential for the Mac: no private key is copied and no agent is forwarded (dev-fleet issue 0002, owner).
- **Wrappers.** Sessions run through account wrappers such as `claude-pa` and `claude-klock`.

### Scope

- A `SessionStart` hook of Claude Code labels its own `hc` terminal with the session id. It uses `hc label "$HC_TERMINAL_ID" claude.session=<id>`, so the move never guesses which transcript to carry.
- `hc-teleport <t> <machine>`, run on the Mac, does these steps in order:
  1. Wait until the terminal is idle (`hc wait`), then read its cwd, argv and session label (`hc get --json`).
  2. Carry git:
     - the commits the destination lacks, as a bundle;
     - the staged and unstaged changes, as temporary commits built through a temporary index, so the source checkout, index and branch never change;
     - ignored files stay behind.
  3. Carry the transcript and its subagent directory, rewriting the home path.
  4. Start the same wrapper with `--resume <id>` on the destination (`hc run --on <machine> --cwd <cwd> --keep`), check that it came up, and only then stop the source terminal.
- **The way back.** `dev-home` to the Mac works the same way, still started from the Mac (pull through `hc exec|file --on`).
- **Refusals.** The move refuses, and changes nothing, when:
  - the destination branch has diverged, or is checked out with other changes;
  - the session has no label;
  - the terminal is not idle.

### Decision

- A new repository, `klock-tecnologia/hc-teleport`, outside dev-fleet and se-configs (owner, 2026-11-09).
- Built on `hc` primitives, because `hc` has no plugin system. Not taken:
  - wrapping hopsesh (alpha; it pulls from the destination, which would need SSH from `dev-home` to the Mac);
  - Sheprd's Teleport (it moves Herdr 1 worktrees, not `hc` terminals);
  - cloud sync tools (code and possible secrets would go to a third party).

  This is the session's recommendation, which the owner accepted by asking for the mod.
- Every transfer is started from the Mac, so `dev-home` never needs a credential for the Mac.

### Open questions

- **Memory.** The agent-memory database lives on the Mac (`~/.agent-memory`), so a session resumed on `dev-home` does not see the same memory. Decide whether that is acceptable, or how to reach it.
- **MCP servers and hooks.** They differ between the two machines. List what a resumed session loses.
- **Upstream.** Propose `hc move <t> --to <machine>` to herdr-core once this works.

### Acceptance

- A test with two throwaway containers, each running `hc` and holding a fake Claude transcript, shows these cases:
  - a move carries the commits and the uncommitted changes exactly, binary files included, and leaves the source checkout unchanged;
  - the transcript lands under the destination's project directory with the home path rewritten;
  - the destination terminal runs the resume command, and the source terminal stops only after it;
  - each refusal case changes nothing on either side;
  - a move there and back restores the original state.
- A real move from the Mac to `dev-home` and back resumes the conversation. This is the owner's step.
