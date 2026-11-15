import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hc, HcError, type HcTerminal } from "../../src/platform/hc.ts";
import { processRunner } from "../../src/platform/process.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "src", "app", "cli.ts");
const SESSION_ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
const PROJECT_DIR = "-Volumes-Developer-www-klock-tecnologia-hc-teleport";

/**
 * Stands in for `hc exec` and `hc file read` on dev-home: the remote machine is this host, so its home is
 * the scratch HOME. It answers `find -P <path> -maxdepth 0 -printf %y`, which the host's own find cannot.
 */
const REMOTE_HC = `
import { lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const rest = args.slice(args.indexOf("--") + 1);
const b64 = (text) => Buffer.from(text).toString("base64");
const print = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const reply = (code, out, err) => print({ code, stdout: b64(out), stderr: b64(err), timed_out: false, truncated: false });
if (args[0] === "file") {
  try {
    const text = readFileSync(rest[0], "utf8");
    const lines = text.split("\\n").length;
    print({ text, last: lines, lines });
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: { kind: error.code === "ENOENT" ? "not_found" : "failed", message: error.message } }));
    process.exit(1);
  }
} else if (rest[0] === "find") {
  try {
    const stat = lstatSync(rest[2]);
    reply(0, stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : "f", "");
  } catch (error) {
    reply(1, "", "find: '" + rest[2] + "': " + (error.code === "ENOENT" ? "No such file or directory" : "Permission denied"));
  }
} else {
  const ran = spawnSync(rest[0], rest.slice(1), { encoding: "utf8" });
  reply(ran.status ?? 1, ran.stdout, ran.stderr);
}
`;

type Run = { code: number; stdout: string; stderr: string };

let scratch: string;
let home: string;
let bin: string;
let state: string;
let terminal: HcTerminal;
let registryCwd: string | undefined;
let extraEnv: Record<string, string> = {};

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

function configFile(base = join(home, ".config")): string {
  return join(base, "hc-teleport", "config.json");
}

async function configure(allowed: readonly string[], base?: string): Promise<void> {
  await mkdir(dirname(configFile(base)), { recursive: true });
  await writeFile(configFile(base), JSON.stringify({ v: 1, allowed }));
}

async function coreNamed(name: string): Promise<void> {
  await writeFile(join(state, "server.json"), JSON.stringify({ core: { id: "8d4a003f50c1efe47c29866c4ead22be", name }, version: "0.1.21" }));
}

function cli(...args: string[]): Promise<Run> {
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_STATE: state, ...extraEnv };
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
  extraEnv = {};
  scratch = await mkdtemp(join(tmpdir(), "dry-run-"));
  home = join(scratch, "home");
  bin = join(scratch, "bin");
  state = join(scratch, "state");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(state)]);
  await script(
    join(bin, "hc"),
    `echo "$*" >> "$FAKE_STATE/hc-calls"
[ "$1 $2" = "server status" ] && { [ -f "$FAKE_STATE/server-fails" ] && { echo "hc server down" >&2; exit 1; }; cat "$FAKE_STATE/server.json"; exit 0; }
[ -f "$FAKE_STATE/hc-fails" ] && { echo "hc exploded" >&2; exit 1; }
case "$1 $2 $3 $4" in
  "get --json -- t6c") cat "$FAKE_STATE/get.json" ;;
  "machine ls --json "*) cat "$FAKE_STATE/machines.json" ;;
  "get --json -- "*"/t6c") cat "$FAKE_STATE/get.json" ;;
  "exec --json --on=dev-home "*) case " $* " in *" -- printenv "*) [ -f "$FAKE_STATE/source-home-fails" ] && { echo "hc cannot reach dev-home" >&2; exit 1; } ;; esac
    "${process.execPath}" "${join(bin, "remote.mjs")}" "$@" ;;
  "exec --json -- "*|"exec --json --timeout "*|"file read --json "*) "${process.execPath}" "${join(bin, "remote.mjs")}" "$@" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac`,
  );
  await writeFile(join(bin, "remote.mjs"), REMOTE_HC);
  await script(
    join(bin, "claude-klock"),
    `[ "$1" = "--where" ] && printf '%s\\n' "${home}/.claude-klock"; [ "$1" = "--version" ] && echo "2.1.321 (Claude Code)"; exit 0`,
  );
  terminal = await parseTerminal(await fixture("hc-get-claude-klock.json"));
  await withStatus({ app: "claude-code", state: "done" });
  await publishTerminal();
  await writeFile(join(state, "machines.json"), JSON.stringify(await fixture("hc-machine-ls.json")));
  await coreNamed("mac-core");
  await configure(["local", "dev-home", "base-digital", "nowhere", "abby-stg"]);
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
      relocate: false,
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

