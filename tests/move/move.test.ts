import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hc, HcWaitOutcome } from "../../src/platform/hc.ts";
import { HcError } from "../../src/platform/hc.ts";
import type { Runner } from "../../src/platform/process.ts";
import type { AgentAdapter } from "../../src/session/agent-adapter.ts";
import type { SessionPlan } from "../../src/session/index.ts";

const mocks = vi.hoisted(() => ({
  planSession: vi.fn(),
  preflight: vi.fn(),
  carryGit: vi.fn(),
  undoGitCarry: vi.fn(),
  parkSource: vi.fn(),
  carryTranscript: vi.fn(),
  undoTranscriptCarry: vi.fn(),
}));

vi.mock("../../src/session/index.ts", () => ({ planSession: mocks.planSession }));
vi.mock("../../src/preflight/index.ts", () => ({ preflight: mocks.preflight }));
vi.mock("../../src/git-carry/index.ts", () => ({
  carryGit: mocks.carryGit,
  undoGitCarry: mocks.undoGitCarry,
  parkSource: mocks.parkSource,
}));
vi.mock("../../src/transcript-carry/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../src/transcript-carry/index.ts")>(
    "../../src/transcript-carry/index.ts",
  );
  return { ...actual, carryTranscript: mocks.carryTranscript, undoTranscriptCarry: mocks.undoTranscriptCarry };
});

const { moveSession } = await import("../../src/move/index.ts");
const { TranscriptCarryError } = await import("../../src/transcript-carry/index.ts");

const SESSION_ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
const DEST_ADDRESS = "dev-home/t7";
const SOURCE = "t6c";

const confirmResumed = vi.fn();
const adapter = { confirmResumed } as unknown as AgentAdapter;

const plan: SessionPlan = {
  terminal: SOURCE,
  machine: "dev-home",
  cwd: "/work/project/packages/api",
  session: { id: SESSION_ID, configDir: "/Users/me/.claude", version: "2.1.321" },
  transcript: { file: "/Users/me/.claude/projects/p/s.jsonl", dir: "/Users/me/.claude/projects/p/s" },
  resume: { argv: ["claude", "--resume", SESSION_ID] },
  adapter,
};

const carried = {
  status: "carried" as const,
  machine: "dev-home",
  id: SESSION_ID,
  cwd: "/work/project",
  refs: [`refs/hc-teleport/${SESSION_ID}/head`],
  branch: "main",
  carried: { head: "a", staged: "b", worktree: "c" },
};
const transcriptResult = { machine: "dev-home", destConfigDir: "/home/box/.claude", written: ["/x"], replaced: [], destHomeCount: 0 };

let events: string[];
let waits: (HcWaitOutcome | Error)[];
let hc: Record<"terminal" | "run" | "wait" | "kill" | "exec", ReturnType<typeof vi.fn>>;

const deps = () => ({ hc: hc as unknown as Hc, run: vi.fn() as unknown as Runner, home: "/Users/me" });
const move = (timeoutSeconds = 120) => moveSession({ terminal: SOURCE, machine: "dev-home", timeoutSeconds }, deps());

beforeEach(() => {
  events = [];
  waits = [{ kind: "stopped", status: "idle" }];
  for (const fn of Object.values(mocks)) fn.mockReset();
  confirmResumed.mockReset();
  mocks.planSession.mockResolvedValue({ ok: true, plan });
  mocks.preflight.mockResolvedValue({ ok: true, destination: { home: "/home/box", configDir: "/home/box/.claude", version: "2.1.321" } });
  mocks.carryGit.mockImplementation(async () => {
    events.push("carryGit");
    return carried;
  });
  mocks.carryTranscript.mockImplementation(async () => {
    events.push("carryTranscript");
    return transcriptResult;
  });
  mocks.undoGitCarry.mockImplementation(async () => void events.push("undoGit"));
  mocks.undoTranscriptCarry.mockImplementation(async () => void events.push("undoTranscript"));
  mocks.parkSource.mockImplementation(async () => {
    events.push("park");
    return { parked: true };
  });
  confirmResumed.mockResolvedValue({ ok: true });
  hc = {
    terminal: vi.fn(async (address: string) =>
      address === SOURCE
        ? { address, state: "live", status: { state: "idle" } }
        : { address, state: "live", foreground: { pid: 70 } },
    ),
    run: vi.fn(async () => {
      events.push("run");
      return DEST_ADDRESS;
    }),
    wait: vi.fn(async () => {
      events.push("wait");
      const next = waits.shift() ?? { kind: "stopped", status: "idle" };
      if (next instanceof Error) throw next;
      return next;
    }),
    kill: vi.fn(async (address: string) => {
      events.push(`kill ${address}`);
      return { address, state: "finished" };
    }),
    exec: vi.fn(),
  };
});

