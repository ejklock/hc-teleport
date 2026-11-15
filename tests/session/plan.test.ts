import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hc } from "../../src/platform/hc.ts";
import { MachineError, type EntryKind, type ExecResult, type Machine } from "../../src/platform/machine.ts";
import { planSession } from "../../src/session/index.ts";

const SESSION_ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "hc-get-claude-klock.json");
const PROJECT_DIR = "-Volumes-Developer-www-klock-tecnologia-hc-teleport";

type Listed = { name: string; state: string };

/** What a remote machine holds: its home and the text files under it. */
class StubMachine implements Machine {
  readonly name: string;
  readonly files = new Map<string, string>();
  readonly touched: string[] = [];

  constructor(name: string) {
    this.name = name;
  }

  exec(argv: readonly string[]): Promise<ExecResult> {
    this.touched.push(argv.join(" "));
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }

  home(): Promise<string> {
    return Promise.resolve("/home/box");
  }

  readFile(path: string): Promise<string> {
    const text = this.files.get(path);
    if (text === undefined) return Promise.reject(new MachineError(this.name, "ENOENT", `read ${path}`));
    return Promise.resolve(text);
  }

  kind(): Promise<EntryKind | undefined> {
    return Promise.resolve(undefined);
  }

  writeFile(): Promise<void> {
    return Promise.reject(new Error("a plan never writes"));
  }

  realpath(): Promise<string> {
    return Promise.reject(new Error("a plan never resolves a path"));
  }

  entries(): Promise<never> {
    return Promise.reject(new Error("a plan never lists a folder"));
  }

  makeTempDir(): Promise<string> {
    return Promise.reject(new Error("a plan never makes a folder"));
  }

  remove(): Promise<void> {
    return Promise.reject(new Error("a plan never removes anything"));
  }
}

let root: string;
let home: string;
let calls: string[];
let listed: Listed[];
let remote: StubMachine;
let fixture: Record<string, unknown>;
let pid: number;
let cwd: string;

function hcCalls(): Hc {
  return new Hc((_program, args) => {
    calls.push(args.join(" "));
    if (args[0] === "get") {
      return Promise.resolve(JSON.stringify({ ...fixture, address: args[1], argv: ["claude"], status: { state: "done" } }));
    }
    return Promise.resolve(JSON.stringify({ machines: listed }));
  });
}

function plan(terminal: string, machine: string) {
  return planSession({ terminal, machine }, { hc: hcCalls(), home, machines: () => remote });
}

function registry(): string {
  return JSON.stringify({ pid, sessionId: SESSION_ID, cwd, version: "2.1.321" });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "plan-"));
  home = join(root, "home");
  await mkdir(join(home, ".claude", "sessions"), { recursive: true });
  fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  const foreground = fixture["foreground"] as { pid: number; cwd: string };
  pid = foreground.pid;
  cwd = String(fixture["cwd"]);
  await writeFile(join(home, ".claude", "sessions", `${pid}.json`), registry());
  calls = [];
  listed = [
    { name: "dev-home", state: "connected" },
    { name: "vps", state: "connected" },
    { name: "abby-stg", state: "unreachable" },
  ];
  remote = new StubMachine("dev-home");
  remote.files.set(`/home/box/.claude/sessions/${pid}.json`, registry());
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("plans a move from the address and the destination", () => {
  it("of a Mac terminal to an hc machine, reading the session on the Mac", async () => {
    const result = await plan("t6c", "dev-home");

    expect(result.ok && result.plan).toMatchObject({
      terminal: "t6c",
      source: "local",
      machine: "dev-home",
      session: { id: SESSION_ID, configDir: join(home, ".claude"), version: "2.1.321" },
      transcript: { file: join(home, ".claude", "projects", PROJECT_DIR, `${SESSION_ID}.jsonl`) },
      resume: { argv: ["claude", "--resume", SESSION_ID] },
    });
    expect(calls).toEqual(["get --json -- t6c", "machine ls --json"]);
  });

  it("of a terminal on an hc machine to the Mac, reading the session on that machine", async () => {
    const result = await plan("dev-home/t6c", "local");

    expect(result.ok && result.plan).toMatchObject({
      terminal: "dev-home/t6c",
      source: "dev-home",
      machine: "local",
      session: { id: SESSION_ID, configDir: "/home/box/.claude", version: "2.1.321" },
      transcript: { file: `/home/box/.claude/projects/${PROJECT_DIR}/${SESSION_ID}.jsonl` },
      resume: { argv: ["claude", "--resume", SESSION_ID] },
    });
    expect(calls).toEqual(["get --json -- dev-home/t6c", "machine ls --json"]);
  });

  it("with the Mac source read from the home it is given, not from the remote machine", async () => {
    await plan("t6c", "dev-home");

    expect(remote.touched.every((call) => call.startsWith("stat -c %d:%i -- "))).toBe(true);
  });
});

