import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detachedMoves, runDetached, sourceAddress, type MoveRow, startDetached, type RunDeps, type RunnerHc, type StarterHc, type StartDeps } from "../../src/detach/detach.ts";
import { readState, writeState, type DetachedState, type Phase } from "../../src/detach/state.ts";
import { HcError, type HcMachine, type HcTerminal, type HcWaitOutcome } from "../../src/platform/hc.ts";
import type { MoveOutcome } from "../../src/move/index.ts";
import type { AgentAdapter } from "../../src/session/agent-adapter.ts";
import type { SessionPlan } from "../../src/session/index.ts";

const SESSION = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
const MOVED: MoveOutcome["status"] = "moved";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hct-detach-"));
  path = join(dir, `${SESSION}.json`);
  started = startOf(initial);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const initial: DetachedState = {
  v: 1,
  session: SESSION,
  source: "t2s",
  machine: "base-digital",
  phase: "waiting",
  runner: "t9",
  waitSeconds: 300,
  timeoutSeconds: 120,
  startedAt: 0,
};

function terminal(address: string, live: boolean): HcTerminal {
  return { address, argv: ["claude"], cwd: "/work", state: live ? "live" : "finished", exit_code: live ? undefined : 0, status: undefined };
}

/** A clock that only moves when a wait slice passes, so a deadline is reached without sleeping. */
class Clock {
  now = 0;
  readonly read = (): number => this.now;
}

class FakeRunnerHc implements RunnerHc {
  readonly waits: number[] = [];
  readonly sent: { address: string; text: string }[] = [];
  sendFails = false;
  live = true;
  readonly #outcomes: HcWaitOutcome[];
  readonly #clock: Clock;
  readonly #last: HcWaitOutcome;

  constructor(clock: Clock, outcomes: HcWaitOutcome[], last: HcWaitOutcome = { kind: "timeout" }) {
    this.#clock = clock;
    this.#outcomes = outcomes;
    this.#last = last;
  }

  wait(_address: string, options: { timeout: number }): Promise<HcWaitOutcome> {
    this.waits.push(options.timeout);
    const outcome = this.#outcomes.shift() ?? this.#last;
    if (outcome.kind === "timeout") this.#clock.now += options.timeout * 1000;
    return Promise.resolve(outcome);
  }

  send(address: string, text: string): Promise<void> {
    if (this.sendFails) return Promise.reject(new HcError("hc send: gone"));
    this.sent.push({ address, text });
    return Promise.resolve();
  }

  terminal(address: string): Promise<HcTerminal> {
    return Promise.resolve(terminal(address, this.live));
  }
}

const IDLE: HcWaitOutcome = { kind: "stopped", status: "idle" };

type Move = { terminal: string; machine: string; timeoutSeconds: number };

/** Answers each outcome in turn and records the request and the phase the file held when the move started. */
function fakeMove(outcomes: MoveOutcome[]): { move: (request: Move) => Promise<MoveOutcome>; requests: Move[]; phases: (string | undefined)[] } {
  const requests: Move[] = [];
  const phases: (string | undefined)[] = [];
  const move = async (request: Move): Promise<MoveOutcome> => {
    requests.push(request);
    const read = await readState(path);
    phases.push(read.kind === "ok" ? read.state.phase : undefined);
    const next = outcomes.shift();
    if (next === undefined) throw new Error("no outcome left");
    return next;
  };
  return { move, requests, phases };
}

/** Stands in for the adapter a plan carries; the runner never reads the plan. */
class UnusedAdapter implements AgentAdapter {
  recognizes(): boolean {
    throw new Error("unused");
  }
  findSession(): Promise<never> {
    throw new Error("unused");
  }
  buildResumeArgv(): never {
    throw new Error("unused");
  }
  checkDestination(): Promise<never> {
    throw new Error("unused");
  }
  confirmResumed(): Promise<never> {
    throw new Error("unused");
  }
}

const plan: SessionPlan = {
  terminal: "t2s",
  source: "local",
  machine: "base-digital",
  cwd: "/work",
  session: { id: SESSION, configDir: "/home/box/.claude" },
  transcript: { file: "/home/box/.claude/projects/p/s.jsonl" },
  resume: { argv: ["claude", "--resume", SESSION] },
  relocate: true,
  adapter: new UnusedAdapter(),
};
const moved: MoveOutcome = { status: MOVED, plan, destination: "base-digital/t3", relocated: true, forget: "done" };

