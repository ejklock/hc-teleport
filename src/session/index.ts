import type { Hc, HcTerminal } from "../platform/hc.ts";
import type { AdapterRefusalReason, AgentAdapter } from "./agent-adapter.ts";
import { ClaudeAdapter } from "./claude-adapter.ts";

export type SessionPlan = {
  terminal: string;
  machine: string;
  cwd: string;
  session: { id: string; configDir: string; version?: string };
  transcript: { file: string; dir?: string };
  resume: { argv: readonly string[] };
  /** The adapter that recognized the terminal, for the checks that follow the plan. */
  adapter: AgentAdapter;
};

export type SessionRefusal = {
  reason:
    | AdapterRefusalReason
    | "terminal_not_running"
    | "not_idle"
    | "unknown_machine"
    | "machine_unreachable";
  detail: string;
};

type PlanResult = { ok: true; plan: SessionPlan } | { ok: false; refusal: SessionRefusal };

const IDLE_STATES: ReadonlySet<string> = new Set(["done", "idle"]);

function refused(reason: SessionRefusal["reason"], detail: string): PlanResult {
  return { ok: false, refusal: { reason, detail } };
}

function terminalRefusal(name: string, terminal: HcTerminal): PlanResult | undefined {
  if (terminal.state !== "live" || terminal.exit_code !== undefined) {
    return refused("terminal_not_running", `${name} is ${terminal.state}`);
  }
  const status = terminal.status?.state;
  if (status === undefined || !IDLE_STATES.has(status)) {
    return refused("not_idle", `${name} reports status ${status ?? "none"}, not done or idle`);
  }
  return undefined;
}

/**
 * Reads the terminal and the machine through `hc`, then works out what a move
 * would resume. It only reads: nothing is written, started or stopped. Throws
 * `HcError` when `hc` itself fails.
 */
export async function planSession(
  request: { terminal: string; machine: string },
  deps: { hc: Hc; home: string },
): Promise<PlanResult> {
  const adapters: readonly AgentAdapter[] = [new ClaudeAdapter(deps.home)];
  const terminal = await deps.hc.terminal(request.terminal);
  const unfit = terminalRefusal(request.terminal, terminal);
  if (unfit !== undefined) return unfit;

  const machine = (await deps.hc.machines()).find((m) => m.name === request.machine);
  if (machine === undefined) return refused("unknown_machine", `${request.machine} is not an hc machine`);
  if (machine.state !== "connected") {
    return refused("machine_unreachable", `${request.machine} is ${machine.state}`);
  }

  const adapter = adapters.find((candidate) => candidate.recognizes(terminal));
  if (adapter === undefined) {
    return refused("not_claude", `the foreground process of ${terminal.address} is not claude`);
  }
  const found = await adapter.findSession(terminal);
  if (!found.ok) return found;
  const resume = adapter.buildResumeArgv(terminal.argv, found.session.id);
  if (!resume.ok) return resume;

  const { id, configDir, version, transcript } = found.session;
  return {
    ok: true,
    plan: {
      terminal: request.terminal,
      machine: request.machine,
      cwd: terminal.cwd,
      session: { id, configDir, ...(version === undefined ? {} : { version }) },
      transcript,
      resume: { argv: resume.argv },
      adapter,
    },
  };
}
