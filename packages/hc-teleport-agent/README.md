# hc-teleport-agent

Gives OpenCode and Pi a `/hc-teleport <machine>` command and the `hc-teleport` skill. Both tell the agent to run `hc-teleport <machine> --detach` once and end its turn, so the session moves once it is idle. The CLI moves only Claude Code sessions today: for any other agent it refuses with `not_claude`, and the agent tells the person its sessions cannot move yet. The `hc-teleport` CLI must be installed on the machine; see https://github.com/ejklock/hc-teleport.

## OpenCode

Add the package to `opencode.json`:

```json
{ "plugin": ["hc-teleport-agent"] }
```

Its `config` hook adds the skill and the `hc-teleport` command. An `hc-teleport` command you define yourself wins.

## Pi

```
pi install npm:hc-teleport-agent
```

Pi then loads the `hc-teleport` skill and the `/hc-teleport` prompt template.
