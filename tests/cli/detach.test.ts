import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as HcModule from "../../src/platform/hc.ts";
import type * as SessionModule from "../../src/session/index.ts";

type DetachedState = Record<string, unknown>;

/** Writes a state file the way the runner would leave it. */
async function put(path: string, state: DetachedState): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(state)}\n`);
}

const SESSION = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
const ENV_KEYS = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "HC_TERMINAL_ID", "HC_SESSION"] as const;

type Run = { stdout: string; stderr: string; exit: number | undefined };
type Setup = {
  env?: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  machines?: string[];
  plan?: Awaited<ReturnType<typeof SessionModule.planSession>> | "ok";
  liveTerminals?: string[];
  config?: boolean;
  /** The error kind `hc run` fails with. */
  runFailure?: string;
};
type Seen = { run: string[][]; names: string[]; hcSessionAtCall: (string | undefined)[]; planned: { terminal: string; machine: string; requireIdle: boolean | undefined }[] };

let scratch: string;
/** The names of the runner terminals still alive, which the fake hc keeps unique as the real one does. */
const liveNames = new Set<string>();
let saved: { argv: string[]; env: Record<string, string | undefined>; exitCode: typeof process.exitCode };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "hct-cli-detach-"));
  liveNames.clear();
  saved = { argv: process.argv, env: Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])), exitCode: process.exitCode };
});

afterEach(async () => {
  process.argv = saved.argv;
  process.exitCode = saved.exitCode;
  for (const key of ENV_KEYS) {
    restoreEnv(key, saved.env[key]);
  }
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(scratch, { recursive: true, force: true });
});

/** Puts an environment variable back as it was, removing it when it was unset. */
function restoreEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  Reflect.deleteProperty(process.env, key);
  if (value !== undefined) process.env[key] = value;
}

const stateFolder =(): string => join(scratch, "state", "hc-teleport");

async function cli(args: string[], setup: Setup = {}): Promise<{ run: Run; seen: Seen }> {
  const seen: Seen = { run: [], names: [], hcSessionAtCall: [], planned: [] };
  if (setup.config !== false) {
    await mkdir(join(scratch, "config", "hc-teleport"), { recursive: true });
    await writeFile(join(scratch, "config", "hc-teleport", "config.json"), JSON.stringify({ v: 1, allowed: ["base-digital"] }));
  }
  for (const key of ENV_KEYS) restoreEnv(key, undefined);
  Object.assign(process.env, { XDG_CONFIG_HOME: join(scratch, "config"), XDG_STATE_HOME: join(scratch, "state"), ...setup.env });
  vi.resetModules();
  const machines = setup.machines ?? [];
  const live = setup.liveTerminals ?? [];
  vi.doMock("../../src/platform/hc.ts", async () => {
    const actual = await vi.importActual<typeof HcModule>("../../src/platform/hc.ts");
    const note = (): void => void seen.hcSessionAtCall.push(process.env["HC_SESSION"]);
    class FakeHc {
      serverStatus = () => {
        note();
        return Promise.resolve("dev-home");
      };
      machines = () => {
        note();
        return Promise.resolve(machines.map((name) => ({ name, state: "connected" })));
      };
      run = (argv: readonly string[], options?: { name?: string }) => {
        note();
        seen.run.push([...argv]);
        if (setup.runFailure !== undefined) return Promise.reject(new actual.HcError(`hc run: failed {"error":{"kind":"${setup.runFailure}","message":"no"}}`));
        const name = options?.name;
        if (name !== undefined) {
          seen.names.push(name);
          if (liveNames.has(name)) return Promise.reject(new actual.HcError(`hc run: failed {"error":{"kind":"name_taken","message":"a live terminal is already named \\"${name}\\""}}`));
          liveNames.add(name);
        }
        return Promise.resolve("t99");
      };
      wait = () => {
        note();
        return Promise.resolve({ kind: "exited" });
      };
      send = () => {
        note();
        return Promise.resolve();
      };
      terminal = (address: string) => {
        note();
        const isLive = live.includes(address);
        return Promise.resolve({ address, argv: ["x"], cwd: "/", state: isLive ? "live" : "finished", exit_code: isLive ? undefined : 0, status: undefined });
      };
    }
    return { ...actual, Hc: FakeHc };
  });
  vi.doMock("../../src/session/index.ts", async () => {
    const actual = await vi.importActual<typeof SessionModule>("../../src/session/index.ts");
    return {
      ...actual,
      planSession: (request: { terminal: string; machine: string }, deps: { requireIdle?: boolean }) => {
        seen.planned.push({ ...request, requireIdle: deps.requireIdle });
        return Promise.resolve(setup.plan === undefined || setup.plan === "ok" ? { ok: true, plan: { session: { id: SESSION } } } : setup.plan);
      },
    };
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
  process.argv = ["node", "cli.ts", ...args];
  await import("../../src/app/cli.ts");
  return { run: { stdout, stderr, exit: typeof process.exitCode === "number" ? process.exitCode : undefined }, seen };
}

describe("starts a detached move", () => {
  it("from a terminal on an hc machine: plans for machine/terminal, drops HC_SESSION from every hc call and prints the runner", async () => {
    const { run, seen } = await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "t7", HC_SESSION: "base-digital" }, machines: ["base-digital"] });

    expect(run.exit).toBe(0);
    expect(run.stdout).toBe("detached: t99 will move base-digital/t7 to base-digital once it is idle; see hc-teleport status\n");
    expect(seen.planned).toEqual([{ terminal: "base-digital/t7", machine: "base-digital", requireIdle: false }]);
    expect(seen.hcSessionAtCall.length).toBeGreaterThan(0);
    expect(seen.hcSessionAtCall.every((value) => value === undefined)).toBe(true);
  });

  it("starts the runner on the core with this CLI's own entry and the state file, named after the session, with no lock file", async () => {
    const { seen } = await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "t2s" } });

    const file = join(stateFolder(), `${SESSION}.json`);
    expect(seen.run).toHaveLength(1);
    const [node, entry, flag, state, ...rest] = seen.run[0] ?? [];
    expect(node).toBe(process.execPath);
    expect(entry).toMatch(/src[\\/]app[\\/]cli\.(ts|js)$/);
    expect([flag, state, rest]).toEqual(["--run-detached", file, []]);
    expect(seen.names).toEqual(["hct-09e11b42f5c14c3899f1dd1d8b00"]);
    expect(await readdir(stateFolder())).toEqual([`${SESSION}.json`]);
  });

  it("refuses hc_failed with exit 1 for any other hc run failure, leaving no state file", async () => {
    const { run } = await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "t2s" }, runFailure: "spawn_failed" });

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("hc_failed");
    expect(await readdir(stateFolder())).toEqual([]);
  });

  it.each([["--wait", "30"], ["--timeout", "30"], ["--dry-run"]])("refuses status with %s as a usage error, exit 2", async (...flags) => {
    const { run } = await cli(["status", ...flags]);

    expect(run.exit).toBe(2);
    expect(run.stdout).toBe("");
  });

  it("prints the runner as json with --json", async () => {
    const { run } = await cli(["base-digital", "--detach", "--json", "--wait", "30"], { env: { HC_TERMINAL_ID: "t2s" } });

    expect(JSON.parse(run.stdout)).toEqual({
      detached: { runner: "t99", source: "t2s", machine: "base-digital", state: join(stateFolder(), `${SESSION}.json`) },
    });
    expect(run.exit).toBe(0);
  });

  it("refuses not_in_a_terminal with exit 2 when HC_TERMINAL_ID is empty, starting nothing", async () => {
    const { run, seen } = await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "" } });

    expect(run.exit).toBe(2);
    expect(run.stderr).toContain("not_in_a_terminal");
    expect(seen.run).toEqual([]);
  });

  it("refuses core_unreachable with exit 3 when HC_SESSION names a machine hc does not list", async () => {
    const { run, seen } = await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "t7", HC_SESSION: "elsewhere" }, machines: ["base-digital"] });

    expect(run.exit).toBe(3);
    expect(run.stderr).toContain("core_unreachable");
    expect(seen.run).toEqual([]);
  });

  it("refuses not_initialized with exit 3 when there is no config, with no lock", async () => {
    const { run, seen } = await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "t2s" }, config: false });

    expect(run.exit).toBe(3);
    expect(run.stderr).toContain("not_initialized");
    expect(seen.run).toEqual([]);
    await expect(readdir(stateFolder())).rejects.toThrow();
  });

  it("passes the plan's refusal on with exit 3, with no lock and no runner", async () => {
    const plan = { ok: false, refusal: { reason: "not_claude", detail: "the foreground process of t2s is not claude" } } as const;
    const { run, seen } = await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "t2s" }, plan });

    expect(run.exit).toBe(3);
    expect(run.stderr).toContain("refused (not_claude)");
    expect(seen.run).toEqual([]);
    await expect(readdir(stateFolder())).rejects.toThrow();
  });

  it("refuses move_in_progress with exit 3 while another detached move of the session runs", async () => {
    await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "t2s" } });
    const { run, seen } = await cli(["base-digital", "--detach"], { env: { HC_TERMINAL_ID: "t2s" } });

    expect(run.exit).toBe(3);
    expect(run.stderr).toContain("move_in_progress");
    expect(run.stderr).toContain("hct-09e11b42f5c14c3899f1dd1d8b00");
    expect(seen.run).toHaveLength(1);
    expect(await readdir(stateFolder())).toEqual([`${SESSION}.json`]);
  });

  it.each([["--wait", "0"], ["--wait", "abc"], ["--timeout", "0"]])("rejects %s %s as a usage error", async (flag, value) => {
    const { run } = await cli(["base-digital", "--detach", flag, value], { env: { HC_TERMINAL_ID: "t2s" } });

    expect(run.exit).toBe(2);
  });

  it("rejects --wait without --detach and --detach with a terminal or --dry-run as usage errors", async () => {
    const env = { HC_TERMINAL_ID: "t2s" };
    expect((await cli(["t1", "base-digital", "--wait", "5"], { env })).run.exit).toBe(2);
    expect((await cli(["t1", "base-digital", "--detach"], { env })).run.exit).toBe(2);
    expect((await cli(["base-digital", "--detach", "--dry-run"], { env })).run.exit).toBe(2);
  });
});

describe("status of detached moves", () => {
  const base = {
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

  it("says so in one line and exits 0 when there are no state files, and prints an empty list as json", async () => {
    const text = await cli(["status"]);
    expect(text.run).toEqual({ stdout: "no detached moves\n", stderr: "", exit: 0 });

    const json = await cli(["status", "--json"]);
    expect(json.run.stdout).toBe('{"moves":[]}\n');
  });

  it("lists a final move with its reason and a running move whose runner lives, as json", async () => {
    await put(join(stateFolder(), "a.json"), { ...base, phase: "refused", outcome: { reason: "dest_dirty", detail: "dirty" } });
    await put(join(stateFolder(), "b.json"), { ...base, session: "other", runner: "t5" });

    const { run } = await cli(["status", "--json"], { liveTerminals: ["t5"] });

    expect(JSON.parse(run.stdout)).toEqual({
      moves: [
        { file: join(stateFolder(), "a.json"), session: SESSION, source: "t2s", machine: "base-digital", phase: "refused", runner: "t9", reason: "dest_dirty", detail: "dirty" },
        { file: join(stateFolder(), "b.json"), session: "other", source: "t2s", machine: "base-digital", phase: "waiting", runner: "t5" },
      ],
    });
    expect(run.exit).toBe(0);
  });

  it("shows runner_lost for a running move whose runner terminal no longer lives, and for one that never recorded a runner", async () => {
    await put(join(stateFolder(), "a.json"), { ...base, phase: "moving" });
    await put(join(stateFolder(), "b.json"), { ...base, session: "other", runner: undefined });

    const { run } = await cli(["status"], { liveTerminals: [] });

    const lines = run.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("moving");
    expect(lines[0]).toContain("runner_lost");
    expect(lines[1]).toContain("runner_lost");
  });

  it("prints a final move's reason in text and leaves a malformed file as state_unreadable", async () => {
    await put(join(stateFolder(), "a.json"), { ...base, phase: "timeout", outcome: { reason: "wait_timeout", detail: "t2s was not idle within 300 s" } });
    await writeFile(join(stateFolder(), "b.json"), "{oops");

    const { run } = await cli(["status"]);

    expect(run.stdout).toContain("timeout  runner t9  wait_timeout: t2s was not idle within 300 s");
    expect(run.stdout).toContain("state_unreadable");
    expect(run.stdout).not.toContain("runner_lost");
  });
});

describe("runs a detached move", () => {
  const unrecorded = { v: 1, session: SESSION, source: "t2s", machine: "base-digital", phase: "waiting", waitSeconds: 300, timeoutSeconds: 120, startedAt: 0 };
  const file = (): string => join(stateFolder(), `${SESSION}.json`);

  async function ended(env: Record<string, string>): Promise<unknown> {
    await put(file(), unrecorded);
    const { run } = await cli(["--run-detached", file()], { env });
    expect(run.exit).toBe(1);
    const state: unknown = JSON.parse(await readFile(file(), "utf8"));
    return state;
  }

  it("records the terminal it runs in as the runner in the state file", async () => {
    expect(await ended({ HC_TERMINAL_ID: "t5" })).toMatchObject({ phase: "timeout", runner: "t5" });
  });

  it("records the machine HC_SESSION names in front of the terminal, as the source is addressed", async () => {
    expect(await ended({ HC_TERMINAL_ID: "t5", HC_SESSION: "base-digital" })).toMatchObject({ phase: "timeout", runner: "base-digital/t5" });
  });
});
