import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HcTerminal } from "../../src/platform/hc.ts";
import { LocalMachine, MachineError, type EntryKind, type ExecResult, type Machine, type MachineExecOptions, type MachineErrorCode } from "../../src/platform/machine.ts";
import type { RemoteRun } from "../../src/session/agent-adapter.ts";
import { ClaudeAdapter } from "../../src/session/claude-adapter.ts";

const SESSION_ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "hc-get-claude-klock.json");

/** This host with a home of the test's choosing, so a plain `claude` reads under the fixture folder. */
function macAt(homeDir: string): Machine {
  return Object.assign(new LocalMachine(), { home: () => Promise.resolve(homeDir) });
}

/** A machine whose files, kinds and programs are what the test says; it records every program it ran. */
class StubMachine implements Machine {
  readonly name: string;
  readonly files = new Map<string, string>();
  readonly kinds = new Map<string, EntryKind>();
  readonly ran: (readonly string[])[] = [];
  readonly reads: string[] = [];
  readonly limits: (number | undefined)[] = [];
  kindFailure: MachineErrorCode | undefined;
  where: ExecResult = { code: 0, stdout: "", stderr: "" };
  homeDir = "/home/box";

  constructor(name: string) {
    this.name = name;
  }

  exec(argv: readonly string[], options: MachineExecOptions = {}): Promise<ExecResult> {
    this.ran.push(argv);
    this.limits.push(options.timeoutSeconds);
    return Promise.resolve(this.where);
  }

  home(): Promise<string> {
    return Promise.resolve(this.homeDir);
  }

  readFile(path: string): Promise<string> {
    this.reads.push(path);
    const content = this.files.get(path) ?? "ENOENT";
    if (content === "ENOENT" || content === "not_text" || content === "failed") {
      return Promise.reject(new MachineError(this.name, content, `read ${path}`));
    }
    return Promise.resolve(content);
  }