describe("dry-run of a session that runs on an hc machine", () => {
  it("prints the plan read on that machine as one JSON object", async () => {
    const configDir = join(home, ".claude-klock");
    await registry(configDir);

    const run = await cli("dev-home/t6c", "local", "--dry-run", "--json");

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      terminal: "dev-home/t6c",
      source: "dev-home",
      machine: "local",
      cwd: terminal.cwd,
      session: { id: SESSION_ID, configDir, version: "2.1.321" },
      transcript: { file: join(configDir, "projects", PROJECT_DIR, `${SESSION_ID}.jsonl`), dir: null },
      resume: { argv: ["claude-klock", "--resume", SESSION_ID] },
      relocate: false,
    });
  });

  it("reports the subagent folder it finds on that machine", async () => {
    const configDir = join(home, ".claude-klock");
    await registry(configDir);
    const dir = join(configDir, "projects", PROJECT_DIR, SESSION_ID);
    await mkdir(join(dir, "subagents"), { recursive: true });

    const run = await cli("dev-home/t6c", "local", "--dry-run", "--json");

    expect(JSON.parse(run.stdout).transcript.dir).toBe(dir);
  });

  it("names both ends readably without --json", async () => {
    await registry(join(home, ".claude-klock"));

    const run = await cli("dev-home/t6c", "local", "--dry-run");

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^source\s+dev-home$/m);
    expect(run.stdout).toMatch(/^machine\s+local$/m);
    expect(run.stderr).toBe("");
  });

  it("refuses a registry that is not there on that machine as no_session", async () => {
    const run = await cli("dev-home/t6c", "local", "--dry-run", "--json");

    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout).refused.reason).toBe("no_session");
  });
});

describe("dry-run refuses a move without the Mac at exactly one end", () => {
  it.each([
    ["the Mac to itself", ["t6c", "local"], "same_machine"],
    ["a machine to itself", ["dev-home/t6c", "dev-home"], "same_machine"],
    ["one machine to another", ["dev-home/t6c", "base-digital"], "mac_not_an_end"],
    ["a source that is not listed", ["ghost/t6c", "local"], "unknown_machine"],
    ["a source that is not connected", ["abby-stg/t6c", "local"], "machine_unreachable"],
    ["an address with no terminal", ["dev-home/", "local"], "terminal_not_running"],
    ["an address with a machine name missing", ["/t6c", "dev-home"], "terminal_not_running"],
  ])("for %s as exit 3", async (_title, [terminalArg = "", machineArg = ""], reason) => {
    await registry(join(home, ".claude-klock"));

    const json = await cli(terminalArg, machineArg, "--dry-run", "--json");
    const text = await cli(terminalArg, machineArg, "--dry-run");

    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({ refused: { reason, detail: expect.any(String) } });
    expect(text.code).toBe(3);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain(reason);
  });

  it("when hc lists a machine named local as local_name_taken", async () => {
    const listed = await fixture("hc-machine-ls.json");
    await writeFile(join(state, "machines.json"), JSON.stringify({ machines: [...(listed["machines"] as unknown[]), { name: "local", state: "connected" }] }));

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "local_name_taken", detail: expect.stringContaining("local") } });
  });
});

describe("a move without --dry-run of a session that is not on the Mac", () => {
  it("reports an hc failure as hc_failed with exit 1, not as a refusal of the way back", async () => {
    await writeFile(join(state, "hc-fails"), "");

    const json = await cli("dev-home/t6c", "local", "--json");
    const text = await cli("dev-home/t6c", "local");

    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ error: { reason: "hc_failed", detail: expect.any(String) } });
    expect(text.code).toBe(1);
    expect(text.stderr).toContain("hc_failed");
    expect(text.stderr).not.toContain("way_back_not_ready");
  });

  it("reports hc failing to read the source's home, after the checks pass, as hc_failed with exit 1 and writes nothing", async () => {
    await registry(join(home, ".claude-klock"));
    await writeFile(join(state, "source-home-fails"), "");

    const run = await cli("dev-home/t6c", "local", "--json");

    expect(JSON.parse(run.stdout)).toEqual({ error: { reason: "hc_failed", detail: expect.stringContaining("hc cannot reach dev-home") } });
    expect(run.code).toBe(1);
  });

  it("refuses a move with the Mac at neither end with the plan's reason, as --dry-run does", async () => {
    await registry(join(home, ".claude-klock"));
    const move = await cli("dev-home/t6c", "base-digital", "--json");

    expect(move.code).toBe(3);
    expect(JSON.parse(move.stdout)).toEqual({ refused: { reason: "mac_not_an_end", detail: expect.any(String) } });
  });

  it.each(["/t6c", "local/t6c", "a/b/t6c", "dev-home/"])("refuses the malformed address %s as terminal_not_running, as --dry-run does", async (address) => {
    await writeFile(join(state, "hc-fails"), "");

    const move = await cli(address, "local", "--json");
    const dry = await cli(address, "local", "--dry-run", "--json");

    expect(move.code).toBe(3);
    expect(JSON.parse(move.stdout)).toEqual({ refused: { reason: "terminal_not_running", detail: expect.any(String) } });
    expect(dry.code).toBe(move.code);
    expect(dry.stdout).toBe(move.stdout);
  });
});