describe("moves the session", () => {
  it("runs every step in order, resumes in the session's own folder and stops then parks the source", async () => {
    const outcome = await move();

    expect(outcome).toEqual({ status: "moved", plan, destination: DEST_ADDRESS, parked: { parked: true } });
    expect(events).toEqual(["carryGit", "carryTranscript", "run", "wait", `kill ${SOURCE}`, "park"]);
    expect(hc.terminal).toHaveBeenLastCalledWith(SOURCE);
    expect(hc.run).toHaveBeenCalledWith(plan.resume.argv, { on: "dev-home", cwd: plan.cwd, keep: true });
    expect(mocks.carryGit).toHaveBeenCalledWith({ cwd: plan.cwd, machine: "dev-home", id: SESSION_ID }, expect.anything());
    expect(mocks.carryTranscript).toHaveBeenCalledWith(
      {
        machine: "dev-home",
        transcript: plan.transcript,
        sourceConfigDir: "/Users/me/.claude",
        sourceHome: "/Users/me",
        destConfigDir: "/home/box/.claude",
        destHome: "/home/box",
      },
      expect.anything(),
    );
    expect(confirmResumed).toHaveBeenCalledWith(
      expect.objectContaining({ address: DEST_ADDRESS }),
      { sessionId: SESSION_ID, configDir: "/home/box/.claude" },
      expect.objectContaining({ machine: "dev-home" }),
    );
    expect(mocks.parkSource).toHaveBeenCalledWith(carried, expect.anything());
  });

  it("waits again after an interrupted wait and still succeeds", async () => {
    waits = [{ kind: "interrupted", reason: "message" }, { kind: "interrupted", reason: "status_cleared" }, { kind: "stopped", status: "done" }];

    const outcome = await move();

    expect(outcome.status).toBe("moved");
    expect(events.filter((event) => event === "wait")).toHaveLength(3);
    expect(events.some((event) => event.startsWith("undo"))).toBe(false);
  });

  it("reads the terminal again until hc reports its foreground process, then confirms", async () => {
    hc.terminal
      .mockResolvedValueOnce({ address: DEST_ADDRESS, state: "live" })
      .mockResolvedValueOnce({ address: DEST_ADDRESS, state: "live" })
      .mockResolvedValueOnce({ address: DEST_ADDRESS, state: "live", foreground: { pid: 70 } });

    expect((await move()).status).toBe("moved");

    expect(hc.terminal.mock.calls.filter(([address]) => address === DEST_ADDRESS)).toHaveLength(3);
    expect(confirmResumed).toHaveBeenCalledWith(expect.objectContaining({ foreground: { pid: 70 } }), expect.anything(), expect.anything());
  });

  it("runs the confirmation over hc exec on the destination", async () => {
    hc.exec.mockResolvedValue({ code: 0, stdout: "out", stderr: "" });
    confirmResumed.mockImplementation(async (_terminal, _expected, remote) => {
      expect(await remote.run(["cat", "/x"])).toEqual({ code: 0, stdout: "out", stderr: "" });
      return { ok: true };
    });

    await move();

    expect(hc.exec).toHaveBeenCalledWith(["cat", "/x"], { on: "dev-home" });
  });

  it("exits moved with the reason when the source cannot be parked", async () => {
    mocks.parkSource.mockResolvedValue({ parked: false, reason: "the source changed since the carry" });

    expect(await move()).toMatchObject({ status: "moved", parked: { parked: false, reason: "the source changed since the carry" } });
  });

  it("reports a parking that throws as not parked", async () => {
    mocks.parkSource.mockRejectedValue(new Error("git exploded"));

    expect(await move()).toMatchObject({ status: "moved", parked: { parked: false, reason: "git exploded" } });
  });

  it("keeps the move and names the destination when the source terminal cannot be stopped", async () => {
    hc.kill.mockRejectedValue(new HcError("hc kill t6c: no such terminal"));

    const outcome = await move();

    expect(outcome).toEqual({ status: "source_running", destination: DEST_ADDRESS, detail: "hc kill t6c: no such terminal" });
    expect(mocks.parkSource).not.toHaveBeenCalled();
    expect(events.some((event) => event.startsWith("undo"))).toBe(false);
  });
});

