import { describe, expect, it } from "vitest";
import { ProcessError, type Runner } from "../../src/platform/process.ts";
import { HcError, type HcExecOptions, type HcExecResult } from "../../src/platform/hc.ts";
import { preflight } from "../../src/preflight/index.ts";
import { ClaudeAdapter } from "../../src/session/claude-adapter.ts";
import type { SessionPlan } from "../../src/session/index.ts";

const MACHINE = "dev-home";
const HOME = "/home/box";
const CWD = "/work/project";
const SUBDIRECTORY = `${CWD}/packages/api`;

type Box = {
  /** What `git rev-parse --show-toplevel` prints at the plan's cwd on the destination; absent when it is no work tree. */
  toplevel?: string | undefined;
  /** The plan's cwd on the destination; the destination answers git for no other path. */
  cwd: string;
  /** What `git rev-parse --show-toplevel` prints at the plan's cwd on the source. */
  sourceToplevel: string;
  home?: string | undefined;
  /** Programs that start, with what they print. */
  programs: Record<string, { version?: string; where?: string | { fails: true } }>;
  dirs: string[];
};

function box(overrides: Partial<Box> = {}): Box {
  return {
    toplevel: CWD,
    cwd: CWD,
    sourceToplevel: CWD,
    home: HOME,
    programs: { claude: { version: "2.1.321 (Claude Code)" } },
    dirs: [`${HOME}/.claude`],
    ...overrides,
  };
}

const ok = (stdout: string): HcExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "failed"): HcExecResult => ({ code: 1, stdout: "", stderr });

/** A destination that answers like a Linux box would, and records every argv it receives. */
class FakeHc {
  readonly argvs: string[][] = [];
  readonly writes: string[] = [];
  readonly ons: (string | undefined)[] = [];

  readonly state: Box;

  constructor(state: Box) {
    this.state = state;
  }

  exec = async (argv: readonly string[], options: HcExecOptions = {}): Promise<HcExecResult> => {
    this.argvs.push([...argv]);
    this.ons.push(options.on);
    const [program = "", ...rest] = argv;
    if (program === "git") {
      return rest[0] === "-C" && rest[1] === this.state.cwd && this.state.toplevel !== undefined ? ok(`${this.state.toplevel}\n`) : fail("not a git repository");
    }
    if (program === "printenv") return this.state.home === undefined ? fail() : ok(`${this.state.home}\n`);
    if (program === "test") return rest[0] === "-d" && this.state.dirs.includes(rest[1] ?? "") ? ok("") : fail();
    const known = this.state.programs[program];
    if (known === undefined) return { code: 127, stdout: "", stderr: `${program}: not found` };
    if (rest[0] === "--version") return known.version === undefined ? ok("") : ok(`${known.version}\n`);
    if (rest[0] === "--where") {
      if (known.where === undefined || typeof known.where !== "string") return fail();
      return ok(`${known.where}\n`);
    }
    return fail("unexpected");
  };

  writeFile = async (path: string): Promise<void> => {
    this.writes.push(path);
  };
}

/** The source machine, answering the one read-only git question the preflight asks it and recording every call. */
function sourceRunner(state: Box): { calls: string[][]; run: Runner } {
  const calls: string[][] = [];
  const run: Runner = async (file, args) => {
    calls.push([file, ...args]);
    const [flag, path, ...rest] = args;
    if (file === "git" && flag === "-C" && path === state.cwd && rest.join(" ") === "rev-parse --show-toplevel") {
      return `${state.sourceToplevel}\n`;
    }
    throw new ProcessError([file, ...args].join(" "), "not a git repository");
  };
  return { calls, run };
}

function planWith(overrides: { argv?: string[]; version?: string | null; cwd?: string } = {}): SessionPlan {
  const { argv = ["claude"], version = "2.1.321", cwd = CWD } = overrides;
  return {
    terminal: "t1",
    machine: MACHINE,
    cwd,
    session: { id: "09e11b42-f5c1-4c38-99f1-dd1d8b00355c", configDir: "/Users/mac/.claude", ...(version === null ? {} : { version }) },
    transcript: { file: "/Users/mac/.claude/projects/x/s.jsonl" },
    resume: { argv },
  };
}