const startOf = ({ session, source, machine, waitSeconds, timeoutSeconds, startedAt }: DetachedState): RunDeps["start"] => ({
  session,
  source,
  machine,
  waitSeconds,
  timeoutSeconds,
  startedAt,
});

/** What the runner is started with; a seed that sets the wait changes it too. */
let started = startOf(initial);

async function seed(over: Partial<DetachedState> = {}): Promise<void> {
  started = startOf({ ...initial, ...over });
  await writeState(path, { ...initial, ...over });
}

async function finalState(): Promise<DetachedState> {
  const read = await readState(path);
  if (read.kind !== "ok") throw new Error(read.detail);
  return read.state;
}

describe("runs a detached move", () => {
  const unrecorded: DetachedState = { v: 1, session: SESSION, source: "t2s", machine: "base-digital", phase: "waiting", waitSeconds: 300, timeoutSeconds: 120, startedAt: 0 };

  it("keeps its own address in every write, so status shows a live move as live and the final file names the runner", async () => {
    await writeState(path, unrecorded);
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    let during: MoveRow[] = [];
    const move = async (): Promise<MoveOutcome> => {
      during = await detachedMoves(dir, hc);
      return moved;
    };

    await runDetached(path, { start: started, hc, move, now: clock.read, runner: "t9" });

    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ phase: "moving", runner: "t9" });
    expect(during[0]).not.toHaveProperty("runner_lost");
    expect(await finalState()).toMatchObject({ phase: "moved", runner: "t9" });
  });
  it("writes its first state itself from its start, waiting and with its own address, over a file that holds an earlier move", async () => {
    await seed({ phase: "moved", runner: "t8", outcome: { destination: "old/t1" }, startedAt: 1 });
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    const first: DetachedState[] = [];
    const move = async (): Promise<MoveOutcome> => {
      first.push(await finalState());
      return moved;
    };
    const start = { session: SESSION, source: "t2s", machine: "other-machine", waitSeconds: 300, timeoutSeconds: 120, startedAt: 7 };

    await runDetached(path, { start, hc, move, now: clock.read, runner: "t9" });

    expect(first[0]).toEqual({ v: 1, ...start, phase: "moving", runner: "t9" });
  });

  it("moves at once when the source is idle, holding phase moving during the move and moved after", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    const { move, requests, phases } = fakeMove([moved]);

    await runDetached(path, { start: started, hc, move, now: clock.read });

    expect(requests).toEqual([{ terminal: "t2s", machine: "base-digital", timeoutSeconds: 120 }]);
    expect(phases).toEqual(["moving"]);
    expect(await finalState()).toMatchObject({ phase: "moved", outcome: { destination: "base-digital/t3" } });
    expect(hc.sent).toEqual([]);
  });

  it("keeps waiting while the source works, then moves once it is idle", async () => {
    await seed({ waitSeconds: 3000 });
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [{ kind: "timeout" }, { kind: "interrupted", reason: "message" }, { kind: "timeout" }, IDLE]);
    const { move, requests } = fakeMove([moved]);

    await runDetached(path, { start: started, hc, move, now: clock.read });

    expect(hc.waits).toHaveLength(4);
    expect(requests).toHaveLength(1);
    expect((await finalState()).phase).toBe("moved");
  });

  it("waits in slices that never pass the deadline and ends on phase timeout without moving", async () => {
    await seed({ waitSeconds: 700 });
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, []);
    const { move, requests } = fakeMove([]);

    await runDetached(path, { start: started, hc, move, now: clock.read });

    expect(hc.waits).toEqual([600, 100]);
    expect(requests).toEqual([]);
    const state = await finalState();
    expect(state.phase).toBe("timeout");
    expect(state.outcome).toMatchObject({ reason: "wait_timeout" });
  });

  it("ends on refused source_gone when the source exits during the wait", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [{ kind: "exited", code: 0 }]);
    hc.live = false;
    const { move, requests } = fakeMove([]);

    await runDetached(path, { start: started, hc, move, now: clock.read });

    expect(requests).toEqual([]);
    expect(await finalState()).toMatchObject({ phase: "refused", outcome: { reason: "source_gone" } });
    expect(hc.sent).toEqual([]);
  });

  it("ends on refused source_not_idle when the source is blocked on a question", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [{ kind: "blocked" }]);
    const { move, requests } = fakeMove([]);

    await runDetached(path, { start: started, hc, move, now: clock.read });

    expect(requests).toEqual([]);
    expect(await finalState()).toMatchObject({ phase: "refused", outcome: { reason: "source_not_idle" } });
  });

  it("goes back to waiting when the source worked again before it was stopped, and moves on the next idle", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE, IDLE]);
    const worked = { status: "refused", refusal: { reason: "not_idle", detail: "t2s reports status working" } } as const;
    const { move, requests, phases } = fakeMove([worked, moved]);

    await runDetached(path, { start: started, hc, move, now: clock.read });

    expect(requests).toHaveLength(2);
    expect(phases).toEqual(["moving", "moving"]);
    expect((await finalState()).phase).toBe("moved");
  });

  it("ends on timeout when the source keeps working again until the deadline", async () => {
    await seed({ waitSeconds: 10 });
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE], { kind: "timeout" });
    const worked = { status: "rolled_back", reason: "source_not_idle", detail: "t2s reports status working" } as const;
    const { move } = fakeMove([worked]);

    await runDetached(path, { start: started, hc, move, now: clock.read });

    expect((await finalState()).phase).toBe("timeout");
  });

  it("ends on refused runner_failed when hc fails, instead of leaving the phase running", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, []);
    hc.wait = () => Promise.reject(new HcError("hc wait t2s: not found"));
    const { move } = fakeMove([]);

    await runDetached(path, { start: started, hc, move, now: clock.read });

    expect(await finalState()).toMatchObject({ phase: "refused", outcome: { reason: "runner_failed", detail: "hc wait t2s: not found" } });
  });

  type Stored = { title: string; outcome: MoveOutcome; phase: string; stored: object };
  const stores: Stored[] = [
    { title: "refused", outcome: { status: "refused", refusal: { reason: "dest_dirty", detail: "dirty" } }, phase: "refused", stored: { reason: "dest_dirty", detail: "dirty" } },
    { title: "rolled_back", outcome: { status: "rolled_back", reason: "did_not_start", detail: "no" }, phase: "rolled_back", stored: { reason: "did_not_start", detail: "no" } },
    {
      title: "rollback_failed",
      outcome: { status: "rollback_failed", cause: "boom", left: ["a", "b"] },
      phase: "rollback_failed",
      stored: { reason: "rollback_failed", detail: "boom; left on the destination: a; b" },
    },
    { title: "relocation rollback_failed", outcome: { status: "rollback_failed", cause: "boom", left: ["a"], relocated: true }, phase: "rollback_failed", stored: { reason: "rollback_failed", detail: "boom; left: a" } },
    { title: "source_not_stopped", outcome: { status: "source_not_stopped", detail: "kill failed" }, phase: "source_not_stopped", stored: { reason: "source_not_stopped", detail: "kill failed" } },
    {
      title: "source_running",
      outcome: { status: "source_running", destination: "x/t1", detail: "kill failed" },
      phase: "source_running",
      stored: { reason: "source_running", detail: "kill failed", destination: "x/t1" },
    },
  ];

  it.each(stores)("stores the $title outcome under its own phase", async ({ outcome, phase, stored }) => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);

    await runDetached(path, { start: started, hc, move: fakeMove([outcome]).move, now: clock.read });

    expect(await finalState()).toMatchObject({ phase, outcome: stored });
  });
});

