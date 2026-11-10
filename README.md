# hc-teleport

Moves a coding-agent session that runs in a herdr-core (`hc`) terminal from the Mac to another `hc` machine. The design and plan live in `docs/issues/0001-move-a-claude-code-session-between-the-mac-and-dev-home-from-an-hc-terminal.md`.

Today the tool only plans: `--dry-run` reads the terminal and prints what a move would resume. It writes nothing, starts nothing and stops nothing.

## Usage

```
hc-teleport <terminal> <machine> --dry-run [--json]
```

Run it on the Mac. `<terminal>` is an `hc` terminal address such as `t6c`; `<machine>` is a name from `hc machine ls`. It needs Node 26 (`.nvmrc`) and `hc` on the PATH.

The session is found from the terminal itself. For Claude Code, the config directory comes from `<launcher> --where` (a plain `claude` uses `~/.claude`), and `<configDir>/sessions/<foreground pid>.json` names the session id. That file is internal to Claude Code and undocumented, so an unknown shape refuses.

The resume command is the terminal's executable (for example `claude-klock`), then its allowed flags in their order, then `--resume <id>`. Positional arguments and session selectors (`--resume`/`-r`, `--continue`/`-c`, `--session-id`, `--fork-session`) are dropped. Allowed flags:

- with one value: `--model`, `--permission-mode`, `--effort`, `--fallback-model`, `--agent`, `--name`/`-n` (`--flag value` and `--flag=value`);
- with none: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--brief`, `--chrome`, `--no-chrome`, `--verbose`.

Any other flag refuses and is named.

## Output

Without `--json` the plan prints readably on stdout. With `--json` stdout holds exactly one JSON object; messages always go to stderr.

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

`session.version` is left out when the registry does not carry it. `transcript.dir` is the sibling `<sessionId>/` directory (it holds `subagents/`), or `null` when the session has none.

A refusal prints `{"refused":{"reason":"...","detail":"..."}}` on stdout under `--json` and a readable line on stderr otherwise. A failure of `hc` prints `{"error":{"reason":"hc_failed","detail":"..."}}` under `--json`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The plan was printed. |
| 1 | `hc` failed, timed out or printed output that is not the expected JSON (`hc_failed`). |
| 2 | Wrong invocation: missing or extra arguments, an unknown option, or no `--dry-run`. |
| 3 | Refused, nothing changed. |

## Refusal reasons (exit 3)

| Reason | When |
|---|---|
| `terminal_not_running` | The terminal is not live or has exited. |
| `not_idle` | The terminal's status state is not `done` or `idle`, or it has no status. |
| `unknown_machine` | The machine is not in `hc machine ls`. |
| `machine_unreachable` | The machine is listed but not connected. |
| `not_claude` | The terminal's foreground process is not `claude`. |
| `config_dir_unknown` | `<launcher> --where` failed or did not print an absolute path. |
| `no_session` | The pid registry file does not exist. |
| `session_registry_unreadable` | The registry file is malformed or lacks `sessionId` (a UUID), `pid` or `cwd`. |
| `session_registry_stale` | The registry's pid or cwd differs from the terminal's foreground process. |
| `flag_not_allowed` | The source argv carries a flag outside the allowed list; the detail names it. |
| `flag_missing_value` | An allowed flag that needs a value is the last token; the detail names it. |

## Development

```
npm test            # vitest; add a name to filter, e.g. npm test -- resume-argv
npm run typecheck
npm run build
```

Tests build their own temporary HOME and put a fake `hc` and a fake launcher first on the PATH; they never touch the real `hc` or `~/.claude*`.