function run(state: Box, plan: SessionPlan) {
  const hc = new FakeHc(state);
  const source = sourceRunner(state);
  const result = preflight({ plan, machine: MACHINE }, { hc, run: source.run, adapter: new ClaudeAdapter("/Users/mac") });
  return { hc, source, result };
}

describe("accepts a destination", () => {
  it.each([
    ["with equal versions", "2.1.321 (Claude Code)", "2.1.321"],
    ["newer by a patch", "2.1.322 (Claude Code)", "2.1.321"],
    ["newer by a minor", "2.2.0 (Claude Code)", "2.1.321"],
    ["newer by a major", "3.0.0 (Claude Code)", "2.1.321"],
    ["newer with a longer patch number than the source", "2.1.1000 (Claude Code)", "2.1.999"],
  ])("running plain claude, %s", async (_title, printed, source) => {
    const { hc, result } = run(box({ programs: { claude: { version: printed } } }), planWith({ version: source }));

    expect(await result).toEqual({
      ok: true,
      destination: { home: HOME, configDir: `${HOME}/.claude`, version: printed.split(" ")[0] },
    });
    expect(hc.argvs.some((argv) => argv.includes("--where"))).toBe(false);
  });

  it("through a launcher whose --where prints an absolute directory that exists", async () => {
    const state = box({
      programs: { "claude-klock": { version: "2.1.321 (Claude Code)", where: `${HOME}/.claude-klock` } },
      dirs: [`${HOME}/.claude-klock`],
    });

    const { result } = run(state, planWith({ argv: ["claude-klock", "--resume", "x"] }));

    expect(await result).toEqual({
      ok: true,
      destination: { home: HOME, configDir: `${HOME}/.claude-klock`, version: "2.1.321" },
    });
  });

  it("running in a subdirectory when the destination holds the same top level at the same path", async () => {
    const { hc, source, result } = run(box({ cwd: SUBDIRECTORY }), planWith({ cwd: SUBDIRECTORY }));

    expect(await result).toEqual({
      ok: true,
      destination: { home: HOME, configDir: `${HOME}/.claude`, version: "2.1.321" },
    });
    expect(source.calls).toEqual([["git", "-C", SUBDIRECTORY, "rev-parse", "--show-toplevel"]]);
    expect(hc.writes).toEqual([]);
  });

  it("asks the machine it was given", async () => {
    const { hc, result } = run(box(), planWith());
    await result;
    expect(new Set(hc.ons)).toEqual(new Set([MACHINE]));
  });
});

