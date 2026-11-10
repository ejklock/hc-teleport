import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HcTerminal } from "../../src/platform/hc.ts";
import type { RemoteRun } from "../../src/session/agent-adapter.ts";
import { ClaudeAdapter } from "../../src/session/claude-adapter.ts";

const SESSION_ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "hc-get-claude-klock.json");

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

    const result = await new ClaudeAdapter(home).findSession(launcherTerminal(base));

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

    const result = await new ClaudeAdapter(home).findSession({ ...base, argv: ["claude"] });

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

    const result = await new ClaudeAdapter(home).findSession(launcherTerminal(base));

    expect(result.ok && result.session.transcript.dir).toBe(join(projectDir, SESSION_ID));
  });

  it("maps a cwd with spaces, dots and non-ASCII letters to the dashed project directory", async () => {
    const base = await terminalFixture();
    const cwd = "/Volumes/Dev x/ré.po/ça";
    const pid = base.foreground?.pid ?? 0;
    const configDir = join(home, ".claude-klock");
    await writeRegistry(configDir, pid, { pid, sessionId: SESSION_ID, cwd });
    const foreground = base.foreground === undefined ? undefined : { ...base.foreground, cwd };

    const result = await new ClaudeAdapter(home).findSession({
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

      const result = await new ClaudeAdapter(home).findSession(launcherTerminal(base));

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
      expect(await new ClaudeAdapter(home).findSession(foregroundMoved)).toEqual({ ok: false, refusal: stale });

      await writeRegistry(join(home, ".claude-klock"), pid, { pid, sessionId: SESSION_ID, cwd: foreground.cwd });
      const terminalMoved = { ...launcherTerminal(base), cwd: "/elsewhere" };
      expect(await new ClaudeAdapter(home).findSession(terminalMoved)).toEqual({ ok: false, refusal: stale });
    });

    it("a registry path that cannot be read as session_registry_unreadable", async () => {
      const base = await terminalFixture();
      await mkdir(join(home, ".claude-klock", "sessions", `${base.foreground?.pid ?? 0}.json`), { recursive: true });

      const result = await new ClaudeAdapter(home).findSession(launcherTerminal(base));

      expect(result).toEqual({ ok: false, refusal: { reason: "session_registry_unreadable", detail: expect.any(String) } });
    });

    it("a launcher whose --where fails as config_dir_unknown", async () => {
      await writeLauncher("exit 1");
      const result = await new ClaudeAdapter(home).findSession(launcherTerminal(await terminalFixture()));
      expect(result).toEqual({ ok: false, refusal: { reason: "config_dir_unknown", detail: expect.any(String) } });
    });

    it("a launcher whose --where prints nothing as config_dir_unknown", async () => {
      await writeLauncher("exit 0");
      const result = await new ClaudeAdapter(home).findSession(launcherTerminal(await terminalFixture()));
      expect(result).toEqual({ ok: false, refusal: { reason: "config_dir_unknown", detail: expect.any(String) } });
    });

    it("a foreground process that is not claude as not_claude", async () => {
      const base = await terminalFixture();
      const foreground = base.foreground === undefined ? undefined : { ...base.foreground, argv: ["node", "x.js"] };
      const result = await new ClaudeAdapter(home).findSession({
        ...launcherTerminal(base),
        ...(foreground === undefined ? {} : { foreground }),
      });
      expect(result).toEqual({ ok: false, refusal: { reason: "not_claude", detail: expect.any(String) } });
    });
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

    expect(await new ClaudeAdapter(home).confirmResumed(terminal, expected, remote)).toEqual({ ok: true });
  });

  it("an agent started through a wrapper whose terminal argv[0] is the wrapper", async () => {
    const terminal = { ...(await live()), argv: ["claude-klock", "--resume", SESSION_ID] };
    const { remote } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

    expect(await new ClaudeAdapter(home).confirmResumed(terminal, expected, remote)).toEqual({ ok: true });
  });

  it("a folder with a space and non-ASCII characters", async () => {
    const base = await live();
    const cwd = "/home/dev/meu projeto/ação";
    const terminal = { ...base, cwd, ...(base.foreground === undefined ? {} : { foreground: { ...base.foreground, cwd } }) };
    const { remote } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

    expect(await new ClaudeAdapter(home).confirmResumed(terminal, expected, remote)).toEqual({ ok: true });
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

      const result = await new ClaudeAdapter(home).confirmResumed(subject, expected, remote);

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
      expect(await new ClaudeAdapter(home).confirmResumed(moved, expected, terminalOnly.remote)).toEqual(stale);

      const foregroundOnly = stubRemote({ [registryPath(pidOf(base))]: entry(base, { cwd: "/elsewhere" }) });
      expect(await new ClaudeAdapter(home).confirmResumed(moved, expected, foregroundOnly.remote)).toEqual(stale);

      const both = stubRemote({ [registryPath(pidOf(base))]: entry(base, { cwd: "/elsewhere" }) });
      const bothMoved = { ...moved, cwd: "/elsewhere" };
      expect(await new ClaudeAdapter(home).confirmResumed(bothMoved, expected, both.remote)).toEqual({ ok: true });
    });

    it("a registry file removed after a failed read as no_session", async () => {
      const gone: RemoteRun = { machine: "dev-home", run: async () => ({ code: 1, stdout: "", stderr: "No such file" }) };

      const result = await new ClaudeAdapter(home).confirmResumed(await live(), expected, gone);

      expect(result).toEqual({ ok: false, refusal: { reason: "no_session", detail: expect.any(String) } });
    });

    it("a registry that is read without asking whether it exists", async () => {
      const terminal = await live();
      const { remote, argvs } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

      await new ClaudeAdapter(home).confirmResumed(terminal, expected, remote);

      expect(argvs.map((argv) => argv[0])).toEqual(["cat"]);
    });

    it("a registry file that exists but cannot be read as session_registry_unreadable", async () => {
      const failing: RemoteRun = {
        machine: "dev-home",
        run: async (argv) => (argv[0] === "test" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "denied" }),
      };

      const result = await new ClaudeAdapter(home).confirmResumed(await live(), expected, failing);

      expect(result).toEqual({ ok: false, refusal: { reason: "session_registry_unreadable", detail: expect.any(String) } });
    });
  });

  it("propagates the error of a remote run that rejects", async () => {
    const failure = new Error("hc is down");
    const remote: RemoteRun = { machine: "dev-home", run: async () => Promise.reject(failure) };

    await expect(new ClaudeAdapter(home).confirmResumed(await live(), expected, remote)).rejects.toBe(failure);
  });

  it("only reads, with the path after -- and never as an option", async () => {
    const terminal = await live();
    const { remote, argvs } = stubRemote({ [registryPath(pidOf(terminal))]: entry(terminal) });

    await new ClaudeAdapter(home).confirmResumed(terminal, { sessionId: SESSION_ID, configDir: "-odd dir" }, remote);
    await new ClaudeAdapter(home).confirmResumed(terminal, expected, remote);

    expect(argvs.length).toBeGreaterThan(0);
    for (const argv of argvs) {
      const [program, ...rest] = argv;
      if (program === "cat") expect(rest[0]).toBe("--");
      else expect(program).toBe("test");
      expect(rest.filter((arg) => arg.startsWith("-") && arg !== "--" && arg !== "-e")).toEqual([]);
    }
  });
});
