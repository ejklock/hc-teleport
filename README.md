# hc-teleport

Moves a coding-agent session that runs in a herdr-core (`hc`) terminal from the Mac to another `hc` machine. It also moves a session back, from an `hc` machine to the Mac. The design and plan live in `docs/issues/0001-move-a-claude-code-session-between-the-mac-and-dev-home-from-an-hc-terminal.md`.

`hc-teleport <terminal> <machine>` moves the session. In order it plans, checks the destination (preflight), carries the git checkout, carries the transcript, resumes the session in a new terminal on the destination and waits until it is idle there, confirms the destination's session registry names the session, then stops the source terminal and parks the source checkout. A refusal before the first write changes nothing on either side; a destination that does not come up is rolled back and the source is never touched. `--dry-run` only plans: it reads the terminal and prints what a move would resume, and writes nothing, starts nothing and stops nothing.

## Usage

```
hc-teleport <terminal> <machine> [--dry-run] [--timeout <seconds>] [--json]
```

`--timeout` is how long the move waits for the resumed session to be idle on the destination: a whole number of seconds from 1 to 600, 120 by default. Run it on the Mac. `<terminal>` is an `hc` terminal address: `t6c` for a terminal on the Mac, `dev-home/t6c` for one on the `hc` machine `dev-home`. `<machine>` is the destination: a name from `hc machine ls`, or `local` for the Mac, which `hc machine ls` never lists. A move has the Mac at exactly one end, so `hc-teleport dev-home/t6c local` is the way back: it reads the session on `dev-home` through `hc`, carries git and the transcript to the Mac, resumes the session in a new terminal on the Mac, then stops the terminal on `dev-home` and parks its checkout there; with `--dry-run` it only plans that. It needs Node 26 (`.nvmrc`) and `hc` on the PATH.

The session is found from the terminal itself. For Claude Code, the config directory comes from `<launcher> --where` (a plain `claude` uses `~/.claude`), and `<configDir>/sessions/<foreground pid>.json` names the session id. That file is internal to Claude Code and undocumented, so an unknown shape refuses.

The resume command is the terminal's executable (for example `claude-klock`), then its allowed flags in their order, then `--resume <id>`. Positional arguments and session selectors (`--resume`/`-r`, `--continue`/`-c`, `--session-id`, `--fork-session`) are dropped. Allowed flags:

