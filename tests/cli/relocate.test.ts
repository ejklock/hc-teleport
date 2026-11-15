import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MoveModule from "../../src/move/index.ts";
import type * as HcModule from "../../src/platform/hc.ts";
import type { AgentAdapter } from "../../src/session/agent-adapter.ts";
import type { SessionPlan } from "../../src/session/index.ts";

const SESSION_ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
/** Stands in for the adapter a plan carries; the CLI never calls it. */
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
  terminal: "t12",
  source: "local",
  machine: "planet-argon",
  cwd: "/work/project",
  session: { id: SESSION_ID, configDir: "/home/box/.claude" },
  transcript: { file: "/home/box/.claude/projects/p/s.jsonl" },
  resume: { argv: ["claude", "--resume", SESSION_ID] },
  relocate: true,
  adapter: new UnusedAdapter(),
};
const relocated = { status: "moved", plan, relocated: true, destination: "planet-argon/t3" } as const;

type Run = { stdout: string; stderr: string; exit: number | undefined };

let scratch: string;
let saved: { argv: string[]; xdg: string | undefined; exitCode: typeof process.exitCode };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "hct-relocate-"));
  await mkdir(join(scratch, "hc-teleport"));
  await writeFile(join(scratch, "hc-teleport", "config.json"), JSON.stringify({ v: 1, allowed: ["planet-argon"] }));
  saved = { argv: process.argv, xdg: process.env["XDG_CONFIG_HOME"], exitCode: process.exitCode };
  process.env["XDG_CONFIG_HOME"] = scratch;
});

afterEach(async () => {
  process.argv = saved.argv;
  process.exitCode = saved.exitCode;
  if (saved.xdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = saved.xdg;
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(scratch, { recursive: true, force: true });
});

/** Runs the CLI once for a terminal and a destination, with the move answering the given outcome. */
async function cli(outcome: MoveModule.MoveOutcome, ...flags: string[]): Promise<Run> {
  vi.resetModules();
  vi.doMock("../../src/move/index.ts", async () => {
    const actual = await vi.importActual<typeof MoveModule>("../../src/move/index.ts");
    return { ...actual, moveSession: () => Promise.resolve(outcome) };
  });
  vi.doMock("../../src/platform/hc.ts", async () => {
    const actual = await vi.importActual<typeof HcModule>("../../src/platform/hc.ts");
    class FakeHc {
      serverStatus = () => Promise.resolve("dev-home");
      machines = () => Promise.resolve([]);
    }
    return { ...actual, Hc: FakeHc };
  });
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
  process.argv = ["node", "cli.ts", "t12", "planet-argon", ...flags];
  await import("../../src/app/cli.ts");
  return { stdout, stderr, exit: typeof process.exitCode === "number" ? process.exitCode : undefined };
}

describe("a relocated move reports", () => {
  it("its destination in plain text and exits 0 when the record was forgotten", async () => {
    const run = await cli({ ...relocated, forget: "done" });

    expect(run).toEqual({ stdout: `moved t12 to planet-argon/t3 (session ${SESSION_ID}); source terminal stopped\n`, stderr: "", exit: 0 });
  });

  it("its destination as json with the relocation and the forget", async () => {
    const run = await cli({ ...relocated, forget: "done" }, "--json");

    expect(JSON.parse(run.stdout)).toEqual({
      moved: { terminal: "t12", machine: "planet-argon", session: SESSION_ID, destination: "planet-argon/t3", relocated: true, forget: "done" },
    });
    expect(run.exit).toBe(0);
  });

  it("one warning naming herdr-wake forget when the forget failed, and still exits 0", async () => {
    const run = await cli({ ...relocated, forget: "failed", forgetDetail: "herdr-wake forget t12 exited 2: no such terminal" });

    expect(run.exit).toBe(0);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain("resumed twice after a reboot");
    expect(run.stderr).toContain("herdr-wake forget t12");
    expect(run.stderr).toContain("no such terminal");
    expect(JSON.parse((await cli({ ...relocated, forget: "failed", forgetDetail: "x" }, "--json")).stdout)).toMatchObject({ moved: { forget: "failed" } });
  });

  it("no warning for a source on an hc machine, whose record herdr-wake does not hold", async () => {
    const fromMachine = { ...plan, terminal: "dev-home/t12", source: "dev-home" };
    const run = await cli({ ...relocated, plan: fromMachine, forget: "not_recorded" }, "--json");

    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({ moved: { relocated: true, forget: "not_recorded" } });
    expect(run.exit).toBe(0);
  });
});

describe("a relocation that did not complete reports", () => {
  it("a source that could not be stopped, exiting 1", async () => {
    const run = await cli({ status: "source_not_stopped", detail: "hc kill: gone" });

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("source_not_stopped");
    expect(run.stderr).toContain("hc kill: gone");
  });

  it("the new source terminal and exits 4 when the session runs again on the source", async () => {
    const run = await cli({ status: "rolled_back", reason: "destination_blocked", detail: "blocked", resumedAt: "dev-home/t8" });

    expect(run.exit).toBe(4);
    expect(run.stderr).toContain("dev-home/t8");
  });

  it("what it left without calling it the destination's, exiting 1", async () => {
    const run = await cli({ status: "rollback_failed", relocated: true, cause: "destination_blocked: blocked", left: ["the session runs nowhere; resume it on dev-home: claude"] }, "--json");

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("the session runs nowhere");
    expect(run.stderr).not.toContain("left on the destination");
    expect(JSON.parse(run.stdout)).toMatchObject({ error: { reason: "rollback_failed", left: ["the session runs nowhere; resume it on dev-home: claude"] } });
  });
});