describe("reports a failed detached move", () => {
  it("types one line into the source for a refusal, naming only the phase and the reason", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    const refused = { status: "refused", refusal: { reason: "dest_dirty", detail: "the destination is dirty" } } as const;

    await runDetached(path, { start: started, hc, move: fakeMove([refused]).move, now: clock.read });

    expect(hc.sent).toEqual([{ address: "t2s", text: "hc-teleport: refused (dest_dirty); see hc-teleport status" }]);
  });

  it("never types a reason detail with newlines, escapes or a file name, which stays in the state file", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    const detail = "line one\nrm -rf ~\u001b[31m /home/box/.claude/projects/p/s.jsonl";
    const refused = { status: "refused", refusal: { reason: "dest_dirty", detail } } as const;

    await runDetached(path, { start: started, hc, move: fakeMove([refused]).move, now: clock.read });

    expect(hc.sent).toEqual([{ address: "t2s", text: "hc-teleport: refused (dest_dirty); see hc-teleport status" }]);
    expect(await finalState()).toMatchObject({ outcome: { reason: "dest_dirty", detail } });
  });

  it("types a line for a rolled back move and for a wait that timed out", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    await runDetached(path, { start: started, hc, move: fakeMove([{ status: "rolled_back", reason: "did_not_start", detail: "no" }]).move, now: clock.read });
    expect(hc.sent.map(({ text }) => text)).toEqual(["hc-teleport: rolled_back (did_not_start); see hc-teleport status"]);

    await seed({ waitSeconds: 5 });
    const second = new FakeRunnerHc(clock, []);
    await runDetached(path, { start: started, hc: second, move: fakeMove([]).move, now: clock.read });
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]?.text).toMatch(/^hc-teleport: timeout \(wait_timeout\); see hc-teleport status$/);
  });

  it("types into the address the session runs on again after a relocation rolled back", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    const back = { status: "rolled_back", reason: "did_not_start", detail: "no", resumedAt: "t12" } as const;

    await runDetached(path, { start: started, hc, move: fakeMove([back]).move, now: clock.read });

    expect(hc.sent.map(({ address }) => address)).toEqual(["t12"]);
    expect(await finalState()).toMatchObject({ phase: "rolled_back", outcome: { resumedAt: "t12" } });
  });

  it("types nothing for a move that worked, and nothing when the source no longer runs", async () => {
    await seed();
    const clock = new Clock();
    const worked = new FakeRunnerHc(clock, [IDLE]);
    await runDetached(path, { start: started, hc: worked, move: fakeMove([moved]).move, now: clock.read });
    expect(worked.sent).toEqual([]);

    await seed();
    const gone = new FakeRunnerHc(clock, [IDLE]);
    gone.live = false;
    await runDetached(path, { start: started, hc: gone, move: fakeMove([{ status: "refused", refusal: { reason: "x", detail: "y" } }]).move, now: clock.read });
    expect(gone.sent).toEqual([]);
  });

  it("records a failed hc send in the state file and leaves the phase as the move ended", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    hc.sendFails = true;

    await runDetached(path, { start: started, hc, move: fakeMove([{ status: "refused", refusal: { reason: "dest_dirty", detail: "d" } }]).move, now: clock.read });

    expect(await finalState()).toMatchObject({ phase: "refused", sendError: "hc send: gone" });
  });

  it("ends the file in one write that carries the outcome and the failed send, none before the line is typed", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);
    const phasesWhenTyped: Phase[] = [];
    hc.send = async () => {
      phasesWhenTyped.push((await finalState()).phase);
      throw new HcError("hc send: gone");
    };

    const returned = await runDetached(path, { start: started, hc, move: fakeMove([{ status: "refused", refusal: { reason: "dest_dirty", detail: "d" } }]).move, now: clock.read });

    expect(phasesWhenTyped).toEqual(["moving"]);
    expect(await finalState()).toMatchObject({ phase: "refused", outcome: { reason: "dest_dirty", detail: "d" }, sendError: "hc send: gone" });
    expect(returned).toEqual(await finalState());
  });

  it("leaves the file as the final write wrote it when the line was typed", async () => {
    await seed();
    const clock = new Clock();
    const hc = new FakeRunnerHc(clock, [IDLE]);

    const returned = await runDetached(path, { start: started, hc, move: fakeMove([{ status: "refused", refusal: { reason: "dest_dirty", detail: "d" } }]).move, now: clock.read });

    expect(await finalState()).toEqual(returned);
    expect(returned).not.toHaveProperty("sendError");
  });
});

