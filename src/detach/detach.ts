import { HcError, type Hc } from "../platform/hc.ts";
import type { MoveOutcome } from "../move/index.ts";
import { isFinal, listStates, readState, writeState, type DetachedState, type Phase, type StoredOutcome } from "./state.ts";

/** What the runner asks of hc: wait on the source, look at it, and type into it. */
export type RunnerHc = Pick<Hc, "wait" | "send" | "terminal">;
/** What the start asks of hc: list the machines and start the runner. */
export type StarterHc = Pick<Hc, "run" | "machines">;

type Reason = { reason: string; detail: string };
type Env = Readonly<Record<string, string | undefined>>;

const MAX_WAIT_SLICE_S = 600;
/** The reasons a move gives when the source was working again right before it was stopped. */
const WORKING_AGAIN: ReadonlySet<string> = new Set(["not_idle", "source_not_idle"]);

export type SourceAddress = { ok: true; source: string; hcSession?: string } | { ok: false };

/** The terminal this process runs in: `HC_TERMINAL_ID`, prefixed with `HC_SESSION/` on an hc machine. */
export function sourceAddress(env: Env): SourceAddress {
  const id = env["HC_TERMINAL_ID"];
  if (id === undefined || id === "") return { ok: false };
  const session = env["HC_SESSION"];
  if (session === undefined || session === "") return { ok: true, source: id };
  return { ok: true, source: `${session}/${id}`, hcSession: session };
}

export type StartRequest = { source: string; hcSession?: string; machine: string; waitSeconds: number; timeoutSeconds: number };

export type StartDeps = {
  hc: StarterHc;
  /** Plans the move as a dry run would and names the session, or says why not. */
  plan: (terminal: string, machine: string) => Promise<{ ok: true; session: string } | { ok: false; refusal: Reason }>;
  path: (session: string) => string;
  /** The program and arguments that run this CLI, which the runner repeats with its own flag. */
  entry: readonly string[];
  now: () => number;
};

export type StartResult = { status: "started"; runner: string; source: string; machine: string; state: string; startedAt: number } | { status: "refused"; refusal: Reason };

/** The runner's hc name: hc keeps a live terminal's name unique, so it is the session's lock, freed when the runner ends. */
function runnerName(session: string): string {
  return `hct-${session.replaceAll("-", "").slice(0, 28)}`;
}

/**
 * Starts the runner on the core under the session's name, without waiting for it. hc refuses that name while an
 * earlier runner lives, which refuses `move_in_progress`; the runner's end frees it. A source on an hc machine must
 * be named by a machine the core lists, or the runner could not reach it. The move's parameters travel as the
 * runner's arguments and the start never touches the state file: only the runner that holds the name writes it, so a
 * start that loses the name cannot disturb the winner's file. Throws `HcError` when hc cannot start the runner for
 * another reason.
 */
export async function startDetached(request: StartRequest, deps: StartDeps): Promise<StartResult> {
  const { source, hcSession, machine } = request;
  if (hcSession !== undefined && !(await deps.hc.machines()).some(({ name }) => name === hcSession)) {
    return refused("core_unreachable", `${hcSession} is not an hc machine of the core this process reaches, so the runner could not reach ${source}`);
  }
  const planned = await deps.plan(source, machine);
  if (!planned.ok) return { status: "refused", refusal: planned.refusal };

  const path = deps.path(planned.session);
  const before = await readState(path);
  if (before.kind === "unreadable" && before.missing !== true) {
    return refused("state_unreadable", `${path} cannot be used: ${before.detail}; remove it if no detached move runs`);
  }
  const startedAt = deps.now();
  const argv = [
    ...deps.entry,
    "--run-detached", path,
    "--session", planned.session,
    "--source", source,
    "--to", machine,
    "--wait", String(request.waitSeconds),
    "--timeout", String(request.timeoutSeconds),
    "--started-at", String(startedAt),
  ];
  const name = runnerName(planned.session);
  let runner: string;
  try {
    runner = await deps.hc.run(argv, { name });
  } catch (error) {
    if (error instanceof HcError && error.kind === "name_taken") {
      return refused("move_in_progress", `a detached move of session ${planned.session} is already running as ${name}; see hc-teleport status`);
    }
    throw error;
  }
  return { status: "started", runner, source, machine, state: path, startedAt };
}

function refused(reason: string, detail: string): StartResult {
  return { status: "refused", refusal: { reason, detail } };
}

/** The move the runner was started for, which it records as its first state. */
export type RunStart = Pick<DetachedState, "session" | "source" | "machine" | "waitSeconds" | "timeoutSeconds" | "startedAt">;

export type RunDeps = {
  hc: RunnerHc;
  start: RunStart;
  /** The runner's own terminal address, recorded in every write. */
  runner?: string;
  move: (request: { terminal: string; machine: string; timeoutSeconds: number }) => Promise<MoveOutcome>;
  now: () => number;
};

type Ended = { phase: Phase; outcome: StoredOutcome };

/**
 * The runner: waits for the source to be idle, moves the session and records each step in the state file. A source
 * that works again before it is stopped sends it back to waiting. The final write is the file's last: a
 * move that did not complete is typed into the session that still runs first, so that write carries any send failure. Resolves with the final state.
 */
export async function runDetached(path: string, deps: RunDeps): Promise<DetachedState> {
  const state: DetachedState = { v: 1, ...deps.start, phase: "waiting", ...(deps.runner === undefined ? {} : { runner: deps.runner }) };
  await writeState(path, state);
  let ended: Ended;
  try {
    ended = await drive(path, state, deps);
  } catch (error) {
    ended = { phase: "refused", outcome: { reason: "runner_failed", detail: error instanceof Error ? error.message : String(error) } };
  }
  const ready: DetachedState = { ...state, ...ended };
  const sendError = await tellSource(ready, deps.hc);
  const final: DetachedState = sendError === undefined ? ready : { ...ready, sendError };
  await writeState(path, final);
  return final;
}