describe("dry-run refuses a session whose folder cannot be read as session_unreadable", () => {
  it.skipIf(process.getuid?.() === 0)("on the Mac and on an hc machine", async () => {
    const configDir = join(home, ".claude-klock");
    await registry(configDir);
    const projectDir = join(configDir, "projects", PROJECT_DIR);
    await mkdir(projectDir, { recursive: true });
    await chmod(projectDir, 0o000);

    try {
      for (const args of [["t6c", "dev-home"], ["dev-home/t6c", "local"]]) {
        const run = await cli(...args, "--dry-run", "--json");

        expect(run.code, args.join(" ")).toBe(3);
        expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "session_unreadable", detail: expect.stringContaining(SESSION_ID) } });
      }
    } finally {
      await chmod(projectDir, 0o755);
    }
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

describe("requires the config for a move and a dry-run", () => {
  async function noConfig(): Promise<void> {
    await rm(join(home, ".config"), { recursive: true, force: true });
  }

  it.each([["--dry-run"], []])("refuses not_initialized naming init and the path (flags %j)", async (...flags) => {
    await noConfig();
    await registry(join(home, ".claude-klock"));

    const json = await cli("t6c", "dev-home", ...flags, "--json");
    const text = await cli("t6c", "dev-home", ...flags);

    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({ refused: { reason: "not_initialized", detail: expect.stringContaining("hc-teleport init") } });
    expect(JSON.parse(json.stdout).refused.detail).toContain(configFile());
    expect(text.code).toBe(3);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("not_initialized");
  });

  it("asks no hc question before it refuses", async () => {
    await noConfig();

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "not_initialized", detail: expect.any(String) } });
    expect(await readFile(join(state, "hc-calls"), "utf8").catch(() => "")).toBe("");
  });

  it("refuses config_unreadable naming the path when the file is not JSON", async () => {
    await writeFile(configFile(), "{nope");

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "config_unreadable", detail: expect.stringContaining(configFile()) } });
  });

  it.each([
    ["version 2", '{"v":2,"allowed":["local"]}'],
    ["allowed not an array", '{"v":1,"allowed":"local"}'],
    ["an empty entry", '{"v":1,"allowed":["local",""]}'],
    ["a non-string entry", '{"v":1,"allowed":[7]}'],
  ])("refuses config_unreadable for %s", async (_title, text) => {
    await writeFile(configFile(), text);

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout).refused.reason).toBe("config_unreadable");
  });

  it("reads the config from an absolute XDG_CONFIG_HOME, not from HOME", async () => {
    await noConfig();
    const xdg = join(scratch, "xdg");
    await configure(["local", "dev-home"], xdg);
    await registry(join(home, ".claude-klock"));
    extraEnv = { XDG_CONFIG_HOME: xdg };

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { machine: string }).machine).toBe("dev-home");
  });

  it.each([["relative/xdg"], [""]])("reads $HOME/.config when XDG_CONFIG_HOME is %j", async (xdg) => {
    await registry(join(home, ".claude-klock"));
    extraEnv = { XDG_CONFIG_HOME: xdg };

    const run = await cli("t6c", "dev-home", "--dry-run", "--json");

    expect(run.code).toBe(0);
  });
});