describe("starts a detached move", () => {
  it("names the source from the terminal id alone", () => {
    expect(sourceAddress({ HC_TERMINAL_ID: "t2s" })).toEqual({ ok: true, source: "t2s" });
  });

  it("names the source machine and terminal when HC_SESSION is set", () => {
    expect(sourceAddress({ HC_TERMINAL_ID: "t7", HC_SESSION: "base-digital" })).toEqual({ ok: true, source: "base-digital/t7", hcSession: "base-digital" });
  });

  it.each([{}, { HC_TERMINAL_ID: "" }, { HC_SESSION: "base-digital" }])("finds no source in %j", (env) => {
    expect(sourceAddress(env)).toEqual({ ok: false });
  });

  type Call = { argv: readonly string[]; options: object | undefined };
  /** The name hc gives the runner: `hct-` and the first 28 hex digits of the session id. */
  const RUNNER_NAME = "hct-09e11b42f5c14c3899f1dd1d8b00";
  /** The runner's argv for the default request: the state file and the move's parameters, as the runner writes its first state from them. */
  const runnerArgv = (): string[] => [
    "/usr/bin/node", "/opt/cli.js", "--run-detached", path, "--session", SESSION, "--source", "t2s", "--to", "base-digital", "--wait", "300", "--timeout", "120", "--started-at", "4000",
  ];

  /** An hc that, like the real one, refuses a name a live terminal holds and frees it when that terminal ends. */
  function starter(machines: readonly string[], failure?: { kind: string }): { hc: StarterHc; calls: Call[]; live: Set<string>; end: () => void } {
    const calls: Call[] = [];
    const live = new Set<string>();
    const hc: StarterHc = {
      run: (argv, options) => {
        calls.push({ argv, options });
        if (failure !== undefined) return Promise.reject(new HcError(`hc run: failed {"error":{"kind":"${failure.kind}","message":"no"}}`));
        const name = options?.name;
        if (name !== undefined && live.has(name)) {
          return Promise.reject(new HcError(`hc run: failed {"error":{"hint":"pick another name","kind":"name_taken","message":"a live terminal is already named \\"${name}\\""}}`));
        }
        if (name !== undefined) live.add(name);
        return Promise.resolve("t9");
      },
      machines: () => Promise.resolve(machines.map((name): HcMachine => ({ name, state: "connected" }))),
    };
    return { hc, calls, live, end: () => {
      live.clear();
    } };
  }

  const request = { source: "t2s", machine: "base-digital", waitSeconds: 300, timeoutSeconds: 120 };
  const planned = (): Promise<{ ok: true; session: string }> => Promise.resolve({ ok: true, session: SESSION });
  const deps = (hc: StarterHc, plan: StartDeps["plan"] = planned) => ({ hc, plan, path: () => path, entry: ["/usr/bin/node", "/opt/cli.js"], now: () => 4_000 });

  it("runs the CLI on the core under the session's name, leaving the runner to record its own address and no file but the state", async () => {
    const { hc, calls } = starter([]);

    const result = await startDetached(request, deps(hc));

    expect(result).toEqual({ status: "started", runner: "t9", source: "t2s", machine: "base-digital", state: path, startedAt: 4000 });
    expect(calls).toEqual([{ argv: runnerArgv(), options: { name: RUNNER_NAME } }]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports the start time the runner receives, even when the clock advances on every read", async () => {
    const { hc, calls } = starter([]);
    let reads = 0;
    const advancing = (): number => 5_000 + 1_000 * reads++;

    const result = await startDetached(request, { ...deps(hc), now: advancing });

    const argv = calls[0]?.argv ?? [];
    const passed = argv[argv.indexOf("--started-at") + 1];
    expect(passed).toBeDefined();
    expect(result).toMatchObject({ status: "started", startedAt: Number(passed) });
  });

  it("refuses move_in_progress naming the runner's name while that runner lives, starting nothing and leaving the running move's file, then starts once it ended", async () => {
    const { hc, calls, end } = starter([]);
    await startDetached(request, deps(hc));

    const second = await startDetached(request, { ...deps(hc), now: () => 9_000 });

    expect(second).toEqual({
      status: "refused",
      refusal: { reason: "move_in_progress", detail: `a detached move of session ${SESSION} is already running as ${RUNNER_NAME}; see hc-teleport status` },
    });
    expect(calls).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);

    end();
    expect(await startDetached(request, { ...deps(hc), now: () => 12_000 })).toMatchObject({ status: "started" });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.argv.slice(-2)).toEqual(["--started-at", "12000"]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("writes no state file for a move that was refused its name", async () => {
    const { hc, live } = starter([]);
    live.add(RUNNER_NAME);

    expect(await startDetached(request, deps(hc))).toMatchObject({ status: "refused", refusal: { reason: "move_in_progress" } });

    expect(await readdir(dir)).toEqual([]);
  });

  it("passes any other hc failure on and writes no state file", async () => {
    const { hc } = starter([], { kind: "spawn_failed" });

    await expect(startDetached(request, deps(hc))).rejects.toMatchObject({ kind: "spawn_failed" });

    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps the runner's final state when the runner ends before the start returns", async () => {
    const { hc } = starter([]);
    const clock = new Clock();
    hc.run = async () => {
      await runDetached(path, { start: started, hc: new FakeRunnerHc(clock, [IDLE]), move: fakeMove([moved]).move, now: clock.read, runner: "t9" });
      return "t9";
    };

    await startDetached(request, deps(hc));

    expect(await finalState()).toMatchObject({ phase: "moved", runner: "t9" });
  });

  it("leaves the file of a running move whose runner is gone to the runner it starts", async () => {
    await seed({ phase: "moving", runner: "t8" });
    const { hc } = starter([]);

    expect(await startDetached(request, deps(hc))).toMatchObject({ status: "started" });
    expect(await finalState()).toEqual({ ...initial, phase: "moving", runner: "t8" });
  });

  it("leaves a running move's file as it was when its runner still holds the name", async () => {
    await seed({ phase: "moving", runner: "t8" });
    const { hc, live } = starter([]);
    live.add(RUNNER_NAME);

    expect(await startDetached(request, deps(hc))).toMatchObject({ status: "refused", refusal: { reason: "move_in_progress" } });
    expect(await finalState()).toEqual({ ...initial, phase: "moving", runner: "t8" });
  });

  it("leaves a moved report as it was when a start follows before its runner exits", async () => {
    const report: Partial<DetachedState> = { phase: "moved", runner: "t8", outcome: { destination: "base-digital/t3" } };
    await seed(report);
    const { hc, live } = starter([]);
    live.add(RUNNER_NAME);

    expect(await startDetached(request, deps(hc))).toMatchObject({ status: "refused", refusal: { reason: "move_in_progress" } });
    expect(await finalState()).toEqual({ ...initial, ...report });
  });

  it("leaves an earlier finished report as it was when hc fails to start the runner", async () => {
    const report: Partial<DetachedState> = { phase: "timeout", runner: "t8", outcome: { reason: "wait_timeout", detail: "late" } };
    await seed(report);
    const { hc } = starter([], { kind: "spawn_failed" });

    await expect(startDetached(request, deps(hc))).rejects.toMatchObject({ kind: "spawn_failed" });
    expect(await finalState()).toEqual({ ...initial, ...report });
  });

  it("starts exactly one runner for two concurrent starts, which reads the machine of the start that won the name", async () => {
    const { hc, calls } = starter([]);
    const gated: StarterHc = { ...hc, run: async (argv, options) => {
      await new Promise((resolve) => setImmediate(resolve));
      return hc.run(argv, options);
    } };
    const [a, b] = await Promise.all([
      startDetached({ ...request, machine: "machine-a" }, deps(gated)),
      startDetached({ ...request, machine: "machine-b" }, deps(gated)),
    ]);

    expect([a.status, b.status].sort()).toEqual(["refused", "started"]);
    expect(calls).toHaveLength(2);
    const winner = a.status === "started" ? "machine-a" : "machine-b";
    const argv = calls.find((call) => call.argv.includes(winner))?.argv ?? [];
    expect(argv.slice(argv.indexOf("--to"), argv.indexOf("--to") + 2)).toEqual(["--to", winner]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses core_unreachable when the machine HC_SESSION names is not listed, without a lock or a runner", async () => {
    const { hc, calls } = starter(["planet-argon"]);

    const result = await startDetached({ ...request, source: "base-digital/t7", hcSession: "base-digital" }, deps(hc));

    expect(result).toMatchObject({ status: "refused", refusal: { reason: "core_unreachable" } });
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("goes on when the machine HC_SESSION names is listed", async () => {
    const { hc } = starter(["base-digital"]);

    const result = await startDetached({ ...request, source: "base-digital/t7", hcSession: "base-digital" }, deps(hc));

    expect(result).toMatchObject({ status: "started", source: "base-digital/t7" });
  });

  it("passes the plan's refusal on, with no lock and no runner", async () => {
    const { hc, calls } = starter([]);
    const refusal = { reason: "not_claude", detail: "the foreground process is not claude" };

    const result = await startDetached(request, deps(hc, () => Promise.resolve({ ok: false, refusal })));

    expect(result).toEqual({ status: "refused", refusal });
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses state_unreadable over a malformed state file and leaves it", async () => {
    await writeState(path, initial);
    await rm(path);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{oops");
    const { hc, calls } = starter([]);

    const result = await startDetached(request, deps(hc));

    expect(result).toMatchObject({ status: "refused", refusal: { reason: "state_unreadable" } });
    expect(calls).toEqual([]);
  });

});
