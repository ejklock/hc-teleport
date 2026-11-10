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

- The agent's adapter finds the session from the terminal itself: for Claude Code, `foreground.pid` from `hc get <t> --json` and `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`, so the move never guesses which transcript to carry.
- `hc-teleport <t> <machine>`, run on the Mac, does these steps in order:
  1. Wait until the terminal is idle (`hc wait`), then read its cwd, argv and foreground pid (`hc get --json`), and ask the adapter for the session id.
  2. Preflight on the destination, read-only: the repository exists at the same path, the executable (wrapper) is on the PATH `hc run` uses, its profile directory exists, and its Claude Code version is not older than the source's.
  3. Carry git over SSH from the Mac (`git push` or `git fetch` to temporary refs `refs/hc-teleport/*`):
     - the commits the destination lacks;
     - the staged, unstaged and untracked non-ignored changes, as temporary commits built through a temporary index, so the source checkout, index and branch do not change during the move;
     - ignored files stay behind.
  4. Carry the transcript and its subagent directory, rewriting the home path.
  5. Start the same executable with the source's allowed flags, without its positional arguments, plus `--resume <id>` on the destination (`hc run --on <machine> --cwd <cwd> --keep`), and check that it came up.
  6. Only then stop the source terminal, park the source's uncommitted changes in `refs/hc-teleport/<id>`, and reset the source checkout to its HEAD.
- **The way back.** `dev-home` to the Mac works the same way, still started from the Mac (git fetch over SSH, the rest through `hc exec|file --on`).
- **Refusals.** The move refuses, and changes nothing, when:
  - the destination branch has diverged, or is checked out with other changes;
  - the adapter cannot find the session id;
  - the terminal is not idle;
  - a preflight check fails (no repository, no wrapper, no profile, an older Claude Code);
  - the source argv carries a flag outside the allowed list.
- **Failure after transfer.** If the destination does not come up, the move deletes the refs and the transcript it wrote there, and the source keeps running untouched.

### Decision

- A new repository, `klock-tecnologia/hc-teleport`, outside dev-fleet and se-configs (owner, 2026-11-09).
- Built on `hc` primitives, because `hc` has no plugin system. Not taken:
  - wrapping hopsesh (alpha; it pulls from the destination, which would need SSH from `dev-home` to the Mac);
  - Sheprd's Teleport (it moves Herdr 1 worktrees, not `hc` terminals);
  - cloud sync tools (code and possible secrets would go to a third party).

  This is the session's recommendation, which the owner accepted by asking for the mod.
- Every transfer is started from the Mac, so `dev-home` never needs a credential for the Mac.
- **Harness agnostic** (owner, 2026-11-09). The tool moves the session of any coding agent that runs in an `hc` terminal, not only Claude Code: Claude Code and its account wrappers, opencode, pi, Codex. The core (`hc` + git) knows no agent. Each agent enters through an adapter with four parts:
  - how the session identifies itself;
  - which session files to carry;
  - how to rewrite their paths;
  - which command resumes it.

  Not taken: abstracting the multiplexer too (`hc`, herdr, tmux), because every session runs in `hc`.
