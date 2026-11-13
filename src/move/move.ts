import { carryGit, parkSource, undoGitCarry } from "../git-carry/index.ts";
import { HcError, type Hc, type HcTerminal, type HcWaitOutcome } from "../platform/hc.ts";
import { HcMachine, MachineError } from "../platform/machine.ts";
import type { Runner } from "../platform/process.ts";
import type { RemoteRun } from "../session/agent-adapter.ts";
import { planSession, type SessionPlan } from "../session/index.ts";
import { preflight } from "../preflight/index.ts";
import { carryTranscript, TranscriptCarryError, TranscriptPutBackError, undoTranscriptCarry } from "../transcript-carry/index.ts";

type Carried = Extract<Awaited<ReturnType<typeof carryGit>>, { status: "carried" | "failed" }>;
type TranscriptCarried = Awaited<ReturnType<typeof carryTranscript>>;
type Parked = Awaited<ReturnType<typeof parkSource>>;

export type MoveDeps = {
  hc: Hc;
  /** Runs programs on this machine, such as git. */
  run: Runner;
  /** This machine's home directory, the one the transcript's paths are rewritten from. */
  home: string;
};

type Reason = { reason: string; detail: string };

export type MoveOutcome =
  /** The destination runs the session and the source is stopped; `parked` says whether the source checkout was reset. */
  | { status: "moved"; plan: SessionPlan; destination: string; parked: Parked }
  /** Nothing changed on either side. */
  | ({ status: "refused" } & { refusal: Reason })
  /** The destination did not come up and was put back as it was; the source was never touched. */
  | ({ status: "rolled_back" } & Reason)
  /** The destination did not come up and the rollback failed; `left` names what stays on the destination. */
  | { status: "rollback_failed"; cause: string; left: string[] }
  /** The destination runs the session but the source terminal could not be stopped, so both run. */
  | { status: "source_running"; destination: string; detail: string };

const GIT_REFUSALS: Readonly<Record<string, string>> = {
  source_detached: "the source checkout is on a detached HEAD",
  source_no_commit: "the source checkout has no commit",
  machine_without_ssh: "the destination is not reachable over ssh from this machine",
  dest_repo_missing: "the destination has no repository at the source's path",
  dest_dirty: "the destination checkout has uncommitted changes",
  dest_diverged: "the destination's branch holds commits the source does not",
};

/** A destination that did not come up, with why. */
class DidNotComeUp extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(detail);
    this.name = "DidNotComeUp";
    this.reason = reason;
  }
}

/** What the move has written on the destination so far, which a rollback takes back. */
type Written = { git: Carried; transcript?: TranscriptCarried; address?: string };

/**
 * Moves the planned session: checks everything, carries git then the transcript, resumes the session on the
 * destination and waits until it is idle there, confirms the destination registry names the session, then stops the
 * source terminal and parks the source checkout. A refusal before the first write changes nothing. A destination
 * that does not come up, or a step failing after the first write, is rolled back (destination terminal, transcript,
 * git) and never touches the source; so does a source that, read again right before it is stopped, is no longer idle.
 * Throws only for a failure before the first write.
 */
export async function moveSession(
  request: { terminal: string; machine: string; timeoutSeconds: number },
  deps: MoveDeps,
): Promise<MoveOutcome> {
  const { terminal, machine } = request;
  const planned = await planSession({ terminal, machine }, { hc: deps.hc, home: deps.home });
  if (!planned.ok) return { status: "refused", refusal: planned.refusal };
  const { plan } = planned;
  const checked = await preflight({ plan, machine }, { hc: deps.hc, run: deps.run, adapter: plan.adapter });
  if (!checked.ok) return { status: "refused", refusal: checked.refusal };

  const source = remoteSource(plan);
  const sourceHome = source === undefined ? deps.home : await new HcMachine(source, deps.hc).home();
  const git = await carryGit(
    { cwd: plan.cwd, machine, ...(source === undefined ? {} : { source }), id: plan.session.id },
    { hc: deps.hc, run: deps.run },
  );
  if (git.status === "refused") {
    return { status: "refused", refusal: { reason: git.reason, detail: GIT_REFUSALS[git.reason] ?? git.reason } };
  }

  const written: Written = { git };
  if (git.status === "failed") {
    return rollBack(written, new DidNotComeUp("git_carry_failed", `${git.step}: ${git.detail}`), deps);
  }
  let destination: string;
  try {
    destination = await comeUp(plan, { dest: checked.destination, sourceHome }, request.timeoutSeconds, written, deps);
    await requireSourceIdle(terminal, deps.hc);
  } catch (error) {
    return rollBack(written, error, deps);
  }

  try {
    await deps.hc.kill(terminal);
  } catch (error) {
    return { status: "source_running", destination, detail: messageOf(error) };
  }
  return { status: "moved", plan, destination, parked: await park(git, deps) };
}

/** The hc machine the session moves from, or nothing when it runs on the Mac. */
function remoteSource(plan: SessionPlan): string | undefined {
  return plan.source === undefined || plan.source === "local" ? undefined : plan.source;
}

const IDLE_STATES: ReadonlySet<string> = new Set(["done", "idle"]);

/** The source may have started working while the destination came up; stopping it then would lose that work. */
async function requireSourceIdle(source: string, hc: Hc): Promise<void> {
  const terminal = await hc.terminal(source);
  if (terminal.state !== "live" || terminal.exit_code !== undefined) {
    const exit = terminal.exit_code === undefined ? "" : ` with exit code ${terminal.exit_code}`;
    throw new DidNotComeUp("source_not_idle", `${source} is ${terminal.state}${exit}, not running`);
  }
  const status = terminal.status?.state;
  if (status === undefined || !IDLE_STATES.has(status)) {
    throw new DidNotComeUp("source_not_idle", `${source} reports status ${status ?? "none"}, not done or idle`);
  }
}

