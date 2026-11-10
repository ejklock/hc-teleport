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
    expect(calls).toEqual(["get t6c --json", "machine ls --json"]);
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
    expect(calls).toEqual(["get dev-home/t6c --json", "machine ls --json"]);
  });

  it("with the Mac source read from the home it is given, not from the remote machine", async () => {
    await plan("t6c", "dev-home");

    expect(remote.touched).toEqual([]);
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
    expect(remote.touched).toEqual([]);
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