  kind(path: string): Promise<EntryKind | undefined> {
    if (this.kindFailure !== undefined) return Promise.reject(new MachineError(this.name, this.kindFailure, `stat ${path}`));
    return Promise.resolve(this.kinds.get(path));
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
let launcher: string;

async function terminalFixture(): Promise<HcTerminal> {
  const raw: unknown = JSON.parse(await readFile(FIXTURE, "utf8"));
  const { Hc } = await import("../../src/platform/hc.ts");
  return new Hc(async () => JSON.stringify(raw)).terminal("t6c");
}

async function writeLauncher(body: string): Promise<void> {
  await writeFile(launcher, `#!/bin/sh\n${body}\n`);
  await chmod(launcher, 0o755);
}

async function writeRegistry(configDir: string, pid: number, content: unknown): Promise<void> {
  await mkdir(join(configDir, "sessions"), { recursive: true });
  const text = typeof content === "string" ? content : JSON.stringify(content);
  await writeFile(join(configDir, "sessions", `${pid}.json`), text);
}

function launcherTerminal(base: HcTerminal): HcTerminal {
  return { ...base, argv: [launcher, "a prompt"] };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "adapter-"));
  home = join(root, "home");
  await mkdir(home);
  launcher = join(root, "claude-klock");
  await writeLauncher(`[ "$1" = "--where" ] && printf '%s\\n' '${join(home, ".claude-klock")}'`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("finds the session", () => {
  it("through the launcher's config dir and the pid registry", async () => {
    const base = await terminalFixture();
    const pid = base.foreground?.pid ?? 0;
    const configDir = join(home, ".claude-klock");
    await writeRegistry(configDir, pid, { pid, sessionId: SESSION_ID, cwd: base.cwd, version: "2.1.321", status: "busy" });

    const result = await new ClaudeAdapter(macAt(home)).findSession(launcherTerminal(base));

    expect(result).toEqual({
      ok: true,
      session: {
        id: SESSION_ID,
        configDir,
        version: "2.1.321",
        transcript: {
          file: join(configDir, "projects", "-Volumes-Developer-www-klock-tecnologia-hc-teleport", `${SESSION_ID}.jsonl`),
        },
      },
    });
  });

  it("of a plain claude terminal in the home's default config dir", async () => {
    const base = await terminalFixture();
    const pid = base.foreground?.pid ?? 0;
    await writeRegistry(join(home, ".claude"), pid, { pid, sessionId: SESSION_ID, cwd: base.cwd });

    const result = await new ClaudeAdapter(macAt(home)).findSession({ ...base, argv: ["claude"] });

    expect(result.ok && result.session.configDir).toBe(join(home, ".claude"));
    expect(result.ok && result.session.version).toBeUndefined();
  });

  it("and reports the subagent directory when it exists", async () => {
    const base = await terminalFixture();
    const pid = base.foreground?.pid ?? 0;
    const configDir = join(home, ".claude-klock");
    await writeRegistry(configDir, pid, { pid, sessionId: SESSION_ID, cwd: base.cwd });
    const projectDir = join(configDir, "projects", "-Volumes-Developer-www-klock-tecnologia-hc-teleport");
    await mkdir(join(projectDir, SESSION_ID, "subagents"), { recursive: true });

    const result = await new ClaudeAdapter(macAt(home)).findSession(launcherTerminal(base));

    expect(result.ok && result.session.transcript.dir).toBe(join(projectDir, SESSION_ID));
  });

  it("maps a cwd with spaces, dots and non-ASCII letters to the dashed project directory", async () => {
    const base = await terminalFixture();
    const cwd = "/Volumes/Dev x/ré.po/ça";
    const pid = base.foreground?.pid ?? 0;
    const configDir = join(home, ".claude-klock");
    await writeRegistry(configDir, pid, { pid, sessionId: SESSION_ID, cwd });
    const foreground = base.foreground === undefined ? undefined : { ...base.foreground, cwd };

    const result = await new ClaudeAdapter(macAt(home)).findSession({
      ...launcherTerminal(base),
      cwd,
      ...(foreground === undefined ? {} : { foreground }),
    });

    expect(result.ok && result.session.transcript.file).toBe(
      join(configDir, "projects", "-Volumes-Dev-x-r--po--a", `${SESSION_ID}.jsonl`),
    );
  });

  describe("refuses", () => {
    type Case = { title: string; reason: string; registry?: (base: HcTerminal) => unknown };
    const pidOf = (base: HcTerminal): number => base.foreground?.pid ?? 0;
    const cases: Case[] = [
      { title: "an absent registry file", reason: "no_session" },
      { title: "malformed registry JSON", reason: "session_registry_unreadable", registry: () => "{not json" },
      {
        title: "a registry without a sessionId",
        reason: "session_registry_unreadable",
        registry: (b) => ({ pid: pidOf(b), cwd: b.cwd }),
      },
      {
        title: "a registry without a pid",
        reason: "session_registry_unreadable",
        registry: (b) => ({ sessionId: SESSION_ID, cwd: b.cwd }),
      },
      {
        title: "a registry without a cwd",
        reason: "session_registry_unreadable",
        registry: (b) => ({ pid: pidOf(b), sessionId: SESSION_ID }),
      },
      {
        title: "a sessionId that is not a UUID",
        reason: "session_registry_unreadable",
        registry: (b) => ({ pid: pidOf(b), sessionId: "../../etc/passwd", cwd: b.cwd }),
      },
      {
        title: "a registry whose pid differs from the foreground pid",
        reason: "session_registry_stale",
        registry: (b) => ({ pid: pidOf(b) + 1, sessionId: SESSION_ID, cwd: b.cwd }),
      },
      {
        title: "a registry whose cwd differs from the terminal's",
        reason: "session_registry_stale",
        registry: (b) => ({ pid: pidOf(b), sessionId: SESSION_ID, cwd: `${b.cwd}/other` }),
      },
    ];

    it.each(cases)("$title as $reason", async ({ reason, registry }) => {
      const base = await terminalFixture();
      if (registry !== undefined) await writeRegistry(join(home, ".claude-klock"), pidOf(base), registry(base));

      const result = await new ClaudeAdapter(macAt(home)).findSession(launcherTerminal(base));

      expect(result).toEqual({ ok: false, refusal: { reason, detail: expect.any(String) } });
    });

    it("a registry that matches only one of the two cwds as session_registry_stale", async () => {
      const base = await terminalFixture();
      const foreground = base.foreground;
      if (foreground === undefined) throw new Error("the fixture has no foreground process");
      const pid = foreground.pid;
      const stale = { reason: "session_registry_stale", detail: expect.any(String) };

      await writeRegistry(join(home, ".claude-klock"), pid, { pid, sessionId: SESSION_ID, cwd: base.cwd });
      const foregroundMoved = { ...launcherTerminal(base), foreground: { ...foreground, cwd: "/elsewhere" } };
      expect(await new ClaudeAdapter(macAt(home)).findSession(foregroundMoved)).toEqual({ ok: false, refusal: stale });

      await writeRegistry(join(home, ".claude-klock"), pid, { pid, sessionId: SESSION_ID, cwd: foreground.cwd });
      const terminalMoved = { ...launcherTerminal(base), cwd: "/elsewhere" };
      expect(await new ClaudeAdapter(macAt(home)).findSession(terminalMoved)).toEqual({ ok: false, refusal: stale });
    });

    it("a registry path that cannot be read as session_registry_unreadable", async () => {
      const base = await terminalFixture();
      await mkdir(join(home, ".claude-klock", "sessions", `${base.foreground?.pid ?? 0}.json`), { recursive: true });

      const result = await new ClaudeAdapter(macAt(home)).findSession(launcherTerminal(base));

      expect(result).toEqual({ ok: false, refusal: { reason: "session_registry_unreadable", detail: expect.any(String) } });
    });

    it("a launcher whose --where fails as config_dir_unknown", async () => {
      await writeLauncher("exit 1");
      const result = await new ClaudeAdapter(macAt(home)).findSession(launcherTerminal(await terminalFixture()));
      expect(result).toEqual({ ok: false, refusal: { reason: "config_dir_unknown", detail: expect.any(String) } });
    });

    it("a launcher whose --where prints nothing as config_dir_unknown", async () => {
      await writeLauncher("exit 0");
      const result = await new ClaudeAdapter(macAt(home)).findSession(launcherTerminal(await terminalFixture()));
      expect(result).toEqual({ ok: false, refusal: { reason: "config_dir_unknown", detail: expect.any(String) } });
    });

    it("a foreground process that is not claude as not_claude", async () => {
      const base = await terminalFixture();
      const foreground = base.foreground === undefined ? undefined : { ...base.foreground, argv: ["node", "x.js"] };
      const result = await new ClaudeAdapter(macAt(home)).findSession({
        ...launcherTerminal(base),
        ...(foreground === undefined ? {} : { foreground }),
      });
      expect(result).toEqual({ ok: false, refusal: { reason: "not_claude", detail: expect.any(String) } });
    });
  });
});

describe("reads the session through the source machine", () => {
  const registryFile = (configDir: string, base: HcTerminal): string => join(configDir, "sessions", `${base.foreground?.pid ?? 0}.json`);
  const registryText = (base: HcTerminal): string =>
    JSON.stringify({ pid: base.foreground?.pid ?? 0, sessionId: SESSION_ID, cwd: base.cwd, version: "2.1.321" });

  it("running the launcher's --where on that machine and reading its registry there", async () => {
    const base = await terminalFixture();
    const machine = new StubMachine("dev-home");
    machine.where = { code: 0, stdout: "/home/box/.claude-klock\n", stderr: "" };
    machine.files.set(registryFile("/home/box/.claude-klock", base), registryText(base));

    const result = await new ClaudeAdapter(machine).findSession({ ...base, argv: ["claude-klock", "a prompt"] });

    expect(machine.ran).toEqual([["claude-klock", "--where"]]);
    expect(machine.limits).toEqual([15]);
    expect(result).toMatchObject({ ok: true, session: { id: SESSION_ID, configDir: "/home/box/.claude-klock" } });
  });

  it("mapping a plain claude to the home of that machine", async () => {
    const base = await terminalFixture();
    const machine = new StubMachine("dev-home");
    machine.files.set(registryFile("/home/box/.claude", base), registryText(base));

    const result = await new ClaudeAdapter(machine).findSession({ ...base, argv: ["claude"] });

    expect(machine.ran).toEqual([]);
    expect(result).toMatchObject({ ok: true, session: { configDir: "/home/box/.claude" } });
  });

  it("refusing a launcher that fails there as config_dir_unknown", async () => {
    const base = await terminalFixture();
    const machine = new StubMachine("dev-home");
    machine.where = { code: 127, stdout: "", stderr: "not found" };

    const result = await new ClaudeAdapter(machine).findSession({ ...base, argv: ["claude-klock"] });

    expect(result).toEqual({ ok: false, refusal: { reason: "config_dir_unknown", detail: expect.stringContaining("not found") } });
  });

  it.each([
    ["an absent registry", "ENOENT", "no_session"],
    ["a registry that is not text", "not_text", "session_registry_unreadable"],
    ["a registry the machine refuses to read", "failed", "session_registry_unreadable"],
  ] as const)("refusing %s", async (_title, failure, reason) => {
    const base = await terminalFixture();
    const machine = new StubMachine("dev-home");
    if (failure !== "ENOENT") machine.files.set(registryFile("/home/box/.claude", base), failure);

    const result = await new ClaudeAdapter(machine).findSession({ ...base, argv: ["claude"] });

    expect(result).toEqual({ ok: false, refusal: { reason, detail: expect.any(String) } });
  });

  it.each([
    ["a folder", "dir", true],
    ["a symlink", "symlink", false],
    ["a file", "file", false],
    ["nothing", undefined, false],
  ] as const)("reporting the subagent folder only when the path is a folder (%s)", async (_title, kind, present) => {
    const base = await terminalFixture();
    const machine = new StubMachine("dev-home");
    machine.files.set(registryFile("/home/box/.claude", base), registryText(base));
    const folder = `/home/box/.claude/projects/-Volumes-Developer-www-klock-tecnologia-hc-teleport/${SESSION_ID}`;
    if (kind !== undefined) machine.kinds.set(folder, kind);

    const result = await new ClaudeAdapter(machine).findSession({ ...base, argv: ["claude"] });

    expect(result.ok && result.session.transcript.dir).toBe(present ? folder : undefined);
  });
});

describe("refuses a session whose folder the source cannot read as unreadable", () => {
  const registryText = (base: HcTerminal): string => JSON.stringify({ pid: base.foreground?.pid ?? 0, sessionId: SESSION_ID, cwd: base.cwd });

  it.each(["failed", "exec_failed"] as const)("when the machine rejects the folder with %s", async (failure) => {
    const base = await terminalFixture();
    const machine = new StubMachine("dev-home");
    machine.files.set(`/home/box/.claude/sessions/${base.foreground?.pid ?? 0}.json`, registryText(base));
    machine.kindFailure = failure;

    const result = await new ClaudeAdapter(machine).findSession({ ...base, argv: ["claude"] });

    const folder = `/home/box/.claude/projects/-Volumes-Developer-www-klock-tecnologia-hc-teleport/${SESSION_ID}`;
    expect(result).toEqual({ ok: false, refusal: { reason: "session_unreadable", detail: expect.stringContaining(folder) } });
  });

  it.skipIf(process.getuid?.() === 0)("when a folder above the session folder on the Mac has mode 000", async () => {
    const base = await terminalFixture();
    const pid = base.foreground?.pid ?? 0;
    const configDir = join(home, ".claude");
    await writeRegistry(configDir, pid, { pid, sessionId: SESSION_ID, cwd: base.cwd });
    const projectDir = join(configDir, "projects", "-Volumes-Developer-www-klock-tecnologia-hc-teleport");
    await mkdir(projectDir, { recursive: true });
    await chmod(projectDir, 0o000);

    try {
      const result = await new ClaudeAdapter(macAt(home)).findSession({ ...base, argv: ["claude"] });

      expect(result).toEqual({ ok: false, refusal: { reason: "session_unreadable", detail: expect.stringContaining(SESSION_ID) } });
    } finally {
      await chmod(projectDir, 0o755);
    }
  });
});

describe("confirms the session resumed", () => {
  const DEST_CONFIG = "/home/dev/.claude-klock";
  const OTHER_ID = "11111111-2222-4333-8444-555555555555";
  const registryPath = (pid: number): string => `${DEST_CONFIG}/sessions/${pid}.json`;
  const expected = { sessionId: SESSION_ID, configDir: DEST_CONFIG };

  type Stub = { remote: RemoteRun; argvs: (readonly string[])[] };

  function stubRemote(files: Record<string, string>): Stub {
    const argvs: (readonly string[])[] = [];
    const remote: RemoteRun = {
      machine: "dev-home",
      async run(argv) {
        argvs.push(argv);
        const [program, ...rest] = argv;
        if (program === "test" && rest[0] === "-e") {
          return { code: rest[1] !== undefined && rest[1] in files ? 0 : 1, stdout: "", stderr: "" };
        }
        if (program === "cat" && rest[0] === "--") {
          const text = files[rest[1] ?? ""];
          return text === undefined ? { code: 1, stdout: "", stderr: "No such file" } : { code: 0, stdout: text, stderr: "" };
        }
        return { code: 127, stdout: "", stderr: "unexpected command" };
      },
    };
    return { remote, argvs };
  }

  async function live(): Promise<HcTerminal> {
    return { ...(await terminalFixture()), argv: ["claude", "--resume", SESSION_ID] };
  }

  const pidOf = (terminal: HcTerminal): number => terminal.foreground?.pid ?? 0;
  const entry = (terminal: HcTerminal, over: Record<string, unknown> = {}): string =>
    JSON.stringify({ pid: pidOf(terminal), sessionId: SESSION_ID, cwd: terminal.cwd, version: "2.1.321", ...over });

  it("an agent started directly whose registry names the expected session", async () => {
    const terminal = await live();
    const { remote } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

    expect(await new ClaudeAdapter(macAt(home)).confirmResumed(terminal, expected, remote)).toEqual({ ok: true });
  });

  it("an agent started through a wrapper whose terminal argv[0] is the wrapper", async () => {
    const terminal = { ...(await live()), argv: ["claude-klock", "--resume", SESSION_ID] };
    const { remote } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

    expect(await new ClaudeAdapter(macAt(home)).confirmResumed(terminal, expected, remote)).toEqual({ ok: true });
  });

  it("a folder with a space and non-ASCII characters", async () => {
    const base = await live();
    const cwd = "/home/dev/meu projeto/ação";
    const terminal = { ...base, cwd, ...(base.foreground === undefined ? {} : { foreground: { ...base.foreground, cwd } }) };
    const { remote } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

    expect(await new ClaudeAdapter(macAt(home)).confirmResumed(terminal, expected, remote)).toEqual({ ok: true });
  });

  describe("refuses", () => {
    type Case = {
      title: string;
      reason: string;
      terminal?: (base: HcTerminal) => HcTerminal;
      file?: (base: HcTerminal) => string;
      detail?: string[];
    };
    const cases: Case[] = [
      {
        title: "a finished terminal with its exit code",
        reason: "terminal_not_running",
        terminal: (b) => ({ ...b, state: "finished", exit_code: 137 }),
        file: entry,
        detail: ["137"],
      },
      {
        title: "a finished terminal without an exit code",
        reason: "terminal_not_running",
        terminal: (b) => ({ ...b, state: "finished" }),
        file: entry,
      },
      {
        title: "a foreground that is not the agent",
        reason: "not_claude",
        terminal: (b) => ({ ...b, ...(b.foreground === undefined ? {} : { foreground: { ...b.foreground, argv: ["zsh"] } }) }),
        file: entry,
      },
      {
        title: "an absent foreground",
        reason: "not_claude",
        terminal: ({ foreground: _gone, ...rest }) => rest,
        file: entry,
      },
      { title: "an absent registry file", reason: "no_session" },
      { title: "a registry that is not JSON", reason: "session_registry_unreadable", file: () => "{not json" },
      {
        title: "a registry of another shape",
        reason: "session_registry_unreadable",
        file: (b) => JSON.stringify({ pid: pidOf(b), cwd: b.cwd }),
      },
      { title: "a registry of another pid", reason: "session_registry_stale", file: (b) => entry(b, { pid: pidOf(b) + 1 }) },
      {
        title: "a registry of another folder",
        reason: "session_registry_stale",
        file: (b) => entry(b, { cwd: `${b.cwd}/other` }),
      },
      {
        title: "a registry of another session",
        reason: "session_mismatch",
        file: (b) => entry(b, { sessionId: OTHER_ID }),
        detail: [SESSION_ID, OTHER_ID],
      },
    ];

    it.each(cases)("$title as $reason", async ({ reason, terminal, file, detail }) => {
      const base = await live();
      const subject = terminal === undefined ? base : terminal(base);
      const { remote } = stubRemote(file === undefined ? {} : { [registryPath(pidOf(base))]: file(base) });

      const result = await new ClaudeAdapter(macAt(home)).confirmResumed(subject, expected, remote);

      expect(result).toEqual({ ok: false, refusal: { reason, detail: expect.any(String) } });
      for (const part of detail ?? []) expect(result.ok ? "" : result.refusal.detail).toContain(part);
    });

    it("a registry that matches only one of the two cwds as session_registry_stale", async () => {
      const base = await live();
      const foreground = base.foreground;
      if (foreground === undefined) throw new Error("the fixture has no foreground process");
      const moved = { ...base, foreground: { ...foreground, cwd: "/elsewhere" } };
      const stale = { ok: false, refusal: { reason: "session_registry_stale", detail: expect.any(String) } };

      const terminalOnly = stubRemote({ [registryPath(pidOf(base))]: entry(base, { cwd: base.cwd }) });
      expect(await new ClaudeAdapter(macAt(home)).confirmResumed(moved, expected, terminalOnly.remote)).toEqual(stale);

      const foregroundOnly = stubRemote({ [registryPath(pidOf(base))]: entry(base, { cwd: "/elsewhere" }) });
      expect(await new ClaudeAdapter(macAt(home)).confirmResumed(moved, expected, foregroundOnly.remote)).toEqual(stale);

      const both = stubRemote({ [registryPath(pidOf(base))]: entry(base, { cwd: "/elsewhere" }) });
      const bothMoved = { ...moved, cwd: "/elsewhere" };
      expect(await new ClaudeAdapter(macAt(home)).confirmResumed(bothMoved, expected, both.remote)).toEqual({ ok: true });
    });

    it("a registry file removed after a failed read as no_session", async () => {
      const gone: RemoteRun = { machine: "dev-home", run: async () => ({ code: 1, stdout: "", stderr: "No such file" }) };

      const result = await new ClaudeAdapter(macAt(home)).confirmResumed(await live(), expected, gone);

      expect(result).toEqual({ ok: false, refusal: { reason: "no_session", detail: expect.any(String) } });
    });

    it("a registry that is read without asking whether it exists", async () => {
      const terminal = await live();
      const { remote, argvs } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

      await new ClaudeAdapter(macAt(home)).confirmResumed(terminal, expected, remote);

      expect(argvs.map((argv) => argv[0])).toEqual(["cat"]);
    });

    it("a registry file that exists but cannot be read as session_registry_unreadable", async () => {
      const failing: RemoteRun = {
        machine: "dev-home",
        run: async (argv) => (argv[0] === "test" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "denied" }),
      };

      const result = await new ClaudeAdapter(macAt(home)).confirmResumed(await live(), expected, failing);

      expect(result).toEqual({ ok: false, refusal: { reason: "session_registry_unreadable", detail: expect.any(String) } });
    });
  });

  it("propagates the error of a remote run that rejects", async () => {
    const failure = new Error("hc is down");
    const remote: RemoteRun = { machine: "dev-home", run: async () => Promise.reject(failure) };

    await expect(new ClaudeAdapter(macAt(home)).confirmResumed(await live(), expected, remote)).rejects.toBe(failure);
  });

  it("only reads, with the path after -- and never as an option", async () => {
    const terminal = await live();
    const { remote, argvs } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

    await new ClaudeAdapter(macAt(home)).confirmResumed(terminal, { sessionId: SESSION_ID, configDir: "-odd dir" }, remote);
    await new ClaudeAdapter(macAt(home)).confirmResumed(terminal, expected, remote);

    expect(argvs.length).toBeGreaterThan(0);
    for (const argv of argvs) {
      const [program, ...rest] = argv;
      if (program === "cat") expect(rest[0]).toBe("--");
      else expect(program).toBe("test");
      expect(rest.filter((arg) => arg.startsWith("-") && arg !== "--" && arg !== "-e")).toEqual([]);
    }
  });
});

describe("recognizes claude", () => {
  it.each([
    ["claude", ["claude"], true],
    ["an absolute path whose basename is claude", ["/home/ejklock/.local/bin/claude", "--resume", SESSION_ID], true],
    ["a shell", ["/usr/bin/zsh"], false],
    ["a wrapper that only starts with claude", ["/opt/claude-klock"], false],
    ["a program that only starts with claude", ["claudex"], false],
  ])("in a foreground of %s", async (_title, argv, expected) => {
    const base = await terminalFixture();
    const foreground = base.foreground === undefined ? undefined : { ...base.foreground, argv };

    const recognized = new ClaudeAdapter(new StubMachine("box")).recognizes({
      ...base,
      ...(foreground === undefined ? {} : { foreground }),
    });

    expect(recognized).toBe(expected);
  });

  it("in no terminal that has no foreground", async () => {
    const { foreground, ...base } = await terminalFixture();

    expect(foreground).toBeDefined();
    expect(new ClaudeAdapter(new StubMachine("box")).recognizes(base)).toBe(false);
  });
});

describe("finds a labelled session", () => {
  const LABEL_DIR = "/home/u/.claude-klock";
  const BIN = "/home/u/.local/bin/claude";
  let machine: StubMachine;

  function label(overrides: Record<string, unknown> = {}, pidOverride?: number): string {
    return JSON.stringify({
      v: 1,
      agent: "claude",
      session_id: SESSION_ID,
      cwd: "/ignored",
      flags: [],
      env: { CLAUDE_CONFIG_DIR: LABEL_DIR, LANG: "en_US.UTF-8" },
      bin: BIN,
      agent_proc: { pid: pidOverride ?? 84526, start: 1837 },
      state: "running",
      ...overrides,
    });
  }

  async function labelled(wake: string | undefined, foregroundProgram: string = BIN): Promise<HcTerminal> {
    const base = await terminalFixture();
    const foreground = base.foreground === undefined ? undefined : { ...base.foreground, argv: [foregroundProgram] };
    return {
      ...base,
      argv: ["/home/u/.local/bin/herdr-wake", "shell"],
      ...(foreground === undefined ? {} : { foreground }),
      ...(wake === undefined ? {} : { labels: { wake, other: "x" } }),
    };
  }

  function registry(overrides: Record<string, unknown> = {}, pid = 84526): void {
    machine.files.set(
      join(LABEL_DIR, "sessions", `${pid}.json`),
      JSON.stringify({ pid, sessionId: SESSION_ID, cwd: "/Volumes/Developer/www/klock-tecnologia/hc-teleport", version: "2.1.321", ...overrides }),
    );
  }

  beforeEach(() => {
    machine = new StubMachine("box");
  });

  it("in the label's config dir when the registry agrees, without running the launcher", async () => {
    registry();

    const result = await new ClaudeAdapter(machine).findSession(await labelled(label({ flags: ["--model", "opus"] })));

    expect(result).toEqual({
      ok: true,
      session: {
        id: SESSION_ID,
        configDir: LABEL_DIR,
        version: "2.1.321",
        transcript: { file: join(LABEL_DIR, "projects", "-Volumes-Developer-www-klock-tecnologia-hc-teleport", `${SESSION_ID}.jsonl`) },
        launch: { bin: BIN, flags: ["--model", "opus"] },
      },
    });
    expect(machine.ran).toEqual([]);
  });

  it("with the label's bin when it is the foreground program", async () => {
    registry();

    const result = await new ClaudeAdapter(machine).findSession(await labelled(label()));

    expect(result.ok && result.session.launch?.bin).toBe(BIN);
  });

  it("when a wrapper left the bare program name in the foreground and the label holds its absolute path to it", async () => {
    registry();

    const result = await new ClaudeAdapter(machine).findSession(await labelled(label(), "claude"));

    expect(result.ok && result.session.launch?.bin).toBe(BIN);
    const launch = result.ok ? result.session.launch : undefined;
    expect(launch && new ClaudeAdapter(machine).buildResumeArgv([launch.bin, ...launch.flags], SESSION_ID)).toEqual({
      ok: true,
      argv: [BIN, "--resume", SESSION_ID],
    });
  });

  it.each([
    ["a bare foreground and a shell bin", "claude", "/bin/sh"],
    ["a bare foreground and a relative bin", "claude", "claude"],
    ["a bare foreground and a bin of another basename", "claude", "/x/claudex"],
    ["an absolute foreground of another path", "/opt/claude", BIN],
  ])("refuses as session_label_unreadable for %s without reading the registry", async (_title, program, bin) => {
    registry();

    const result = await new ClaudeAdapter(machine).findSession(await labelled(label({ bin }), program));

    expect(result).toMatchObject({ ok: false, refusal: { reason: "session_label_unreadable" } });
    expect(machine.reads).toEqual([]);
    expect(machine.ran).toEqual([]);
  });

  it("refuses as session_mismatch when the registry names another session", async () => {
    registry({ sessionId: "11111111-1111-4111-8111-111111111111" });

    const result = await new ClaudeAdapter(machine).findSession(await labelled(label()));

    expect(result).toMatchObject({ ok: false, refusal: { reason: "session_mismatch" } });
  });

  it("refuses as session_registry_stale when the label names another process", async () => {
    registry();

    const result = await new ClaudeAdapter(machine).findSession(await labelled(label({}, 1)));

    expect(result).toMatchObject({ ok: false, refusal: { reason: "session_registry_stale" } });
  });

  it("refuses as session_registry_stale when the registry's folder is not the terminal's", async () => {
    registry({ cwd: "/elsewhere" });

    const result = await new ClaudeAdapter(machine).findSession(await labelled(label()));

    expect(result).toMatchObject({ ok: false, refusal: { reason: "session_registry_stale" } });
  });

  it("refuses as no_session when the registry file is absent", async () => {
    const result = await new ClaudeAdapter(machine).findSession(await labelled(label()));

    expect(result).toMatchObject({ ok: false, refusal: { reason: "no_session" } });
  });

  it.each([
    ["not JSON", "{nope"],
    ["a version other than 1", label({ v: 2 })],
    ["another agent", label({ agent: "codex" })],
    ["a relative config dir", label({ env: { CLAUDE_CONFIG_DIR: "rel/dir" } })],
    ["no config dir", label({ env: {} })],
    ["no bin", label({ bin: undefined })],
    ["a bin that reads as an option", label({ bin: "-i" })],
    ["a relative bin", label({ bin: "claude" })],
    ["a bin that reads as an assignment", label({ bin: "FOO=bar" })],
    ["another program's bin", label({ bin: "/bin/sh" })],
    ["a bin with a trailing space", label({ bin: `${BIN} ` })],
  ])("refuses as session_label_unreadable for a label that is %s", async (_title, wake) => {
    registry();

    const result = await new ClaudeAdapter(machine).findSession(await labelled(wake));

    expect(result).toMatchObject({ ok: false, refusal: { reason: "session_label_unreadable", detail: expect.stringContaining("t6c") } });
    expect(machine.reads).toEqual([]);
    expect(machine.ran).toEqual([]);
  });

  it("takes the launcher path when the terminal has no wake label", async () => {
    const base = await terminalFixture();
    const pid = base.foreground?.pid ?? 0;
    await writeRegistry(join(home, ".claude"), pid, { pid, sessionId: SESSION_ID, cwd: base.cwd });

    const result = await new ClaudeAdapter(macAt(home)).findSession({ ...base, argv: ["claude"], labels: { where: "x" } });

    expect(result.ok && result.session.configDir).toBe(join(home, ".claude"));
    expect(result.ok && result.session.launch).toBeUndefined();
  });
});