describe("refuses a destination", () => {
  const launcher = (where: string | { fails: true }): Box =>
    box({
      programs: { "claude-klock": { version: "2.1.321 (Claude Code)", where } },
      dirs: [`${HOME}/.claude-klock`],
    });

  it.each([
    ["the path does not exist", box({ toplevel: undefined })],
    ["the path is inside a work tree whose top level is a parent", box({ toplevel: "/work" })],
  ])("with dest_repo_missing when %s", async (_title, state) => {
    const { result } = run(state, planWith());
    const refusal = await result;
    expect(refusal).toEqual({ ok: false, refusal: { reason: "dest_repo_missing", detail: expect.stringContaining(`${MACHINE}`) } });
    expect(JSON.stringify(refusal)).toContain(CWD);
  });

  it.each([
    ["the destination's top level for the cwd is another repository", box({ cwd: SUBDIRECTORY, toplevel: SUBDIRECTORY })],
    ["only the subdirectory exists there", box({ cwd: SUBDIRECTORY, toplevel: undefined })],
    ["the destination's top level is a parent of the source's", box({ cwd: SUBDIRECTORY, toplevel: "/work", sourceToplevel: CWD })],
  ])("with dest_repo_missing for a subdirectory cwd when %s", async (_title, state) => {
    const { result } = run(state, planWith({ cwd: SUBDIRECTORY }));
    const refusal = await result;
    expect(refusal).toEqual({ ok: false, refusal: { reason: "dest_repo_missing", detail: expect.stringContaining(MACHINE) } });
    expect(JSON.stringify(refusal)).toContain(SUBDIRECTORY);
  });

  it("with dest_repo_missing naming git's own error when git exits non-zero", async () => {
    const { result } = run(box({ toplevel: undefined }), planWith());
    expect(await result).toMatchObject({ ok: false, refusal: { reason: "dest_repo_missing", detail: expect.stringContaining("not a git repository") } });
  });

  it("with dest_repo_missing naming git when git cannot start", async () => {
    const hc = {
      exec: async (argv: readonly string[]): Promise<HcExecResult> => {
        throw new HcError(`hc exec ${argv.join(" ")}: {"error":{"kind":"spawn_failed","message":"cannot start git: No such file or directory"}}`);
      },
    };
    const result = await preflight({ plan: planWith(), machine: MACHINE }, { hc, run: sourceRunner(box()).run, adapter: new ClaudeAdapter("/Users/mac") });
    expect(result).toMatchObject({
      ok: false,
      refusal: { reason: "dest_repo_missing", detail: expect.stringContaining("cannot start git") },
    });
  });

  it.each([
    ["printenv HOME exits non-zero", undefined],
    ["printenv HOME prints nothing", ""],
    ["printenv HOME prints only whitespace", "  \t"],
    ["printenv HOME prints a relative path", "box"],
  ])("by throwing when %s", async (_title, home) => {
    const state = box({ home });
    for (const plan of [planWith(), planWith({ argv: ["claude-klock"] })]) {
      const { hc, result } = run(state, plan);
      const error = await result.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HcError);
      expect((error as HcError).message).toMatch(new RegExp(`printenv HOME on ${MACHINE}.*exit code`));
      expect(hc.argvs.map((argv) => argv[0])).toEqual(["git", "printenv"]);
    }
  });

  it("with dest_executable_missing when the program cannot start", async () => {
    const { result } = run(box({ programs: {} }), planWith());
    expect(await result).toEqual({
      ok: false,
      refusal: { reason: "dest_executable_missing", detail: expect.stringMatching(new RegExp(`${MACHINE}.*claude`)) },
    });
  });

  it("with dest_executable_missing for an absolute path from the source machine", async () => {
    const { result } = run(box(), planWith({ argv: ["/Users/mac/.local/bin/claude-klock"] }));
    expect(await result).toMatchObject({
      ok: false,
      refusal: { reason: "dest_executable_missing", detail: expect.stringContaining("/Users/mac/.local/bin/claude-klock") },
    });
  });

  it.each([
    ["the directory does not exist", { where: `${HOME}/.claude-klock`, dirs: [] as string[] }],
    ["--where prints a relative path", { where: ".claude-klock", dirs: [`${HOME}/.claude-klock`] }],
    ["--where fails", { where: { fails: true } as const, dirs: [`${HOME}/.claude-klock`] }],
  ])("with dest_profile_missing when %s", async (_title, { where, dirs }) => {
    const state = { ...launcher(where), dirs };
    const { result } = run(state, planWith({ argv: ["claude-klock"] }));
    expect(await result).toMatchObject({ ok: false, refusal: { reason: "dest_profile_missing", detail: expect.stringContaining(MACHINE) } });
  });

  it("with dest_profile_missing when plain claude has no ~/.claude", async () => {
    const { result } = run(box({ dirs: [] }), planWith());
    expect(await result).toMatchObject({
      ok: false,
      refusal: { reason: "dest_profile_missing", detail: expect.stringContaining(`${HOME}/.claude`) },
    });
  });

  it.each([
    ["a patch", "2.1.320 (Claude Code)"],
    ["a minor", "2.0.999 (Claude Code)"],
    ["a major", "1.9.999 (Claude Code)"],
  ])("with dest_agent_older when the destination is below by %s", async (_title, printed) => {
    const { result } = run(box({ programs: { claude: { version: printed } } }), planWith());
    expect(await result).toMatchObject({
      ok: false,
      refusal: { reason: "dest_agent_older", detail: expect.stringContaining(MACHINE) },
    });
  });

  it.each([
    ["it prints no version", { version: "Claude Code" }, "2.1.321"],
    ["it prints two numbers", { version: "2.1 (Claude Code)" }, "2.1.321"],
    ["it prints nothing", {}, "2.1.321"],
    ["the plan carries no source version", { version: "2.1.321 (Claude Code)" }, null],
    ["the source version is unparseable", { version: "2.1.321 (Claude Code)" }, "latest"],
  ])("with dest_agent_version_unknown when %s", async (_title, program, source) => {
    const { result } = run(box({ programs: { claude: program } }), planWith({ version: source }));
    expect(await result).toMatchObject({
      ok: false,
      refusal: { reason: "dest_agent_version_unknown", detail: expect.stringContaining(MACHINE) },
    });
  });

  it("stops at the first refusal, in the order repository, executable, profile, version", async () => {
    const everythingWrong = box({ toplevel: undefined, programs: {}, dirs: [] });
    const first = run(everythingWrong, planWith());
    expect(await first.result).toMatchObject({ refusal: { reason: "dest_repo_missing" } });
    expect(first.hc.argvs.map((argv) => argv[0])).toEqual(["git"]);

    const noProgram = run(box({ programs: {}, dirs: [] }), planWith());
    expect(await noProgram.result).toMatchObject({ refusal: { reason: "dest_executable_missing" } });

    const noProfileAndOlder = run(box({ programs: { claude: { version: "1.0.0" } }, dirs: [] }), planWith());
    expect(await noProfileAndOlder.result).toMatchObject({ refusal: { reason: "dest_profile_missing" } });
  });
});