async function park(git: Extract<Carried, { status: "carried" }>, deps: MoveDeps): Promise<Parked> {
  try {
    return await parkSource(git, { run: deps.run, hc: deps.hc });
  } catch (error) {
    return { parked: false, reason: messageOf(error) };
  }
}

async function comeUp(
  plan: SessionPlan,
  ends: { dest: { home: string; configDir: string }; sourceHome: string },
  timeoutSeconds: number,
  written: Written,
  deps: MoveDeps,
): Promise<string> {
  const { hc } = deps;
  const { dest } = ends;
  const source = remoteSource(plan);
  // hc runs on the Mac when no machine is named, with the PATH its terminals start with; `local` is never a name it knows.
  const place = plan.machine === "local" ? {} : { on: plan.machine };
  written.transcript = await carryTranscript(
    {
      machine: plan.machine,
      ...(source === undefined ? {} : { sourceMachine: source }),
      transcript: plan.transcript,
      sourceConfigDir: plan.session.configDir,
      sourceHome: ends.sourceHome,
      destConfigDir: dest.configDir,
      destHome: dest.home,
    },
    { hc },
  );
  const deadline = Date.now() + timeoutSeconds * 1000;
  const address = await hc.run(plan.resume.argv, { ...place, cwd: plan.cwd, keep: true });
  written.address = address;
  await waitUntilStopped(hc, address, deadline);

  const remote: RemoteRun = { machine: plan.machine, run: (argv) => hc.exec(argv, place) };
  const confirmed = await plan.adapter.confirmResumed(
    await terminalWithForeground(hc, address, deadline),
    { sessionId: plan.session.id, configDir: dest.configDir },
    remote,
  );
  if (!confirmed.ok) throw new DidNotComeUp("not_resumed", `${confirmed.refusal.reason}: ${confirmed.refusal.detail}`);
  return address;
}

const FOREGROUND_POLL_MS = 250;

const NOT_UP: Readonly<Record<string, string>> = {
  blocked: "the destination terminal is blocked, waiting on a person",
  error: "the destination terminal reports an error",
  timeout: "the destination terminal was not idle before the deadline",
};

/** hc reports a terminal's foreground process a moment after the terminal reports its status, so the terminal is read until it shows one or the deadline passes. */
async function terminalWithForeground(hc: Hc, address: string, deadline: number): Promise<HcTerminal> {
  for (;;) {
    const terminal = await hc.terminal(address);
    if (terminal.foreground !== undefined || terminal.state !== "live" || Date.now() >= deadline) return terminal;
    await new Promise((resolve) => setTimeout(resolve, FOREGROUND_POLL_MS));
  }
}

async function waitUntilStopped(hc: Hc, address: string, deadline: number): Promise<void> {
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining < 1) throw new DidNotComeUp("destination_timeout", NOT_UP["timeout"] ?? "");
    const outcome: HcWaitOutcome = await hc.wait(address, { timeout: remaining });
    if (outcome.kind === "stopped") return;
    if (outcome.kind === "interrupted") continue;
    if (outcome.kind === "exited") throw new DidNotComeUp("destination_exited", exitedDetail(outcome));
    throw new DidNotComeUp(`destination_${outcome.kind}`, NOT_UP[outcome.kind] ?? outcome.kind);
  }
}

function exitedDetail(outcome: { code?: number; signal?: number }): string {
  const how = outcome.code !== undefined ? `exit code ${outcome.code}` : outcome.signal !== undefined ? `signal ${outcome.signal}` : "no exit code";
  return `the destination terminal ended before it was idle (${how})`;
}

/** Takes back what was written, destination terminal first, then the transcript, then git; a failed step does not stop the next. */
async function rollBack(written: Written, cause: unknown, deps: MoveDeps): Promise<MoveOutcome> {
  const left: string[] = [];
  const attempt = async (what: string, step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      left.push(`${what} (${messageOf(error)})`);
    }
  };
  if (written.address !== undefined) {
    const address = written.address;
    await attempt(`terminal ${address} still runs`, () => deps.hc.kill(address));
  }
  const transcriptLeftAt = left.length;
  if (written.transcript !== undefined) {
    const transcript = written.transcript;
    await attempt(`transcript files under ${transcript.destConfigDir}: ${transcript.written.join(", ")}`, () =>
      undoTranscriptCarry(transcript, { hc: deps.hc }),
    );
  }
  await attempt(`refs ${written.git.refs.join(", ")} and the carried checkout on ${written.git.machine}`, () =>
    undoGitCarry(written.git, { hc: deps.hc }),
  );

  if (cause instanceof TranscriptPutBackError) left.splice(transcriptLeftAt, 0, ...cause.left);
  const reason = describe(cause instanceof TranscriptPutBackError ? cause.cause : cause);
  if (left.length > 0) return { status: "rollback_failed", cause: `${reason.reason}: ${reason.detail}`, left };
  if (cause instanceof TranscriptCarryError) return { status: "refused", refusal: reason };
  return { status: "rolled_back", ...reason };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(cause: unknown): Reason {
  if (cause instanceof TranscriptCarryError) return { reason: cause.reason, detail: cause.message };
  if (cause instanceof DidNotComeUp) return { reason: cause.reason, detail: cause.message };
  if (cause instanceof HcError || (cause instanceof MachineError && cause.code === "exec_failed")) return { reason: "hc_failed", detail: cause.message };
  return { reason: "unexpected_error", detail: messageOf(cause) };
}
