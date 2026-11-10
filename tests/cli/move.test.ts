import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveOutcome } from "../../src/move/index.ts";
import type { SessionPlan } from "../../src/session/index.ts";

const moveSession = vi.hoisted(() => vi.fn());
vi.mock("../../src/move/index.ts", () => ({ moveSession }));

const SESSION_ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";

const plan = {
  terminal: "t6c",
  machine: "dev-home",
  cwd: "/work/project",
  session: { id: SESSION_ID, configDir: "/Users/me/.claude" },
  transcript: { file: "/Users/me/.claude/projects/p/s.jsonl" },
  resume: { argv: ["claude", "--resume", SESSION_ID] },
} as unknown as SessionPlan;

type Run = { code: number; stdout: string; stderr: string };

/** Runs the CLI's entry module in this process with `args`, capturing what it writes. */
async function cli(...args: string[]): Promise<Run> {
  vi.resetModules();
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true));
  const argv = process.argv;
  process.argv = [argv[0] ?? "node", "cli.ts", ...args];
  try {
    await import("../../src/app/cli.ts");
  } finally {
    process.argv = argv;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { code, stdout: out.join(""), stderr: err.join("") };
}

beforeEach(() => {
  moveSession.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const outcomes = (outcome: MoveOutcome) => moveSession.mockResolvedValue(outcome);

/** The error classes are loaded after the module reset, so the CLI sees the same classes the move throws. */
const hcFails = (detail: string) =>
  moveSession.mockImplementation(async () => {
    throw new (await import("../../src/platform/hc.ts")).HcError(detail);
  });
const commandFails = (command: string, detail: string) =>
  moveSession.mockImplementation(async () => {
    throw new (await import("../../src/platform/process.ts")).ProcessError(command, detail);
  });

describe("moves the session from the command line", () => {
  it("exits 0 and prints one JSON object naming the destination terminal and the park result", async () => {
    outcomes({ status: "moved", plan, destination: "dev-home/t7", parked: { parked: true } });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(0);
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(run.stdout)).toEqual({
      moved: { terminal: "t6c", machine: "dev-home", session: SESSION_ID, destination: "dev-home/t7", parked: { parked: true } },
    });
  });

  it("hands the terminal, the machine and the default 120 s deadline to the move", async () => {
    outcomes({ status: "moved", plan, destination: "dev-home/t7", parked: { parked: true } });

    await cli("t6c", "dev-home");

    expect(moveSession).toHaveBeenCalledWith({ terminal: "t6c", machine: "dev-home", timeoutSeconds: 120 }, expect.anything());
  });

  it.each(["1", "600", "45"])("hands --timeout %s to the move", async (seconds) => {
    outcomes({ status: "moved", plan, destination: "dev-home/t7", parked: { parked: true } });

    const run = await cli("t6c", "dev-home", "--timeout", seconds);

    expect(run.code).toBe(0);
    expect(moveSession).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: Number(seconds) }), expect.anything());
  });

  it("prints a readable line on stdout without --json", async () => {
    outcomes({ status: "moved", plan, destination: "dev-home/t7", parked: { parked: true } });

    const run = await cli("t6c", "dev-home");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("dev-home/t7");
    expect(() => JSON.parse(run.stdout)).toThrow();
  });

  it("exits 0 with the reason on stderr and in the JSON when the source checkout was not parked", async () => {
    outcomes({ status: "moved", plan, destination: "dev-home/t7", parked: { parked: false, reason: "the source changed" } });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).moved.parked).toEqual({ parked: false, reason: "the source changed" });
    expect(run.stderr).toContain("the source changed");
  });

  it("exits 3 for a refusal, with the reason in the JSON and on stderr", async () => {
    outcomes({ status: "refused", refusal: { reason: "dest_dirty", detail: "dirty" } });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "dest_dirty", detail: "dirty" } });
    expect(run.stderr).toContain("dest_dirty");
  });

  it("exits 4 for a rolled back move, saying the source was not touched", async () => {
    outcomes({ status: "rolled_back", reason: "destination_timeout", detail: "not idle" });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(4);
    expect(JSON.parse(run.stdout)).toEqual({ rolledBack: { reason: "destination_timeout", detail: "not idle" } });
    expect(run.stderr).toContain("destination_timeout");
    expect(run.stderr).toContain("source was not touched");
  });

  it("exits 1 naming what is left when the rollback failed", async () => {
    outcomes({ status: "rollback_failed", cause: "destination_blocked: stuck", left: ["terminal dev-home/t7 still runs", "refs refs/hc-teleport/x/head"] });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(1);
    const { error } = JSON.parse(run.stdout);
    expect(error).toMatchObject({ reason: "rollback_failed", cause: "destination_blocked: stuck", left: ["terminal dev-home/t7 still runs", "refs refs/hc-teleport/x/head"] });
    expect(run.stderr).toContain("dev-home/t7");
    expect(run.stderr).toContain("refs/hc-teleport/x/head");
  });

  it("exits 1 naming the destination and saying the source still runs when it could not be stopped", async () => {
    outcomes({ status: "source_running", destination: "dev-home/t7", detail: "hc kill: boom" });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error).toMatchObject({ reason: "source_running", destination: "dev-home/t7" });
    expect(run.stderr).toContain("dev-home/t7");
    expect(run.stderr).toContain("still runs");
  });

  it("exits 1 as hc_failed when hc fails before anything was written", async () => {
    hcFails("hc get t6c: exploded");

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ error: { reason: "hc_failed", detail: "hc get t6c: exploded" } });
  });

  it("exits 1 as command_failed when a local program fails before anything was written", async () => {
    commandFails("git -C /x rev-parse", "not a git repository");

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error.reason).toBe("command_failed");
  });
});