describe("only reads", () => {
  const READ_ONLY: ((argv: readonly string[]) => boolean)[] = [
    (argv) => argv.join(" ") === `git -C ${CWD} rev-parse --show-toplevel` || argv.join(" ") === `git -C ${SUBDIRECTORY} rev-parse --show-toplevel`,
    (argv) => argv.join(" ") === "printenv HOME",
    (argv) => argv.length === 3 && argv[0] === "test" && argv[1] === "-d",
    (argv) => argv.length === 2 && (argv[1] === "--version" || argv[1] === "--where"),
  ];

  it("sends nothing but read-only commands across the accepting and refusing cases", async () => {
    const launcherBox = box({
      programs: { "claude-klock": { version: "2.1.321 (Claude Code)", where: `${HOME}/.claude-klock` } },
      dirs: [`${HOME}/.claude-klock`],
    });
    const cases: [Box, SessionPlan][] = [
      [box(), planWith()],
      [box({ cwd: SUBDIRECTORY }), planWith({ cwd: SUBDIRECTORY })],
      [box({ cwd: SUBDIRECTORY, toplevel: SUBDIRECTORY }), planWith({ cwd: SUBDIRECTORY })],
      [launcherBox, planWith({ argv: ["claude-klock", "--resume", "x"] })],
      [box({ toplevel: undefined }), planWith()],
      [box({ programs: {} }), planWith()],
      [box({ dirs: [] }), planWith()],
      [box({ programs: { claude: { version: "1.0.0" } } }), planWith()],
      [box({ programs: { claude: {} } }), planWith()],
    ];

    for (const [state, plan] of cases) {
      const { hc, result } = run(state, plan);
      await result;
      expect(hc.writes).toEqual([]);
      for (const argv of hc.argvs) {
        expect(READ_ONLY.some((allowed) => allowed(argv)), argv.join(" ")).toBe(true);
      }
    }
  });

  it("treats hc's spawn_failed report as a program that cannot start there", async () => {
    const hc = {
      exec: async (argv: readonly string[]): Promise<HcExecResult> => {
        if (argv[0] !== "git" && argv[0] !== "printenv") {
          throw new HcError(`hc exec ${argv.join(" ")}: {"error":{"kind":"spawn_failed","message":"cannot start claude: No such file or directory"}}`);
        }
        return ok(argv[0] === "git" ? `${CWD}\n` : `${HOME}\n`);
      },
    };
    const result = await preflight({ plan: planWith(), machine: MACHINE }, { hc, run: sourceRunner(box()).run, adapter: new ClaudeAdapter("/Users/mac") });
    expect(result).toMatchObject({ ok: false, refusal: { reason: "dest_executable_missing" } });
  });

  it("lets an hc failure propagate as an error, not a refusal", async () => {
    const hc = {
      exec: async (): Promise<HcExecResult> => {
        throw new HcError("hc exec git on dev-home: machine unreachable");
      },
    };
    await expect(preflight({ plan: planWith(), machine: MACHINE }, { hc, run: sourceRunner(box()).run, adapter: new ClaudeAdapter("/Users/mac") })).rejects.toThrow(
      /unreachable/,
    );
  });
});
