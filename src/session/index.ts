import type { Hc, HcMachine as HcListedMachine, HcTerminal } from "../platform/hc.ts";
import { HcMachine, LocalMachine, type Machine } from "../platform/machine.ts";
import type { AdapterRefusalReason, AgentAdapter, AgentSession, ResumeArgvResult } from "./agent-adapter.ts";
import { ClaudeAdapter } from "./claude-adapter.ts";

export type SessionPlan = {
  terminal: string;
  /** The machine the session runs on, `local` for the Mac; a plan that leaves it out is a Mac source. */
  source?: string;
  /** The machine the session would move to; `local` is the Mac. */
  machine: string;
  cwd: string;
  session: { id: string; configDir: string; version?: string };
  transcript: { file: string; dir?: string };
  resume: { argv: readonly string[] };
  /** True when both machines see the transcript file as one file-system object, so a move needs no carry. */
  relocate: boolean;
  /** The adapter that recognized the terminal, for the checks that follow the plan. */
  adapter: AgentAdapter;
};

export type SessionRefusal = {
  reason:
    | AdapterRefusalReason
    | "terminal_not_running"
    | "not_idle"
    | "unknown_machine"
    | "machine_unreachable"
    | "same_machine"
    | "mac_not_an_end"
    | "local_name_taken";
  detail: string;
};

type PlanResult = { ok: true; plan: SessionPlan } | { ok: false; refusal: SessionRefusal };

const IDLE_STATES: ReadonlySet<string> = new Set(["done", "idle"]);

/** The name that stands for the Mac, which `hc machine ls` never lists. */
const MAC = "local";

/** This host with the home the caller gives, so the plan reads the same home the rest of the move uses. */
class MacMachine extends LocalMachine {
  readonly #home: string;

  constructor(home: string) {
    super();
    this.#home = home;
  }