async function drive(path: string, state: DetachedState, deps: RunDeps): Promise<Ended> {
  const deadline = state.startedAt + state.waitSeconds * 1000;
  for (;;) {
    const waited = await waitForIdle(state, deadline, deps);
    if (waited !== undefined) return waited;
    await writeState(path, { ...state, phase: "moving" });
    const outcome = await deps.move({ terminal: state.source, machine: state.machine, timeoutSeconds: state.timeoutSeconds });
    if (!worksAgain(outcome)) return describe(outcome);
    await writeState(path, { ...state, phase: "waiting" });
  }
}

/** Waits in slices of at most 600 s until the source is idle, resolving nothing then, or with why the move cannot go on. */
async function waitForIdle(state: DetachedState, deadline: number, deps: RunDeps): Promise<Ended | undefined> {
  for (;;) {
    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) {
      return { phase: "timeout", outcome: { reason: "wait_timeout", detail: `${state.source} was not idle within ${String(state.waitSeconds)} s` } };
    }
    const slice = Math.min(MAX_WAIT_SLICE_S, Math.max(1, Math.ceil(remainingMs / 1000)));
    const waited = await deps.hc.wait(state.source, { timeout: slice });
    switch (waited.kind) {
      case "stopped":
        return undefined;
      case "timeout":
      case "interrupted":
        break;
      case "exited":
        return { phase: "refused", outcome: { reason: "source_gone", detail: `${state.source} ended while the move waited for it` } };
      case "blocked":
      case "error":
        return { phase: "refused", outcome: { reason: "source_not_idle", detail: `${state.source} reports ${waited.kind}, not done or idle` } };
    }
  }
}

function worksAgain(outcome: MoveOutcome): boolean {
  if (outcome.status === "refused") return WORKING_AGAIN.has(outcome.refusal.reason);
  return outcome.status === "rolled_back" && outcome.resumedAt === undefined && WORKING_AGAIN.has(outcome.reason);
}

function describe(outcome: MoveOutcome): Ended {
  switch (outcome.status) {
    case "moved":
      return { phase: "moved", outcome: { destination: outcome.destination } };
    case "refused":
      return { phase: "refused", outcome: { reason: outcome.refusal.reason, detail: outcome.refusal.detail } };
    case "rolled_back":
      return {
        phase: "rolled_back",
        outcome: { reason: outcome.reason, detail: outcome.detail, ...(outcome.resumedAt === undefined ? {} : { resumedAt: outcome.resumedAt }) },
      };
    case "rollback_failed":
      return {
        phase: "rollback_failed",
        outcome: { reason: "rollback_failed", detail: `${outcome.cause}; ${outcome.relocated === true ? "left" : "left on the destination"}: ${outcome.left.join("; ")}` },
      };
    case "source_not_stopped":
      return { phase: "source_not_stopped", outcome: { reason: "source_not_stopped", detail: outcome.detail } };
    case "source_running":
      return { phase: "source_running", outcome: { reason: "source_running", detail: outcome.detail, destination: outcome.destination } };
  }
}

/** Types the failure into the session that still runs; resolves why that did not work, or nothing. */
async function tellSource(state: DetachedState, hc: RunnerHc): Promise<string | undefined> {
  if (state.phase === "moved") return undefined;
  const target = state.outcome?.resumedAt ?? state.source;
  try {
    const terminal = await hc.terminal(target);
    if (terminal.state !== "live" || terminal.exit_code !== undefined) return undefined;
    // Only the phase and the reason reach the session's input: a detail can hold a file name or control characters.
    const { reason = "unknown" } = state.outcome ?? {};
    await hc.send(target, `hc-teleport: ${state.phase} (${reason}); see hc-teleport status`);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export type MoveRow = {
  file: string;
  phase: Phase | "state_unreadable";
  session?: string;
  source?: string;
  machine?: string;
  runner?: string;
  /** When the move was started, in ms since the epoch, which tells one move of a session from an earlier one. */
  startedAt?: number;
  reason?: string;
  detail?: string;
  /** Set when the move has not ended and its runner terminal no longer lives. */
  runner_lost?: true;
};

/** One row per state file; a move that has not ended is checked against its runner terminal. */
export async function detachedMoves(dir: string, hc: Pick<Hc, "terminal">): Promise<MoveRow[]> {
  const files = await listStates(dir);
  return Promise.all(
    files.map(async ({ path, read }): Promise<MoveRow> => {
      if (read.kind !== "ok") return { file: path, phase: "state_unreadable", detail: read.detail };
      const { state } = read;
      const ended = isFinal(state.phase);
      return {
        file: path,
        phase: state.phase,
        session: state.session,
        source: state.source,
        machine: state.machine,
        ...(state.runner === undefined ? {} : { runner: state.runner }),
        startedAt: state.startedAt,
        ...(state.outcome?.reason === undefined ? {} : { reason: state.outcome.reason }),
        ...(state.outcome?.detail === undefined ? {} : { detail: state.outcome.detail }),
        ...(!ended && !(await runnerLives(state.runner, hc)) ? { runner_lost: true as const } : {}),
      };
    }),
  );
}

async function runnerLives(runner: string | undefined, hc: Pick<Hc, "terminal">): Promise<boolean> {
  if (runner === undefined) return false;
  try {
    const terminal = await hc.terminal(runner);
    return terminal.state === "live" && terminal.exit_code === undefined;
  } catch {
    return false;
  }
}
