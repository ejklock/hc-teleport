---
type: Research
title: Existing tools that move a coding agent session between machines
description: No tool moves a session that runs in an hc terminal; hopsesh and Sheprd come closest.
status: Draft
timestamp: 2026-11-10T02:48:33Z
---

# 0001. Existing tools that move a coding agent session between machines

Question: before writing our own, is there a tool that moves a coding-agent session that runs in a herdr-core (`hc`) terminal from the Mac to `dev-home` and back?

Answer, 2026-11-09: no. Every tool that moves a session ends the process and resumes the agent's own session on the other machine. None of them works on `hc` terminals.

### Findings

- **Claude Code.** `claude --teleport` only pulls a session from Claude Code on the web into a local terminal. There is an open request to make it two-way: [anthropics/claude-code#14666](https://github.com/anthropics/claude-code/issues/14666).
  - A session is one `.jsonl` file under `~/.claude/projects/<cwd with every non-alphanumeric character as ->/`. The format is internal and changes between versions.
  - Sources: [codonic.dev guide](https://codonic.dev/guides/move-claude-code-session-to-another-computer), [enjoy.dev, 9 ways compared](https://enjoy.dev/blog/claude-code-codex-another-computer/).
- **herdr-core (`hc` 0.1.19).** `hc machine add` and `hc run --on <machine>` run a program on another machine and come back to it ([docs/machines.md](https://github.com/herdrdev/herdr-core)). It cannot move a terminal, and the repository has no issue about doing so.
  - Primitives we checked locally:
    - `hc get <t> --json`, which gives argv and cwd;
    - `hc wait`, `hc label`, `hc kill`;
    - `hc exec|file|put --on`;
    - `hc events`;
    - the `HC_TERMINAL_ID` variable inside each terminal.
  - Command that showed them: `hc --help`.
  - There is no plugin system and no external subcommands: `hc list` fails with "unrecognized subcommand".
- **herdr (Herdr 1).**
  - `pane move` only works within one server ([socket API](https://herdr.dev/tui/docs/socket-api/)).
  - `--handoff` replaces the server process but keeps the panes running ([session state](https://herdr.dev/tui/docs/session-state/)).
  - Moving panes across machines is a stated non-goal: [herdr discussion #515](https://github.com/herdrdev/herdr/discussions/515).
- **Sheprd** (native herdr client, Apache-2.0, release 2026-11-08). Its Teleport moves a Herdr 1 linked worktree to an SSH host, using the `herdr` CLI ([PR #168](https://github.com/sheprd-labs/sheprd/pull/168)). It carries:
  - commits, plus uncommitted work as temporary commits built through a temporary index;
  - tabs;
  - agent sessions (Claude, Codex, opencode, pi), with paths rewritten.

  It shows herdr-core terminals, but herdr-core has no worktree concept, and its worktree features ignore Herdr 2 tabs ([sheprd#1018](https://github.com/sheprd-labs/sheprd/issues/1018), [sheprd#1009](https://github.com/sheprd-labs/sheprd/issues/1009)). Inference, not tested: Teleport does not carry `hc` terminals.
- **hopsesh** ([roeehrl/hopsesh](https://github.com/roeehrl/hopsesh), Apache-2.0, alpha, v0.8.0 of 2026-11-03).
  - It moves a Claude or Codex transcript over SSH or Tailscale, rewrites paths, brings the repository to the session's commit, and offers `undo`.
  - Uncommitted files stay on the source machine.
  - It is pulled from the destination machine.
- **Cloud tools, rejected because code and possible secrets would go to a third party:**
  - CodeTeleport ([discussion](https://github.com/anthropics/claude-code-action/discussions/1150)), hosted;
  - claude-sync ([tawanorg/claude-sync](https://github.com/tawanorg/claude-sync)), Cloudflare R2.
- **Tailscale.** Taildrop resumes file transfers, not sessions. Tailscale SSH and Aperture give access to machines, not session moves ([changelog](https://tailscale.com/changelog)).

### Confidence

The findings come from documentation, pull requests and repositories; no tool was run. The Sheprd and herdr-core points were checked against their READMEs and issues through `gh`. The rest relies on web search summaries.