  override home(): Promise<string> {
    return Promise.resolve(this.#home);
  }
}

/** The machine a terminal address names: `tN` is the Mac, `<machine>/tN` an hc machine; anything else is malformed. */
function sourceOf(address: string): string | undefined {
  const parts = address.split("/");
  if (parts.length > 2 || parts.some((part) => part === "")) return undefined;
  if (parts.length === 1) return MAC;
  return parts[0] === MAC ? undefined : parts[0];
}

/** The machine to read the session on: this host for the Mac, else the hc machine of that name. */
function machineNamed(name: string, deps: { hc: Hc; home: string; machines?: (name: string) => Machine }): Machine {
  if (name === MAC) return new MacMachine(deps.home);
  return deps.machines === undefined ? new HcMachine(name, deps.hc) : deps.machines(name);
}

function endRefusal(name: string, listed: readonly HcListedMachine[]): PlanResult | undefined {
  if (name === MAC) return undefined;
  const machine = listed.find((candidate) => candidate.name === name);
  if (machine === undefined) return refused("unknown_machine", `${name} is not an hc machine`);
  if (machine.state !== "connected") return refused("machine_unreachable", `${name} is ${machine.state}`);
  return undefined;
}

function endsRefusal(source: string, destination: string, listed: readonly HcListedMachine[]): PlanResult | undefined {
  if (listed.some((machine) => machine.name === MAC)) {
    return refused("local_name_taken", `hc lists a machine named ${MAC}, which hc-teleport reserves for the Mac`);
  }
  if (source === destination) return refused("same_machine", `${source} is both the source and the destination`);
  return endRefusal(source, listed) ?? endRefusal(destination, listed);
}

const DEVICE_AND_INODE = /^\d+:\d+\n$/;

/** What a machine reports for a file as `<device>:<inode>`, or nothing when it cannot say. */
async function identityOn(machine: Machine, file: string): Promise<string | undefined> {
  try {
    const printed = await machine.exec(["stat", "-c", "%d:%i", "--", file]);
    return printed.code === 0 && DEVICE_AND_INODE.test(printed.stdout) ? printed.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** True when both machines print the same device and inode for the file: one disk, so the file needs no copy. */
async function sharesDisk(source: Machine, destination: Machine, file: string): Promise<boolean> {
  const [from, to] = await Promise.all([identityOn(source, file), identityOn(destination, file)]);
  return from !== undefined && from === to;
}

/** A move with the Mac at neither end is only allowed when the two machines share the session's disk. */
function diskRefusal(source: string, destination: string, relocate: boolean): PlanResult | undefined {
  if (relocate || source === MAC || destination === MAC) return undefined;
  return refused("mac_not_an_end", `${source} to ${destination} has the Mac at neither end and the two do not share the session's disk`);
}

function refused(reason: SessionRefusal["reason"], detail: string): PlanResult {
  return { ok: false, refusal: { reason, detail } };
}

function terminalRefusal(name: string, terminal: HcTerminal, requireIdle: boolean): PlanResult | undefined {
  if (terminal.state !== "live" || terminal.exit_code !== undefined) {
    return refused("terminal_not_running", `${name} is ${terminal.state}`);
  }
  if (!requireIdle) return undefined;
  const status = terminal.status?.state;
  if (status === undefined || !IDLE_STATES.has(status)) {
    return refused("not_idle", `${name} reports status ${status ?? "none"}, not done or idle`);
  }
  return undefined;
}

/**
 * The resume command: from the agent's own launch record when the session has one, run through `env`
 * so the config directory survives a wrapper that only exported it; else from the terminal's argv.
 */
function resumeOf(adapter: AgentAdapter, terminal: HcTerminal, session: AgentSession): ResumeArgvResult {
  if (session.launch === undefined) return adapter.buildResumeArgv(terminal.argv, session.id);
  const resume = adapter.buildResumeArgv([session.launch.bin, ...session.launch.flags], session.id);
  if (!resume.ok) return resume;
  return { ok: true, argv: ["env", `CLAUDE_CONFIG_DIR=${session.configDir}`, ...resume.argv] };
}

/**
 * Reads the terminal and the machines through `hc`, then works out what a move
 * would resume. The terminal address names the source (`tN` the Mac, `<machine>/tN`
 * an hc machine) and the session is read on it; `request.machine` is the
 * destination, where `local` names the Mac. A move needs the Mac at one end unless both machines see the transcript as one file (`relocate`).
 * `deps.home` is the Mac's home; `deps.machines` opens an hc machine by name and
 * defaults to `hc` itself. `deps.requireIdle` (default true) set to false skips only the refusal of a source that is
 * working, for a session that plans its own move while it runs the command. It only reads: nothing is written, started or stopped.
 * Throws `HcError` when `hc` itself fails.
 */
export async function planSession(
  request: { terminal: string; machine: string },
  deps: { hc: Hc; home: string; machines?: (name: string) => Machine; requireIdle?: boolean },
): Promise<PlanResult> {
  const source = sourceOf(request.terminal);
  if (source === undefined) {
    return refused("terminal_not_running", `${JSON.stringify(request.terminal)} is not a terminal address: use tN or <machine>/tN`);
  }
  const terminal = await deps.hc.terminal(request.terminal);
  const unfit = terminalRefusal(request.terminal, terminal, deps.requireIdle ?? true);
  if (unfit !== undefined) return unfit;

  const badEnds = endsRefusal(source, request.machine, await deps.hc.machines());
  if (badEnds !== undefined) return badEnds;

  const adapters: readonly AgentAdapter[] = [new ClaudeAdapter(machineNamed(source, deps))];
  const adapter = adapters.find((candidate) => candidate.recognizes(terminal));
  if (adapter === undefined) {
    return refused("not_claude", `the foreground process of ${terminal.address} is not claude`);
  }
  const found = await adapter.findSession(terminal);
  if (!found.ok) return found;
  const resume = resumeOf(adapter, terminal, found.session);
  if (!resume.ok) return resume;

  const { id, configDir, version, transcript } = found.session;
  const relocate = await sharesDisk(machineNamed(source, deps), machineNamed(request.machine, deps), transcript.file);
  const apart = diskRefusal(source, request.machine, relocate);
  if (apart !== undefined) return apart;
  return {
    ok: true,
    plan: {
      terminal: request.terminal,
      source,
      machine: request.machine,
      cwd: terminal.cwd,
      session: { id, configDir, ...(version === undefined ? {} : { version }) },
      transcript,
      resume: { argv: resume.argv },
      relocate,
      adapter,
    },
  };
}