describe("refuses", () => {
  it.each([
    ["terminal_not_running"],
    ["not_idle"],
    ["unknown_machine"],
    ["machine_unreachable"],
    ["not_claude"],
    ["config_dir_unknown"],
    ["no_session"],
    ["session_registry_unreadable"],
    ["session_registry_stale"],
    ["flag_not_allowed"],
    ["flag_missing_value"],
  ])("when the plan refuses with %s, touching nothing", async (reason) => {
    mocks.planSession.mockResolvedValue({ ok: false, refusal: { reason, detail: "no" } });

    expect(await move()).toEqual({ status: "refused", refusal: { reason, detail: "no" } });
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.carryGit).not.toHaveBeenCalled();
    expect(mocks.carryTranscript).not.toHaveBeenCalled();
    expect(hc.run).not.toHaveBeenCalled();
    expect(hc.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["dest_executable_missing"],
    ["dest_profile_missing"],
    ["dest_agent_older"],
    ["dest_agent_version_unknown"],
    ["dest_repo_missing"],
  ])("when the preflight refuses with %s, touching nothing", async (reason) => {
    mocks.preflight.mockResolvedValue({ ok: false, refusal: { reason, detail: "no" } });

    expect(await move()).toEqual({ status: "refused", refusal: { reason, detail: "no" } });
    expect(mocks.preflight).toHaveBeenCalledWith({ plan, machine: "dev-home" }, expect.objectContaining({ adapter }));
    expect(mocks.carryGit).not.toHaveBeenCalled();
    expect(mocks.carryTranscript).not.toHaveBeenCalled();
    expect(hc.run).not.toHaveBeenCalled();
    expect(hc.kill).not.toHaveBeenCalled();
  });

  it.each([["dest_diverged"], ["dest_dirty"], ["machine_without_ssh"]])(
    "when the git carry refuses with %s, writing nothing",
    async (reason) => {
      mocks.carryGit.mockResolvedValue({ status: "refused", reason });

      const outcome = await move();

      expect(outcome).toMatchObject({ status: "refused", refusal: { reason } });
      expect(mocks.carryTranscript).not.toHaveBeenCalled();
      expect(mocks.undoGitCarry).not.toHaveBeenCalled();
      expect(hc.run).not.toHaveBeenCalled();
    },
  );

  it("when the transcript carry refuses, undoing the git carry and nothing else", async () => {
    mocks.carryTranscript.mockRejectedValue(new TranscriptCarryError("transcript_missing", "gone"));

    expect(await move()).toEqual({
      status: "refused",
      refusal: { reason: "transcript_missing", detail: "transcript_missing: gone" },
    });
    expect(mocks.undoGitCarry).toHaveBeenCalledWith(carried, expect.anything());
    expect(mocks.undoTranscriptCarry).not.toHaveBeenCalled();
    expect(hc.run).not.toHaveBeenCalled();
    expect(hc.kill).not.toHaveBeenCalled();
  });

  it("lets a failing hc before any write surface as the hc error", async () => {
    mocks.preflight.mockRejectedValue(new HcError("hc exec: boom"));

    await expect(move()).rejects.toThrow("hc exec: boom");
    expect(mocks.carryGit).not.toHaveBeenCalled();
  });
});