- with one value: `--model`, `--permission-mode`, `--effort`, `--fallback-model`, `--agent`, `--name`/`-n` (`--flag value` and `--flag=value`);
- with none: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--brief`, `--chrome`, `--no-chrome`, `--verbose`.

Any other flag refuses and is named.

## Output

Without `--json` the plan (`--dry-run`) or a line naming the destination terminal (a move) prints readably on stdout. With `--json` stdout holds exactly one JSON object; messages always go to stderr. This is the `--dry-run` output:

```json
{
  "terminal": "t6c",
  "machine": "dev-home",
  "cwd": "/Volumes/Developer/www/klock-tecnologia/hc-teleport",
  "session": { "id": "09e11b42-f5c1-4c38-99f1-dd1d8b00355c", "configDir": "/Users/me/.claude-klock", "version": "2.1.321" },
  "transcript": { "file": "/Users/me/.claude-klock/projects/-Volumes-...-hc-teleport/09e11b42-....jsonl", "dir": null },
  "resume": { "argv": ["claude-klock", "--model", "opus", "--resume", "09e11b42-f5c1-4c38-99f1-dd1d8b00355c"] }
}
```

A session on an `hc` machine adds `"source": "dev-home"` (the machine it runs on) to this object; a session on the Mac prints without it, and `machine` is always the destination. The config directory, registry and transcript paths are read on the source. `session.version` is left out when the registry does not carry it. `transcript.dir` is the sibling `<sessionId>/` directory (it holds `subagents/`), or `null` when the session has none.

A move that succeeds prints, under `--json`:

```json
{ "moved": { "terminal": "t6c", "machine": "dev-home", "session": "09e11b42-f5c1-4c38-99f1-dd1d8b00355c", "destination": "dev-home/t7", "parked": { "parked": true } } }
```

`parked` is `{"parked":false,"reason":"..."}` when the source checkout was left as it is (it changed since the carry); the move still succeeded and the reason is on stderr. When parked, the source checkout is reset to HEAD (ignored files stay) and its uncommitted changes are kept under those refs.

A refusal prints `{"refused":{"reason":"...","detail":"..."}}` on stdout under `--json` and a readable line on stderr otherwise. A rolled back move prints `{"rolledBack":{"reason":"...","detail":"..."}}`. Any other failure prints `{"error":{"reason":"...","detail":"..."}}`: `hc_failed` when `hc` failed, timed out or printed output that is not the expected JSON, `command_failed` when a local program such as git failed before anything was written, `unexpected_error` (a failure none of the above names, with its message; before the first write nothing changed), `rollback_failed` (also with `cause` and a `left` list naming the destination terminal, files and refs still there) and `source_running` (also with `destination`).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The session was moved (or, with `--dry-run`, the plan was printed). A source checkout that could not be parked still exits 0. |
| 1 | `hc` failed, timed out or printed output that is not the expected JSON (`hc_failed`); a local program failed before anything was written (`command_failed`); an unexpected error before anything was written (`unexpected_error`); the rollback itself failed and the error names what is left on the destination (`rollback_failed`); or the destination is confirmed but the source terminal could not be stopped, so both run and nothing is rolled back (`source_running`). |
| 2 | Wrong invocation: missing or extra arguments, an unknown option, or a `--timeout` that is not a whole number from 1 to 600. |
| 3 | Refused, nothing changed on either side. |
| 4 | Rolled back: the destination did not come up, or a step after the first write failed. The destination is as before and the source was not touched. |

## Refusal reasons (exit 3)

| Reason | When |
|---|---|
| `terminal_not_running` | The terminal is not live or has exited, or the address is not `tN` or `<machine>/tN`. |
| `not_idle` | The terminal's status state is not `done` or `idle`, or it has no status. |
| `unknown_machine` | The source or the destination machine is not in `hc machine ls`. |
| `machine_unreachable` | The source or the destination machine is listed but not connected. |
| `same_machine` | The terminal runs on the machine it would move to (`t6c local`, `dev-home/t6c dev-home`). |
| `mac_not_an_end` | Neither end is the Mac (`dev-home/t6c vps`); a move goes between the Mac and one `hc` machine. |
| `local_name_taken` | `hc machine ls` lists a machine named `local`, the name hc-teleport uses for the Mac; rename it with `hc machine rename`. |
| `not_claude` | The terminal's foreground process is not `claude`. |
| `config_dir_unknown` | `<launcher> --where` failed or did not print an absolute path. |
| `no_session` | The pid registry file does not exist. |
| `session_registry_unreadable` | The registry file is malformed or lacks `sessionId` (a UUID), `pid` or `cwd`. |
| `session_unreadable` | The source machine cannot read the session's subagent folder (a permission error, or a failed `find` on a machine); the detail names the folder. |
| `session_registry_stale` | The registry's pid or cwd differs from the terminal's foreground process. |
| `flag_not_allowed` | The source argv carries a flag outside the allowed list; the detail names it. |
| `flag_missing_value` | An allowed flag that needs a value is the last token; the detail names it. |

The move adds these refusals, each exit 3 with nothing changed (a transcript refusal is raised after the git carry was written, which is then undone first):

| Reason | When |
|---|---|
| `dest_executable_missing`, `dest_profile_missing`, `dest_agent_older`, `dest_agent_version_unknown` | The destination cannot run the resume command, lacks the agent's profile directory, or has an older or unreadable agent version. |
| `dest_repo_missing` | The destination has no git work tree at the session folder's repository, or its top level differs from the source's. |
| `source_detached`, `source_no_commit` | The source checkout is on a detached HEAD or has no commit. |
| `machine_without_ssh` | The destination is not reachable over ssh from this machine, which the git carry needs. |
| `dest_dirty` | The destination checkout has uncommitted changes. |
| `dest_diverged` | The destination's branch holds commits the source's does not. |
| `transcript_outside_config`, `transcript_not_text`, `transcript_line_too_long`, `transcript_missing` | The transcript cannot be carried: it lies outside the config directory, is not text, has a line over the carry's limit, or does not exist. |

## Rollback reasons (exit 4)

A rolled back move puts the destination back as it was before the move: it ends the destination terminal if one was started, removes the transcript files it placed (restoring any it replaced), then undoes the git carry and deletes the refs. Each step is tried even if an earlier one failed; if any step failed the exit is 1 (`rollback_failed`) and names what is left.

| Reason | When |
|---|---|
| `git_carry_failed` | A destination step of the git carry failed after its push; the detail names the step. |
| `hc_failed` | `hc` failed while starting, waiting for or reading the destination terminal, or while carrying the transcript. |
| `destination_blocked` | The destination terminal reports `blocked`. |
| `destination_error` | The destination terminal reports `error`. |
| `destination_exited` | The destination terminal ended before it was idle; the detail has the exit code or signal. |
| `destination_timeout` | The destination terminal was not idle before the `--timeout` deadline. |
| `source_not_idle` | The destination is confirmed, but the source terminal, read again right before it would be stopped, is no longer live or no longer `idle` or `done`; the source is left running and the detail names the state read. |
| `unexpected_error` | Any other error after the first write, such as a file permission error while carrying the transcript; the detail is its message. |
| `not_resumed` | The terminal is idle but the destination does not confirm the session; the detail is the check's reason: `terminal_not_running`, `not_claude`, `no_session`, `session_registry_unreadable`, `session_registry_stale` or `session_mismatch`. |

## Development

```
npm test            # vitest; add a name to filter, e.g. npm test -- resume-argv
npm run typecheck
npm run build
npm run lint        # eslint with the typed config
npm run coverage    # vitest with coverage into coverage/lcov.info, then the se-gates coverage receipt
```

Tests build their own temporary HOME and put a fake `hc` and a fake launcher first on the PATH; they never touch the real `hc` or `~/.claude*`.

## Tests

`npm test` runs the unit and CLI suites against fakes. It needs no Docker and finishes in seconds.

`npm run test:bed` runs the container bed. It needs a running Docker daemon with `docker compose` and `ssh-keygen`, and fails with a message naming Docker when the daemon is down. The bed builds `hc` 0.1.19 from source on the first run (several minutes), then reuses the image. It starts two throwaway containers, `source` (plays the Mac, home `/Users/mac`) and `dest` (plays dev-home, home `/home/box`), adds `dest` to `source` as an `hc` machine over SSH with a key pair generated per run under `$TMPDIR`, and removes the containers, network, volumes and key afterwards. It touches nothing else on the host. A bed that cannot start fails with the command that failed; the whole start has a 12 minute budget, shorter than the 15 minute hook timeout, so a slow start reports the step that ran out of time instead of a bare test timeout. `docker compose up --wait` is bounded by compose's own `--wait-timeout`, computed from what is left of the budget; every bed process is also killed with SIGKILL when its step time is up, since compose ignores SIGTERM while it waits. Compose sometimes exits 0 when that wait timeout runs out, so after `up` returns the bed also reads both services' health and fails the start naming `up` when either is not healthy. A failed start tears itself down and checks for leftovers even when the first teardown failed.