describe("answers a failure no one planned for with one object and an exit code (unexpected)", () => {
  const throws = (error: Error) => moveSession.mockRejectedValue(error);

  it("exits 1 as unexpected_error with the message on stdout under --json", async () => {
    throws(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(1);
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(run.stdout)).toEqual({ error: { reason: "unexpected_error", detail: "EACCES: permission denied" } });
    expect(run.stderr).toContain("unexpected_error");
  });

  it("prints one message on stderr and nothing on stdout without --json", async () => {
    throws(new Error("boom"));

    const run = await cli("t6c", "dev-home");

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("boom");
  });

  it("names a thrown value that is not an error", async () => {
    moveSession.mockRejectedValue("just text");

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error).toEqual({ reason: "unexpected_error", detail: "just text" });
  });

  it("exits 4 for a move rolled back after an unexpected error", async () => {
    outcomes({ status: "rolled_back", reason: "unexpected_error", detail: "EACCES" });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(4);
    expect(JSON.parse(run.stdout)).toEqual({ rolledBack: { reason: "unexpected_error", detail: "EACCES" } });
  });

  it("exits 1 naming what is left when the rollback after an unexpected error failed", async () => {
    outcomes({ status: "rollback_failed", cause: "unexpected_error: EACCES", left: ["refs refs/hc-teleport/x/head"] });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error).toMatchObject({ reason: "rollback_failed", cause: "unexpected_error: EACCES" });
  });
});

describe("exits 4 when the source was no longer idle (source)", () => {
  it("prints the rollback and says the source was not touched", async () => {
    outcomes({ status: "rolled_back", reason: "source_not_idle", detail: "t6c reports status working, not done or idle" });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(4);
    expect(JSON.parse(run.stdout)).toEqual({ rolledBack: { reason: "source_not_idle", detail: "t6c reports status working, not done or idle" } });
    expect(run.stderr).toContain("source_not_idle");
    expect(run.stderr).toContain("source was not touched");
  });

  it("exits 1 naming what is left when the rollback failed", async () => {
    outcomes({ status: "rollback_failed", cause: "source_not_idle: working", left: ["terminal dev-home/t7 still runs"] });

    const run = await cli("t6c", "dev-home", "--json");

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error).toMatchObject({ reason: "rollback_failed", left: ["terminal dev-home/t7 still runs"] });
  });
});

describe("rejects a wrong invocation with exit 2 and nothing on stdout", () => {
  it.each([
    ["a --timeout of 0", ["t6c", "dev-home", "--timeout", "0"]],
    ["a --timeout of 601", ["t6c", "dev-home", "--timeout", "601"]],
    ["a --timeout that is not a number", ["t6c", "dev-home", "--timeout", "soon"]],
    ["a fractional --timeout", ["t6c", "dev-home", "--timeout", "1.5"]],
    ["a negative --timeout", ["t6c", "dev-home", "--timeout=-5"]],
    ["a --timeout without a value", ["t6c", "dev-home", "--timeout"]],
  ])("%s", async (_title, args) => {
    const run = await cli(...args);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("usage:");
    expect(moveSession).not.toHaveBeenCalled();
  });
});