describe("plans a refusal of a move that does not have the Mac at exactly one end", () => {
  it.each([
    ["the Mac to itself", "t6c", "local", "same_machine"],
    ["a machine to itself", "dev-home/t6c", "dev-home", "same_machine"],
    ["one machine to another", "dev-home/t6c", "vps", "mac_not_an_end"],
    ["a machine that is not listed", "ghost/t6c", "local", "unknown_machine"],
    ["a machine that is not connected", "abby-stg/t6c", "local", "machine_unreachable"],
    ["a destination that is not listed", "t6c", "ghost", "unknown_machine"],
    ["a destination that is not connected", "t6c", "abby-stg", "machine_unreachable"],
  ])("for %s", async (_title, terminal, machine, reason) => {
    const result = await plan(terminal, machine);

    expect(result).toEqual({ ok: false, refusal: { reason, detail: expect.any(String) } });
    expect(calls.every((call) => call.startsWith("get ") || call === "machine ls --json")).toBe(true);
    expect(remote.touched.every((call) => call.startsWith("stat -c %d:%i -- "))).toBe(true);
  });

  it.each([["t6c", "dev-home"], ["dev-home/t6c", "local"], ["t6c", "local"], ["dev-home/t6c", "vps"]])(
    "when hc lists a machine named local, for %s to %s",
    async (terminal, machine) => {
      listed.push({ name: "local", state: "connected" });

      const result = await plan(terminal, machine);

      expect(result).toEqual({ ok: false, refusal: { reason: "local_name_taken", detail: expect.stringContaining("local") } });
      expect(calls.every((call) => call.startsWith("get ") || call === "machine ls --json")).toBe(true);
    },
  );

  it.each(["/t6c", "dev-home/", "a/b/t6c", "", "/"])("for the malformed address %j as terminal_not_running", async (terminal) => {
    const result = await plan(terminal, "dev-home");

    expect(result).toEqual({ ok: false, refusal: { reason: "terminal_not_running", detail: expect.stringContaining(JSON.stringify(terminal)) } });
    expect(calls).toEqual([]);
  });
});

describe("resumes a labelled session through env", () => {
  const BIN = "/home/u/.local/bin/claude";
  let configDir: string;

  async function planLabelled(flags: string[], wakeFlagsExtra: Record<string, unknown> = {}, foregroundProgram: string = BIN) {
    configDir = join(home, ".claude-klock");
    await mkdir(join(configDir, "sessions"), { recursive: true });
    await writeFile(join(configDir, "sessions", `${pid}.json`), registry());
    const wake = JSON.stringify({
      v: 1,
      agent: "claude",
      session_id: SESSION_ID,
      flags,
      env: { CLAUDE_CONFIG_DIR: configDir },
      bin: BIN,
      agent_proc: { pid },
      ...wakeFlagsExtra,
    });
    const hc = new Hc((_program, args) => {
      if (args[0] === "get") {
        return Promise.resolve(
          JSON.stringify({
            ...fixture,
            address: args[3],
            argv: ["/home/u/.local/bin/herdr-wake", "shell"],
            status: { state: "done" },
            labels: { wake },
            foreground: { ...(fixture["foreground"] as object), argv: [foregroundProgram] },
          }),
        );
      }
      return Promise.resolve(JSON.stringify({ machines: listed }));
    });
    return planSession({ terminal: "t6c", machine: "dev-home" }, { hc, home, machines: () => remote });
  }

  it("with the label's config dir and program and no flags", async () => {
    const result = await planLabelled([]);

    expect(result.ok && result.plan.resume.argv).toEqual(["env", `CLAUDE_CONFIG_DIR=${configDir}`, BIN, "--resume", SESSION_ID]);
    expect(result.ok && result.plan.session.configDir).toBe(configDir);
  });

  it("resumes a labelled session through env with the label's program when a wrapper left the bare name in the foreground", async () => {
    const result = await planLabelled([], {}, "claude");

    expect(result.ok && result.plan.resume.argv).toEqual(["env", `CLAUDE_CONFIG_DIR=${configDir}`, BIN, "--resume", SESSION_ID]);
  });

  it("keeping an allowed flag before --resume", async () => {
    const result = await planLabelled(["--model", "opus"]);

    expect(result.ok && result.plan.resume.argv).toEqual(["env", `CLAUDE_CONFIG_DIR=${configDir}`, BIN, "--model", "opus", "--resume", SESSION_ID]);
  });

  it("refuses a flag outside the allow-list", async () => {
    const result = await planLabelled(["--mcp-config", "x"]);

    expect(result).toEqual({ ok: false, refusal: { reason: "flag_not_allowed", detail: "--mcp-config" } });
  });

  it("dropping a --resume already in the flags", async () => {
    const result = await planLabelled(["--resume", SESSION_ID, "--verbose"]);

    expect(result.ok && result.plan.resume.argv).toEqual(["env", `CLAUDE_CONFIG_DIR=${configDir}`, BIN, "--verbose", "--resume", SESSION_ID]);
  });

  it("while an unlabelled terminal keeps the argv it started with", async () => {
    const result = await plan("t6c", "dev-home");

    expect(result.ok && result.plan.resume.argv).toEqual(["claude", "--resume", SESSION_ID]);
  });
});