describe("rolls back", () => {
  const rollbackOrder = [`kill ${DEST_ADDRESS}`, "undoTranscript", "undoGit"];
  const afterWrites = () => events.slice(events.indexOf("wait"));

  it.each<[string, HcWaitOutcome, string]>([
    ["blocked", { kind: "blocked" }, "destination_blocked"],
    ["error", { kind: "error" }, "destination_error"],
    ["exited", { kind: "exited", code: 1 }, "destination_exited"],
    ["the deadline", { kind: "timeout" }, "destination_timeout"],
  ])("when the wait ends on %s: destination terminal, transcript, then git, the source untouched", async (_name, outcome, reason) => {
    waits = [outcome];

    const result = await move();

    expect(result).toMatchObject({ status: "rolled_back", reason });
    expect(afterWrites()).toEqual(["wait", ...rollbackOrder]);
    expect(events).not.toContain(`kill ${SOURCE}`);
    expect(events).not.toContain("park");
    expect(confirmResumed).not.toHaveBeenCalled();
  });

  it("when hc never reports the foreground process before the deadline: the confirmation sees a terminal without one and refuses", async () => {
    hc.terminal.mockResolvedValue({ address: DEST_ADDRESS, state: "live" });
    confirmResumed.mockResolvedValue({ ok: false, refusal: { reason: "not_claude", detail: "no foreground" } });

    const result = await move(1);

    expect(result).toEqual({ status: "rolled_back", reason: "not_resumed", detail: "not_claude: no foreground" });
    expect(confirmResumed).toHaveBeenCalledWith(expect.not.objectContaining({ foreground: expect.anything() }), expect.anything(), expect.anything());
    expect(afterWrites().slice(-3)).toEqual(rollbackOrder);
  });

  it("names the exit code of a destination that exited", async () => {
    waits = [{ kind: "exited", code: 127 }];

    expect(await move()).toMatchObject({ detail: expect.stringContaining("127") });
  });

  it("when the confirmation refuses session_mismatch", async () => {
    confirmResumed.mockResolvedValue({ ok: false, refusal: { reason: "session_mismatch", detail: "other session" } });

    const result = await move();

    expect(result).toEqual({ status: "rolled_back", reason: "not_resumed", detail: "session_mismatch: other session" });
    expect(afterWrites().slice(-3)).toEqual(rollbackOrder);
    expect(events).not.toContain(`kill ${SOURCE}`);
  });

  it("when the git carry failed after its push, undoing it and writing no transcript", async () => {
    const failed = { ...carried, status: "failed" as const, step: "checkout", detail: "index.lock exists" };
    mocks.carryGit.mockResolvedValue(failed);

    const result = await move();

    expect(result).toEqual({ status: "rolled_back", reason: "git_carry_failed", detail: "checkout: index.lock exists" });
    expect(mocks.undoGitCarry).toHaveBeenCalledWith(failed, expect.anything());
    expect(mocks.carryTranscript).not.toHaveBeenCalled();
    expect(hc.run).not.toHaveBeenCalled();
  });

  it("when hc run fails: transcript then git, no terminal to kill", async () => {
    hc.run.mockRejectedValue(new HcError("hc run: no machine"));

    const result = await move();

    expect(result).toEqual({ status: "rolled_back", reason: "hc_failed", detail: "hc run: no machine" });
    expect(events).toEqual(["carryGit", "carryTranscript", "undoTranscript", "undoGit"]);
  });

  it.each(["wait", "terminal"] as const)("when hc %s fails: the started terminal is killed first", async (which) => {
    if (which === "wait") waits = [new HcError("hc wait: gone")];
    else hc.terminal.mockRejectedValue(new HcError("hc get: gone"));

    const result = await move();

    expect(result).toMatchObject({ status: "rolled_back", reason: "hc_failed" });
    expect(afterWrites().slice(-3)).toEqual(rollbackOrder);
  });

  it("names everything left when rollback steps fail, still trying the later steps", async () => {
    waits = [{ kind: "blocked" }];
    hc.kill.mockRejectedValue(new HcError("hc kill: unreachable"));
    mocks.undoTranscriptCarry.mockRejectedValue(new HcError("rm failed"));
    mocks.undoGitCarry.mockRejectedValue(new HcError("git failed"));

    const result = await move();

    expect(result.status).toBe("rollback_failed");
    if (result.status !== "rollback_failed") return;
    expect(result.cause).toContain("destination_blocked");
    expect(result.left).toEqual([
      expect.stringContaining(DEST_ADDRESS),
      expect.stringContaining("/home/box/.claude"),
      expect.stringContaining(`refs/hc-teleport/${SESSION_ID}/head`),
    ]);
    expect(mocks.undoGitCarry).toHaveBeenCalled();
  });

  it("names only the git refs when only the git undo fails", async () => {
    mocks.carryTranscript.mockRejectedValue(new TranscriptCarryError("transcript_missing", "gone"));
    mocks.undoGitCarry.mockRejectedValue(new HcError("git failed"));

    const result = await move();

    expect(result).toMatchObject({ status: "rollback_failed", left: [expect.stringContaining("refs/hc-teleport/")] });
  });

  it("reads a wait that ends past the deadline as a timeout and never asks hc wait for under a second (deadline)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const asked: number[] = [];
      hc.wait.mockImplementation(async (_address: string, options: { timeout: number }) => {
        asked.push(options.timeout);
        if (options.timeout < 1) return { kind: "timeout" };
        vi.setSystemTime(Date.now() + 1500);
        return { kind: "interrupted", reason: "message" };
      });

      const result = await move(4);

      expect(result).toMatchObject({ status: "rolled_back", reason: "destination_timeout" });
      expect(asked.length).toBeGreaterThan(1);
      expect(Math.min(...asked)).toBeGreaterThanOrEqual(1);
      expect(events.slice(-3)).toEqual(rollbackOrder);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rolls back when the source is no longer idle", () => {
  const rollbackOrder = [`kill ${DEST_ADDRESS}`, "undoTranscript", "undoGit"];
  const sourceReads = (terminal: Record<string, unknown>) =>
    hc.terminal.mockImplementation(async (address: string) =>
      address === SOURCE ? { address, ...terminal } : { address, state: "live", foreground: { pid: 70 } },
    );

  it.each([["idle"], ["done"]])("stops the source and moves when it reads %s (source)", async (state) => {
    sourceReads({ state: "live", status: { state } });

    expect((await move()).status).toBe("moved");
    expect(events).toContain(`kill ${SOURCE}`);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["working", { state: "live", status: { state: "working" } }, "working"],
    ["blocked", { state: "live", status: { state: "blocked" } }, "blocked"],
    ["no status", { state: "live" }, "none"],
    ["finished", { state: "finished", status: { state: "idle" } }, "finished"],
    ["exited with a code", { state: "live", exit_code: 1, status: { state: "idle" } }, "live"],
  ])("when the source reads %s: destination terminal, transcript, then git, the source never stopped (source)", async (_name, terminal, named) => {
    sourceReads(terminal);

    const result = await move();

    expect(result).toMatchObject({ status: "rolled_back", reason: "source_not_idle", detail: expect.stringContaining(named) });
    expect(events.slice(-3)).toEqual(rollbackOrder);
    expect(events).not.toContain(`kill ${SOURCE}`);
    expect(mocks.parkSource).not.toHaveBeenCalled();
  });

  it("when reading the source fails with an hc error: rolled back as hc_failed, the source not stopped (source)", async () => {
    hc.terminal.mockImplementation(async (address: string) => {
      if (address === SOURCE) throw new HcError("hc get t6c: gone");
      return { address, state: "live", foreground: { pid: 70 } };
    });

    const result = await move();

    expect(result).toEqual({ status: "rolled_back", reason: "hc_failed", detail: "hc get t6c: gone" });
    expect(events.slice(-3)).toEqual(rollbackOrder);
    expect(events).not.toContain(`kill ${SOURCE}`);
  });

  it("names what is left when a rollback step fails (source)", async () => {
    sourceReads({ state: "live", status: { state: "working" } });
    mocks.undoGitCarry.mockRejectedValue(new HcError("git failed"));

    const result = await move();

    expect(result).toMatchObject({
      status: "rollback_failed",
      cause: expect.stringContaining("source_not_idle"),
      left: [expect.stringContaining("refs/hc-teleport/")],
    });
    expect(events).not.toContain(`kill ${SOURCE}`);
  });
});

describe("an unexpected error", () => {
  const eacces = Object.assign(new Error("EACCES: permission denied, open '/home/box/.claude/x'"), { code: "EACCES" });

  it("from the transcript carry is rolled back with its message (unexpected)", async () => {
    mocks.carryTranscript.mockRejectedValue(eacces);

    const result = await move();

    expect(result).toEqual({ status: "rolled_back", reason: "unexpected_error", detail: eacces.message });
    expect(events).toEqual(["carryGit", "undoGit"]);
  });

  it("from the transcript carry with the git undo failing names the refs left (unexpected)", async () => {
    mocks.carryTranscript.mockRejectedValue(eacces);
    mocks.undoGitCarry.mockRejectedValue(new HcError("git failed"));

    const result = await move();

    expect(result).toMatchObject({
      status: "rollback_failed",
      cause: `unexpected_error: ${eacces.message}`,
      left: [expect.stringContaining("refs/hc-teleport/")],
    });
  });

  it("from a wait is rolled back like any failure of the destination (unexpected)", async () => {
    waits = [new TypeError("bug")];

    expect(await move()).toEqual({ status: "rolled_back", reason: "unexpected_error", detail: "bug" });
    expect(events.slice(-3)).toEqual([`kill ${DEST_ADDRESS}`, "undoTranscript", "undoGit"]);
  });

  it("from the plan, before any write, surfaces as it is and writes nothing (unexpected)", async () => {
    mocks.planSession.mockRejectedValue(new Error("plan exploded"));

    await expect(move()).rejects.toThrow("plan exploded");
    expect(mocks.carryGit).not.toHaveBeenCalled();
    expect(hc.run).not.toHaveBeenCalled();
    expect(hc.kill).not.toHaveBeenCalled();
  });

  it("from stopping the source keeps the destination address and rolls nothing back (unexpected)", async () => {
    hc.kill.mockRejectedValue(new Error("socket hung up"));

    expect(await move()).toEqual({ status: "source_running", destination: DEST_ADDRESS, detail: "socket hung up" });
    expect(events.some((event) => event.startsWith("undo"))).toBe(false);
  });
});
