---
description: Move this Claude Code session to another machine
---
Move this session to the machine named in: $ARGUMENTS

If no machine is named, ask which one, and offer the machines `hc-teleport doctor` lists.

Run `hc-teleport <machine> --detach` once with your shell tool, from this session's own terminal. Add `--wait <seconds>` only if the person asks for a longer wait for the session to go idle.

Then end the turn at once. The move starts only when this session is idle, so never wait, poll or run `hc-teleport status` in this turn.

If the command refuses, tell the person and stop:

- `not_initialized`: run `hc-teleport init` in a terminal (the wizard is interactive), then try again.
- `machine_not_allowed`: the machine, named in the message, is not allowed; run `hc-teleport init` in a terminal to allow it.
- `move_in_progress`: a move of this session is already running; see `hc-teleport status`.
- `not_in_a_terminal`: this session does not run in an hc terminal.
- `not_claude`: only Claude Code sessions move today, and this agent's sessions cannot move yet.