/** A machine that answers `stat -c %d:%i` with a fixed reply, and records what it was asked. */
class StatMachine extends StubMachine {
  readonly asked: string[] = [];
  readonly #reply: () => ExecResult;

  constructor(name: string, reply: ExecResult | (() => ExecResult)) {
    super(name);
    this.#reply = typeof reply === "function" ? reply : () => reply;
  }

  override exec(argv: readonly string[]): Promise<ExecResult> {
    this.asked.push(argv.join(" "));
    return Promise.resolve(this.#reply());
  }
}

const stat = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

describe("plan proves one disk", () => {
  const FILE = `/home/box/.claude/projects/${PROJECT_DIR}/${SESSION_ID}.jsonl`;

  function planOn(terminal: string, machine: string, ends: Record<string, Machine>) {
    return planSession(
      { terminal, machine },
      {
        hc: hcCalls(),
        home,
        machines: (name) => {
          const found = ends[name];
          if (found === undefined) throw new Error(`no machine ${name}`);
          return found;
        },
      },
    );
  }

  function twoMachines(source: ExecResult | (() => ExecResult), destination: ExecResult | (() => ExecResult)) {
    const from = new StatMachine("dev-home", source);
    from.files.set(`/home/box/.claude/sessions/${pid}.json`, registry());
    return { dev: from, vps: new StatMachine("vps", destination) };
  }

  it.each([
    ["the same device and inode on both", stat("39:19323483\n"), stat("39:19323483\n"), true],
    ["a different inode", stat("39:19323483\n"), stat("39:19323484\n"), false],
    ["a different device", stat("39:19323483\n"), stat("40:19323483\n"), false],
    ["a failing stat on the destination", stat("39:19323483\n"), { code: 1, stdout: "", stderr: "No such file" }, false],
  ])("with %s", async (_title, sourceReply, destinationReply, relocate) => {
    const { dev, vps } = twoMachines(sourceReply, destinationReply);

    const result = await planOn("dev-home/t6c", "vps", { "dev-home": dev, vps });

    if (relocate) expect(result.ok && result.plan.relocate).toBe(true);
    else expect(result).toEqual({ ok: false, refusal: { reason: "mac_not_an_end", detail: expect.any(String) } });
    expect(dev.asked).toEqual([`stat -c %d:%i -- ${FILE}`]);
    expect(vps.asked).toEqual([`stat -c %d:%i -- ${FILE}`]);
  });

  it.each([
    ["an extra line", "39:1\nx\n"],
    ["a hex device", "0x27:1\n"],
    ["an empty line", "\n"],
    ["no newline at the end", "39:1"],
  ])("refuses both ends printing the same output with %s", async (_title, printed) => {
    const { dev, vps } = twoMachines(stat(printed), stat(printed));

    const result = await planOn("dev-home/t6c", "vps", { "dev-home": dev, vps });

    expect(result).toEqual({ ok: false, refusal: { reason: "mac_not_an_end", detail: expect.any(String) } });
  });

  it("plans a move between two machines on one disk", async () => {
    const { dev, vps } = twoMachines(stat("39:19323483\n"), stat("39:19323483\n"));

    const result = await planOn("dev-home/t6c", "vps", { "dev-home": dev, vps });

    expect(result.ok && result.plan).toMatchObject({ source: "dev-home", machine: "vps", relocate: true });
  });

  it("plans a Mac source to a machine on another disk without relocating", async () => {
    const vps = new StatMachine("vps", stat("1:2\n"));

    const result = await planOn("t6c", "vps", { vps });

    expect(result.ok && result.plan).toMatchObject({ source: "local", machine: "vps", relocate: false });
  });

  it("refuses a machine to itself before reading any disk", async () => {
    const { dev, vps } = twoMachines(stat("1:2\n"), stat("1:2\n"));

    const result = await planOn("dev-home/t6c", "dev-home", { "dev-home": dev, vps });

    expect(result).toEqual({ ok: false, refusal: { reason: "same_machine", detail: expect.any(String) } });
    expect(dev.asked).toEqual([]);
  });
});