- **Claude Code first** (owner, 2026-11-09). This issue delivers the Claude Code adapter, wrappers included (`claude-klock`, `claude-pa`, `claude-bd`, each with its own `CLAUDE_CONFIG_DIR`), and fixes the adapter interface. Other agents come in later issues. Not taken: Claude + opencode in this issue; every installed agent (Claude, opencode, pi) in this issue.
- **TypeScript on Node** (owner, 2026-11-09). The tool runs on the Mac only; `dev-home` needs no Node for it and is driven through `hc` calls (`exec`, `file`, `run`, `kill`). Not taken: bash + jq (the earlier session's suggestion; fragile adapters and JSON rewriting), Go (a new stack to keep).
- **Session id from the pid registry** (owner, 2026-11-09). The Claude adapter reads `foreground.pid` from `hc get <t> --json`, then `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`, whose `sessionId` names the transcript. Checked on this session: pid 84526, `~/.claude-klock/sessions/84526.json`, Claude Code 2.1.321. The file is internal and undocumented, so a missing or unknown shape makes the move refuse. Not taken: a `SessionStart` hook that labels the terminal (it installs into each profile's settings, outside this repository, and misses sessions opened before it); the registry with that label as fallback (two paths to keep).
- **Resume argv** (owner, 2026-11-09). The destination runs the source's executable (the wrapper, such as `claude-klock`) with the source's flags, drops the positional arguments (an initial prompt), and adds `--resume <id>`. Not taken: the wrapper with `--resume <id>` alone (it loses the model and permission mode).
- **Parity: each owner provisions, hc-teleport only checks** (owner, 2026-11-09). dev-fleet installs Node and Claude Code; the chezmoi dotfiles carry the wrappers; the se-configs installer sets up profiles, MCP servers and hooks; the owner logs in to each profile. hc-teleport runs a read-only preflight and refuses when something is missing. It never copies credentials or per-machine state: `.credentials.json`, keychain items, `sessions/<pid>.*.key`, `settings.local.json`, `session-env`, `.env`. Not taken: an `hc-teleport setup` that installs and copies configuration (it writes profiles it does not own, one step from copying credentials); dev-fleet as it stands (nothing creates the profiles today: `git grep CLAUDE_CONFIG_DIR` in dev-fleet finds nothing); a parity hook at resume (it installs into each profile, as the rejected `SessionStart` hook would).
- **Park the source after a move** (owner, 2026-11-09). Once the destination comes up, the source's uncommitted changes go to `refs/hc-teleport/<id>` and the source checkout resets to its HEAD, so one live copy remains and the way back finds a clean checkout. Not taken: the way back recognizing its own carried state (a third editor on the Mac breaks the rule); leaving the source and overwriting it on the way back (it can lose work).
- **Git travels over SSH from the Mac** (owner, 2026-11-09). `hc file` reads and writes text only and `hc exec` ends at 600 s (`hc file --help`, `hc exec --help`), so git moves its own bytes with `git push` and `git fetch` over the SSH host `hc machine` already targets, into temporary refs `refs/hc-teleport/*`. The transcript and control stay on `hc`. This bends "built on `hc` primitives" for the git leg only. Not taken: a base64 bundle through `hc exec -i` (chunking and the 600 s limit to manage).
- **Allowed flags, unknown refuses** (owner, 2026-11-09). The resume passes only flags on a known list with their arity (such as `--model`, `--permission-mode`, `--effort`, `--dangerously-skip-permissions`) and never `--resume`, `--continue` or flags that carry a Mac path. Any other flag makes the move refuse and name it. Not taken: dropping unknown flags with a warning (a lost flag changes the session); passing all but a deny list (each new CLI flag is an arity risk).
- **Defaults the session chose** (session, 2026-11-09, cheap to change): refuse when the destination's Claude Code is older than the source's; on a destination that does not come up, delete the refs and transcript written there; carry untracked non-ignored files; refuse when the repository is absent on the destination; leave `file-history`, `todos` and `plans` behind in this issue.
- **A session in a subdirectory carries its repository root** (owner, 2026-11-10). When the session's cwd lies below the repository's top level, the preflight and the git carry resolve the top level that holds the cwd, require the same top level at the same path on the destination, and carry that whole checkout; the destination resumes in the same subdirectory, because Claude Code keys the transcript to the exact cwd. Not taken: refusing with a reason that names the subdirectory (a common way to open a session would never move); keeping the refusal as `dest_repo_missing` (it names the wrong cause).

### Open questions

- **Provisioning on the other fronts.** Parity is already planned outside this repository; no new issue is needed there:
  - dev-fleet issue 0002 (open) has the `node`, `claude` and `se-configs` roles, and the last runs `./install.sh claude` on the box;
  - se-configs ADR 0041 makes that installer read the `bd`, `klock` and `pa` profiles from `harness/claude/manifest.json`, write the `claude-<name>` launchers into `~/.local/bin`, link the shared setup and register the MCP servers in each profile;
  - each Linux gap of the installer becomes its own se-configs issue (dev-fleet issue 0002);
  - the login of each profile is the owner's step.

  The real move in Acceptance waits on dev-fleet issue 0002 running on `dev-home`.
- **Upstream.** Propose `hc move <t> --to <machine>` to herdr-core once this works.

### Acceptance

- A test with two throwaway containers, each running `hc` and holding a fake Claude transcript, shows these cases:
  - a move carries the commits and the uncommitted changes exactly, binary and untracked files included, and leaves the source checkout unchanged until the destination comes up;
  - after the destination comes up, the source's uncommitted changes sit in `refs/hc-teleport/<id>` and the source checkout matches its HEAD;
  - the transcript lands under the destination's project directory with the home path rewritten;
  - the destination terminal runs the resume command with only the allowed flags, and the source terminal stops only after it;
  - each refusal case changes nothing on either side;
  - a destination that does not come up leaves no refs or transcript there, and the source still runs;
  - a move there and back restores the original state.
- A real move from the Mac to `dev-home` and back resumes the conversation. This is the owner's step, after the provisioning on the other fronts lands.

### Plan

Slices, by behavior. Each is proved through its slice's index or the CLI; S2's test bed runs every later slice's container tests.

- S1: `hc-teleport <t> <machine> --dry-run --json` prints the session plan of a Claude terminal (session id, config dir, transcript paths, resume argv) or refuses with a named reason: terminal not idle, no session id, a flag outside the allowed list | files: package.json, tsconfig.json, .nvmrc, vitest.config.ts, src/app/cli.ts, src/session/index.ts, src/session/claude-adapter.ts, src/session/resume-argv.ts, src/platform/hc.ts, src/platform/process.ts, tests/session/*.test.ts | after: none
- S2: a test bed of two containers, `source` (plays the Mac) and `dest` (plays `dev-home`), each running `hc` built from herdr-core tag v0.1.19, with git, sshd on `dest`, a fake `claude` and `claude-klock`, and `dest` added as an `hc machine` of `source`; a vitest helper starts and stops it; a smoke test runs `hc exec --on dest` and `git ls-remote` over SSH | files: tests/bed/Dockerfile, tests/bed/compose.yaml, tests/bed/fake-claude, tests/bed/bed.ts, tests/bed/bed.test.ts | after: S1 (it extends S1's package and vitest setup)
- S8: hc-teleport runs a program, reads and writes a text file on an `hc` machine, and knows the machine's SSH target, through typed `hc exec|file --on` and `hc machine ls` calls proved against the bed | files: src/platform/hc.ts, src/platform/process.ts, tests/platform/*.test.ts | after: S2
- S3: the read-only preflight on the destination refuses, changing nothing, when the repository, the wrapper, the profile directory is missing, or the destination's Claude Code is older | files: src/preflight/index.ts, src/preflight/preflight.ts, src/session/agent-adapter.ts, src/session/claude-adapter.ts, tests/preflight/*.test.ts | after: S8
- S4: git carry to the destination over SSH: commits, staged, unstaged, untracked and binary changes reach the destination checkout through `refs/hc-teleport/*`, the source checkout, index and branch stay unchanged, and a diverged or dirty destination refuses with nothing written ; a session in a subdirectory carries its repository root (the preflight's repository check follows) | files: src/git-carry/index.ts, src/git-carry/carry.ts, src/git-carry/snapshot.ts, src/platform/process.ts, tests/git-carry/*.test.ts, tests/bed/git-carry.test.ts, src/preflight/preflight.ts, tests/preflight/*.test.ts, tests/bed/preflight.test.ts | after: S8, S3
- S5: transcript carry: the transcript and its subagent directory land under the destination's project directory with the home path rewritten; the rewrite round-trips | files: src/transcript-carry/index.ts, src/transcript-carry/carry.ts, src/transcript-carry/rewrite.ts, tests/transcript-carry/*.test.ts | after: S8
- S9: the git carry can be undone on the destination (checkout, branch and refs back to what they were) and can park the source (its uncommitted changes under `refs/hc-teleport/<id>`, the checkout reset to HEAD only when it still matches what was carried) | files: src/git-carry/index.ts, src/git-carry/carry.ts, src/git-carry/park.ts, tests/git-carry/*.test.ts, tests/bed/git-carry.test.ts | after: S4
- S6: the move end to end: resume on the destination with the allowed flags, check it came up, then stop the source and park its changes in `refs/hc-teleport/<id>`; a destination that does not come up is rolled back; every refusal changes nothing on either side (combined-flow test) | files: src/move/index.ts, src/move/move.ts, src/app/cli.ts, README.md | after: S3, S4, S5, S9
- S7: the way back, started from the Mac: `dev-home` to the Mac with git fetched over SSH and the transcript read through `hc file`; a move there and back restores the original state | files: src/move/move.ts, src/git-carry/carry.ts, src/transcript-carry/carry.ts, tests/move/*.test.ts | after: S6

Choices the session made (cheap to change): no dependency beyond `typescript`, `@types/node`, `zod` (every external output is parsed), `vitest` and `fast-check`; subprocesses through `node:child_process` `execFile` with a timeout and a shared `maxBuffer`; arguments through `node:util` `parseArgs`; the test bed driven by the `docker compose` CLI, not testcontainers, to add no dependency; `hc` built from source in the bed because herdr-core publishes tags only (`gh api repos/herdrdev/herdr-core/tags`, no release); a crash mid-move leaves only named `refs/hc-teleport/*` refs, no journal; S8 was split out of S3, S4 and S5 (session, 2026-11-10) because all three need `hc exec|file --on` in `src/platform/hc.ts`, so they fan out in parallel only after it lands; the adapter gains the destination checks of S3 because the profile and version checks are agent knowledge; README changes wait for S6; S9 was split out of S6 (session, 2026-11-10) so the move's slice only orchestrates, and the git carry's index trades `removeCarriedRefs` and its outcome type for `undoGitCarry` and `parkSource` to stay at three symbols.
