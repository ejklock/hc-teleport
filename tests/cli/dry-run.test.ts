import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hc, HcError, type HcTerminal } from "../../src/platform/hc.ts";
import { processRunner } from "../../src/platform/process.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "src", "app", "cli.ts");
const SESSION_ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
const PROJECT_DIR = "-Volumes-Developer-www-klock-tecnologia-hc-teleport";

type Run = { code: number; stdout: string; stderr: string };

let scratch: string;
let home: string;
let bin: string;
let state: string;
let terminal: HcTerminal;
let registryCwd: string | undefined;

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(ROOT, "tests", "fixtures", name), "utf8"));
}

async function parseTerminal(raw: unknown): Promise<HcTerminal> {
  return new Hc(async () => JSON.stringify(raw)).terminal("t6c");
}

function foregroundOf(base: HcTerminal): NonNullable<HcTerminal["foreground"]> {
  if (base.foreground === undefined) throw new Error("the fixture has no foreground process");
  return base.foreground;
}

async function script(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

async function withStatus(status: unknown): Promise<void> {
  const { status: _dropped, ...rest } = terminal;
  terminal = await parseTerminal(status === undefined ? rest : { ...rest, status });
}

async function publishTerminal(): Promise<void> {
  await writeFile(join(state, "get.json"), JSON.stringify(terminal));
}

async function registry(configDir: string, cwd = terminal.cwd): Promise<void> {
  await mkdir(join(configDir, "sessions"), { recursive: true });
  const pid = foregroundOf(terminal).pid;
  await writeFile(join(configDir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION_ID, cwd, version: "2.1.321" }));
}

function cli(...args: string[]): Promise<Run> {
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_STATE: state };
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

beforeEach(async () => {
  registryCwd = undefined;
  scratch = await mkdtemp(join(tmpdir(), "dry-run-"));
  home = join(scratch, "home");
  bin = join(scratch, "bin");
  state = join(scratch, "state");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(state)]);
  await script(
    join(bin, "hc"),
    `[ -f "$FAKE_STATE/hc-fails" ] && { echo "hc exploded" >&2; exit 1; }
case "$1 $2 $3" in
  "get t6c --json") cat "$FAKE_STATE/get.json" ;;
  "machine ls --json") cat "$FAKE_STATE/machines.json" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac`,
  );
  await script(join(bin, "claude-klock"), `[ "$1" = "--where" ] && printf '%s\\n' "${home}/.claude-klock"`);
  terminal = await parseTerminal(await fixture("hc-get-claude-klock.json"));
  await withStatus({ app: "claude-code", state: "done" });
  await publishTerminal();
  await writeFile(join(state, "machines.json"), JSON.stringify(await fixture("hc-machine-ls.json")));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("prints the session plan of an idle Claude terminal", () => {
  it("as one JSON object for a claude-klock terminal, without subagents", async () => {
    const configDir = join(home, ".claude-klock");
    await registry(configDir);

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      terminal: "t6c",
      machine: "dev-home",
      cwd: terminal.cwd,
      session: { id: SESSION_ID, configDir, version: "2.1.321" },
      transcript: { file: join(configDir, "projects", PROJECT_DIR, `${SESSION_ID}.jsonl`), dir: null },
      resume: { argv: ["claude-klock", "--resume", SESSION_ID] },
    });
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("with the subagent directory when the session has one", async () => {
    const configDir = join(home, ".claude-klock");
    await registry(configDir);
    const dir = join(configDir, "projects", PROJECT_DIR, SESSION_ID);
    await mkdir(join(dir, "subagents"), { recursive: true });

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).transcript.dir).toBe(dir);
  });

  it("for a plain claude terminal, using the home's .claude and keeping allowed flags", async () => {
    terminal = { ...terminal, argv: ["claude", "--model", "opus", "a prompt"] };
    await publishTerminal();
    await registry(join(home, ".claude"));

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(0);
    const plan = JSON.parse(run.stdout);
    expect(plan.session.configDir).toBe(join(home, ".claude"));
    expect(plan.resume.argv).toEqual(["claude", "--model", "opus", "--resume", SESSION_ID]);
  });

  it("with an idle status as well as a done one", async () => {
    await withStatus({ app: "claude-code", state: "idle" });
    await publishTerminal();
    await registry(join(home, ".claude-klock"));

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).session.id).toBe(SESSION_ID);
  });

  it("quoting a resume token that needs it", async () => {
    terminal = { ...terminal, argv: ["claude-klock", "--name", "my work"] };
    await publishTerminal();
    await registry(join(home, ".claude-klock"));

    const run = await cli("t6c", "dev-home", "--dry-run");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`claude-klock --name 'my work' --resume ${SESSION_ID}`);
  });

  it("readably without --json, with messages kept off stdout", async () => {
    await registry(join(home, ".claude-klock"));

    const run = await cli("t6c", "dev-home", "--dry-run");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(SESSION_ID);
    expect(run.stdout).toContain(`claude-klock --resume ${SESSION_ID}`);
    expect(() => JSON.parse(run.stdout)).toThrow();
    expect(run.stderr).toBe("");
  });

  it("without writing anything under the home", async () => {
    await registry(join(home, ".claude-klock"));
    const before = await tree(home);

    await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(await tree(home)).toEqual(before);
  });
});