describe("allows only configured destinations", () => {
  const plan = (...args: string[]) => cli(...args, "--dry-run", "--json");

  beforeEach(async () => {
    await configure(["local", "base-digital"]);
    await registry(join(home, ".claude-klock"));
  });

  it("plans a configured hc machine", async () => {
    const run = await plan("t6c", "base-digital");

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { machine: string }).machine).toBe("base-digital");
  });

  it.each([["--dry-run"], []])("refuses a machine outside the config, naming it and the config path (flags %j)", async (...flags) => {
    const run = await cli("t6c", "planet-argon", ...flags, "--json");

    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ refused: { reason: "machine_not_allowed", detail: expect.stringContaining("planet-argon") } });
    expect(JSON.parse(run.stdout).refused.detail).toContain(configFile());
  });

  it("plans local", async () => {
    const run = await plan("dev-home/t6c", "local");

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { machine: string }).machine).toBe("local");
  });

  it("takes the core's name to mean local", async () => {
    await coreNamed("box");

    const run = await plan("dev-home/t6c", "box");

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { machine: string }).machine).toBe("local");
  });

  it("refuses the core's name when local is not allowed", async () => {
    await coreNamed("box");
    await configure(["base-digital"]);

    const run = await plan("dev-home/t6c", "box");

    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout).refused).toEqual({ reason: "machine_not_allowed", detail: expect.stringContaining("box") });
  });

  it("keeps an hc machine named like the core as that machine, not local", async () => {
    await coreNamed("dev-home");
    await configure(["dev-home"]);

    const allowed = await plan("t6c", "dev-home");
    await configure(["local"]);
    const refused = await plan("t6c", "dev-home");

    expect((JSON.parse(allowed.stdout) as { machine: string }).machine).toBe("dev-home");
    expect(JSON.parse(refused.stdout).refused.reason).toBe("machine_not_allowed");
  });

  it("reports hc server status failing as hc_failed with exit 1", async () => {
    await writeFile(join(state, "server-fails"), "");

    const run = await plan("t6c", "base-digital");

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ error: { reason: "hc_failed", detail: expect.stringContaining("hc server down") } });
  });
});

describe("init wizard from the command line", () => {
  it("refuses not_interactive without a terminal and writes nothing", async () => {
    await rm(join(home, ".config"), { recursive: true, force: true });
    const before = await tree(home);

    const json = await cli("init", "--json");
    const text = await cli("init");

    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({ refused: { reason: "not_interactive", detail: expect.any(String) } });
    expect(text.code).toBe(3);
    expect(text.stderr).toContain("not_interactive");
    expect(await tree(home)).toEqual(before);
  });
});

describe("doctor from the command line", () => {
  it("refuses not_initialized without a config and exits 3", async () => {
    await rm(join(home, ".config"), { recursive: true, force: true });

    const run = await cli("doctor", "--json");

    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout).refused.reason).toBe("not_initialized");
  });

  it("prints one JSON line per allowed machine and exits 0 when all are ok", async () => {
    await script(join(bin, "claude"), 'echo "2.1.321 (Claude Code)"');
    await configure(["local"]);

    const run = await cli("doctor", "--json");

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ machines: [{ name: "local", status: "ok", detail: "2.1.321 (Claude Code)" }] });
  });

  it("exits 1 and names a machine hc no longer lists", async () => {
    await configure(["gone-box"]);

    const run = await cli("doctor");

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("gone-box");
    expect(run.stdout).toContain("not in hc machine ls");
  });

  it("reports an hc failure as hc_failed with exit 1", async () => {
    await configure(["base-digital"]);
    await writeFile(join(state, "hc-fails"), "");

    const run = await cli("doctor", "--json");

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error.reason).toBe("hc_failed");
  });
});

describe("dry-run reports whether the session relocates", () => {
  async function transcript(): Promise<void> {
    const configDir = join(home, ".claude-klock");
    await registry(configDir);
    await mkdir(join(configDir, "projects", PROJECT_DIR), { recursive: true });
    await writeFile(join(configDir, "projects", PROJECT_DIR, `${SESSION_ID}.jsonl`), "{}\n");
  }

  it("prints relocate true as JSON and a relocate line when both ends see the transcript as one file", async () => {
    await transcript();

    const json = await cli("t6c", "dev-home", "--dry-run", "--json");
    const text = await cli("t6c", "dev-home", "--dry-run");

    expect(json.code).toBe(0);
    expect((JSON.parse(json.stdout) as { relocate: boolean }).relocate).toBe(true);
    expect(text.stdout).toMatch(/^relocate\s+true$/m);
  });

  it("prints relocate false when the destination cannot see the transcript", async () => {
    await registry(join(home, ".claude-klock"));

    const json = await cli("t6c", "dev-home", "--dry-run", "--json");
    const text = await cli("t6c", "dev-home", "--dry-run");

    expect((JSON.parse(json.stdout) as { relocate: boolean }).relocate).toBe(false);
    expect(text.stdout).toMatch(/^relocate\s+false$/m);
  });
});