describe("refuses a terminal or an invocation", () => {
  async function refusal(reason: string, ...extra: string[]): Promise<void> {
    await registry(join(home, ".claude-klock"), registryCwd);
    const before = await tree(home);

    const json = await cli("t6c", "dev-home", "--dry-run", "--json", ...extra);
    const text = await cli("t6c", "dev-home", "--dry-run", ...extra);

    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({ refused: { reason, detail: expect.any(String) } });
    expect(text.code).toBe(3);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain(reason);
    expect(await tree(home)).toEqual(before);
  }

  it("that is working as not_idle", async () => {
    await withStatus({ app: "claude-code", state: "working" });
    await publishTerminal();
    await refusal("not_idle");
  });

  it("whose status state is unknown as not_idle", async () => {
    await withStatus({ app: "claude-code", state: "blocked" });
    await publishTerminal();
    await refusal("not_idle");
  });

  it("that has no status as not_idle", async () => {
    await withStatus(undefined);
    await publishTerminal();
    await refusal("not_idle");
  });

  it("that never reported a status, printed as null by hc, as not_idle", async () => {
    await writeFile(join(state, "get.json"), JSON.stringify(await fixture("hc-get-unreported.json")));
    await refusal("not_idle");
  });

  it("that never reported a status, left out by hc, as not_idle", async () => {
    const { status: _dropped, ...unreported } = await fixture("hc-get-unreported.json");
    await writeFile(join(state, "get.json"), JSON.stringify(unreported));
    await refusal("not_idle");
  });

  it("that never reported a status, printed as null by hc, parses to a terminal without a status", async () => {
    const parsed = await parseTerminal(await fixture("hc-get-unreported.json"));
    expect(parsed.status).toBeUndefined();
  });

  it("that never reported a status but prints one of the wrong type with exit 1 and hc_failed", async () => {
    const unreported = await fixture("hc-get-unreported.json");
    await writeFile(join(state, "get.json"), JSON.stringify({ ...unreported, status: "done" }));
    const run = await cli("t6c", "dev-home", "--dry-run", "--json");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error.reason).toBe("hc_failed");
  });

  it("that is not live as terminal_not_running", async () => {
    terminal = { ...terminal, state: "exited", exit_code: 0 };
    await publishTerminal();
    await refusal("terminal_not_running");
  });

  it("that is live yet reports an exit code as terminal_not_running", async () => {
    terminal = { ...terminal, exit_code: 0 };
    await publishTerminal();
    await refusal("terminal_not_running");
  });

  it("whose registry matches the terminal cwd but not the foreground cwd as session_registry_stale", async () => {
    terminal = { ...terminal, foreground: { ...foregroundOf(terminal), cwd: "/elsewhere" } };
    await publishTerminal();
    await refusal("session_registry_stale");
  });

  it("whose registry matches the foreground cwd but not the terminal cwd as session_registry_stale", async () => {
    registryCwd = foregroundOf(terminal).cwd;
    terminal = { ...terminal, cwd: "/elsewhere" };
    await publishTerminal();
    await refusal("session_registry_stale");
  });

  it("whose argv ends on --session-id as flag_missing_value", async () => {
    terminal = { ...terminal, argv: ["claude-klock", "--session-id"] };
    await publishTerminal();
    await refusal("flag_missing_value");
  });

  it("whose registry cannot be read as session_registry_unreadable", async () => {
    await mkdir(join(home, ".claude-klock", "sessions", `${foregroundOf(terminal).pid}.json`), { recursive: true });
    const run = await cli("t6c", "dev-home", "--dry-run", "--json");
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout).refused.reason).toBe("session_registry_unreadable");
  });

  it("on a machine that is not listed as unknown_machine", async () => {
    const run = await cli("t6c", "nowhere", "--dry-run", "--json");
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "unknown_machine", detail: expect.any(String) } });
  });

  it("on a machine that is not connected as machine_unreachable", async () => {
    const run = await cli("t6c", "abby-stg", "--dry-run", "--json");
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "machine_unreachable", detail: expect.any(String) } });
  });

  it("whose argv carries a flag outside the allowed list, naming it", async () => {
    terminal = { ...terminal, argv: ["claude-klock", "--add-dir", "/p"] };
    await publishTerminal();
    await registry(join(home, ".claude-klock"));
    const run = await cli("t6c", "dev-home", "--dry-run", "--json");
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "flag_not_allowed", detail: "--add-dir" } });
  });

  it("without a session registry as no_session", async () => {
    const run = await cli("t6c", "dev-home", "--dry-run", "--json");
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout).refused.reason).toBe("no_session");
  });

  it("when hc fails with exit 1 and hc_failed", async () => {
    await writeFile(join(state, "hc-fails"), "");
    const json = await cli("t6c", "dev-home", "--dry-run", "--json");
    const text = await cli("t6c", "dev-home", "--dry-run");
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ error: { reason: "hc_failed", detail: expect.stringContaining("hc exploded") } });
    expect(text.code).toBe(1);
    expect(text.stderr).toContain("hc_failed");
  });

  it("when hc prints output that is not JSON with exit 1 and hc_failed", async () => {
    await writeFile(join(state, "get.json"), "this is not json");
    const run = await cli("t6c", "dev-home", "--dry-run", "--json");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error.reason).toBe("hc_failed");
  });

  it("when hc prints JSON of an unexpected shape with exit 1 and hc_failed", async () => {
    await writeFile(join(state, "get.json"), JSON.stringify({ unexpected: true }));
    const run = await cli("t6c", "dev-home", "--dry-run", "--json");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      error: { reason: "hc_failed", detail: expect.stringContaining("unexpected shape") },
    });
  });

  it("when hc does not answer within the timeout as an hc failure", async () => {
    await script(join(bin, "hc"), `sleep 1\ncat "${join(state, "get.json")}"`);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    try {
      await expect(new Hc(processRunner(300)).terminal("t6c")).rejects.toThrow(HcError);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it.each([
    ["no arguments", []],
    ["a missing machine", ["t6c", "--dry-run"]],
    ["an extra argument", ["t6c", "dev-home", "x", "--dry-run"]],
    ["an unknown option", ["t6c", "dev-home", "--dry-run", "--frobnicate"]],
  ])("a wrong invocation (%s) with exit 2", async (_title, args) => {
    const run = await cli(...args);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("usage:");
  });
});
