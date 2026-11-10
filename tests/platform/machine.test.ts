import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { Hc } from "../../src/platform/hc.ts";
import { HcMachine, LocalMachine, MachineError } from "../../src/platform/machine.ts";
import { PROCESS_MAX_BUFFER, ProcessError, type Runner } from "../../src/platform/process.ts";
import { machineContract } from "./machine-contract.ts";

describe("LocalMachine", () => {
  const machine = new LocalMachine();

  machineContract({ start: async () => machine, tempRoot: tmpdir(), home: process.env.HOME ?? "" });

  it.each([0, 601, 1.5])("runs a program: refuses a timeout of %s before it starts", async (timeoutSeconds) => {
    await expect(machine.exec(["true"], { timeoutSeconds })).rejects.toThrow(/whole number of seconds from 1 to 600/);
  });

  it("runs a program: refuses an environment name that is not a name", async () => {
    await expect(machine.exec(["true"], { env: { "A=B": "1" } })).rejects.toThrow(/not an environment variable name/);
  });

  it("runs a program: names itself local", () => {
    expect(machine.name).toBe("local");
  });

  it("runs a program: reads the home from the environment", async () => {
    vi.stubEnv("HOME", "/somewhere/home");
    try {
      expect(await machine.home()).toBe("/somewhere/home");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs a program: a home that is not absolute rejects no_home naming the machine", async () => {
    vi.stubEnv("HOME", "relative/home");
    try {
      await expect(machine.home()).rejects.toMatchObject({ code: "no_home", message: expect.stringMatching(/local.*absolute home/) });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs a program: output past the buffer limit rejects exec_failed naming the output limit, not a timeout", async () => {
    const failure = await machine.exec(["head", "-c", String(PROCESS_MAX_BUFFER + 1), "/dev/zero"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MachineError);
    expect(failure).toMatchObject({ code: "exec_failed", message: expect.stringMatching(/head.*output limit/) });
    expect((failure as MachineError).message).not.toMatch(/timeout/);
  }, 30_000);
});

type Call = { file: string; args: readonly string[]; input?: string };

function recording(replies: readonly (string | Error)[]): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  let next = 0;
  const runner: Runner = async (file, args, options) => {
    calls.push({ file, args, ...(options?.input === undefined ? {} : { input: options.input }) });
    const reply = replies[Math.min(next++, replies.length - 1)];
    if (reply === undefined || reply instanceof Error) throw reply ?? new Error("no reply");
    return reply;
  };
  return { run: runner, calls };
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

function execReply(over: Record<string, unknown> = {}, stdout = "", stderr = ""): string {
  return JSON.stringify({ code: 0, ms: 1, signal: null, stderr: b64(stderr), stdout: b64(stdout), timed_out: false, truncated: false, ...over });
}

const hcFailure = (command: string, kind: string, message: string) =>
  new ProcessError(command, JSON.stringify({ error: { hint: "", kind, message } }));

function onDest(replies: readonly (string | Error)[]) {
  const { run: runner, calls } = recording(replies);
  return { machine: new HcMachine("dest", new Hc(runner)), calls };
}

/** What follows `--` in a recorded `hc exec` call: the program and its arguments. */
const programOf = (call: Call | undefined): readonly string[] => (call?.args ?? []).slice((call?.args ?? []).indexOf("--") + 1);

describe("HcMachine", () => {
  it("runs a program: asks hc for it on its machine with cwd, env, stdin and timeout", async () => {
    const { machine, calls } = onDest([execReply({}, "out")]);
    const result = await machine.exec(["cat", "--flag"], { cwd: "/-x", env: { A: "1" }, stdin: "ü", timeoutSeconds: 30 });
    expect(result).toEqual({ code: 0, stdout: "out", stderr: "" });
    expect(machine.name).toBe("dest");
    expect(calls[0]?.args).toEqual(["exec", "--json", "--on=dest", "--cwd=/-x", "--env", "A=1", "--timeout", "30", "-i", "--", "cat", "--flag"]);
    expect(calls[0]?.input).toBe("ü");
  });

  it("runs a program: a non-zero exit is a result naming its stderr", async () => {
    const { machine } = onDest([execReply({ code: 3 }, "", "oops\n")]);
    expect(await machine.exec(["false"])).toEqual({ code: 3, stdout: "", stderr: "oops\n" });
  });

  it("runs a program: one missing on the machine rejects naming it and the machine", async () => {
    const { machine } = onDest([hcFailure("hc exec --json --on=dest -- no-such-program", "spawn_failed", "cannot start no-such-program: No such file or directory (os error 2)")]);
    const failure = await machine.exec(["no-such-program"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MachineError);
    expect((failure as MachineError).code).toBe("exec_failed");
    expect((failure as MachineError).message).toMatch(/dest/);
    expect((failure as MachineError).message).toMatch(/no-such-program/);
  });

  it("runs a program: one killed by a signal or past its timeout rejects naming it and the machine", async () => {
    const { machine } = onDest([execReply({ code: null, signal: 9 }), execReply({ code: null, timed_out: true })]);
    await expect(machine.exec(["sh"])).rejects.toThrow(/dest.*sh.*signal 9|sh.*dest.*signal 9/);
    await expect(machine.exec(["sleep"], { timeoutSeconds: 1 })).rejects.toThrow(/sleep.*dest.*timed_out|dest.*sleep.*timed_out/);
  });

  it.each([["empty output", ""], ["a relative path", "relative\n"]])("runs a program: a home with %s rejects no_home naming the machine", async (_title, stdout) => {
    const { machine } = onDest([execReply({}, stdout)]);
    await expect(machine.home()).rejects.toMatchObject({ code: "no_home", message: expect.stringMatching(/dest.*absolute home/) });
  });

  it("runs a program: resolves the absolute home printed by printenv", async () => {
    const { machine, calls } = onDest([execReply({}, "/home/box\n")]);
    expect(await machine.home()).toBe("/home/box");
    expect(programOf(calls[0])).toEqual(["printenv", "HOME"]);
  });

  it.each(["-p", "-delete", "!", "(", "x", "./x", ""])("relative path %j is refused before any program runs", async (path) => {
    const { machine, calls } = onDest([execReply()]);
    for (const call of [
      () => machine.readFile(path),
      () => machine.writeFile(path, "x"),
      () => machine.realpath(path),
      () => machine.entries(path),
      () => machine.kind(path),
      () => machine.remove(path),
      () => machine.exec(["true"], { cwd: path }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "not_absolute", machine: "dest" });
    }
    expect(calls).toEqual([]);
  });

  it("files: reads and writes through hc file with the path after --", async () => {
    const { machine, calls } = onDest([JSON.stringify({ text: "a\nb", first: 1, last: 2, lines: 2 }), JSON.stringify({ bytes: 3, path: "/-p" })]);
    expect(await machine.readFile("/-p")).toBe("a\nb");
    await machine.writeFile("/-p", "a\nb");
    expect(calls.map((call) => call.args)).toEqual([
      ["file", "read", "--json", "--on=dest", "--", "/-p"],
      ["file", "write", "--json", "--on=dest", "--", "/-p"],
    ]);
  });

  it("files: a missing file rejects ENOENT and bytes that are not UTF-8 reject not_text", async () => {
    const { machine } = onDest([
      hcFailure("hc file read --json --on=dest -- /x", "not_found", "no file /x"),
      hcFailure("hc file read --json --on=dest -- /y", "not_text", "/y is not UTF-8 text"),
    ]);
    await expect(machine.readFile("/x")).rejects.toMatchObject({ code: "ENOENT", machine: "dest" });
    await expect(machine.readFile("/y")).rejects.toMatchObject({ code: "not_text", machine: "dest" });
  });

  it("files: a read that fails for any other reason rejects failed carrying hc's message", async () => {
    const { machine } = onDest([hcFailure("hc file read --json -- /d", "invalid_params", "/d is not a regular file")]);
    await expect(machine.readFile("/d")).rejects.toMatchObject({ code: "failed", message: expect.stringMatching(/not a regular file/) });
  });

  it("files: realpath, kind, temp folders and remove run argv-only programs with the path after --", async () => {
    const { machine, calls } = onDest([execReply({}, "/real\0"), execReply({}, "d"), execReply({}, "/tmp/hc-teleport-AbC123\n"), execReply()]);
    expect(await machine.realpath("/-p")).toBe("/real");
    expect(await machine.kind("/-p")).toBe("dir");
    expect(await machine.makeTempDir()).toBe("/tmp/hc-teleport-AbC123");
    await machine.remove("/-p");
    expect(calls.map(programOf)).toEqual([
      ["realpath", "-ez", "--", "/-p"],
      ["find", "-P", "/-p", "-maxdepth", "0", "-printf", "%y"],
      ["mktemp", "-d", "-t", "hc-teleport-XXXXXX"],
      ["rm", "-rf", "--", "/-p"],
    ]);
  });

  it("files: entries parses find's output, with names holding a space or a newline, sorted by path", async () => {
    const found = "0\0d\0\0" + "1\0d\0sub\0" + "2\0f\0sub/n\nl\0" + "1\0f\0a b\0" + "1\0l\0dang\0" + "1\0p\0ff\0";
    const { machine, calls } = onDest([execReply({}, found)]);
    expect(await machine.entries("/home/box/-d")).toEqual([
      { path: "/home/box/-d/a b", kind: "file" },
      { path: "/home/box/-d/dang", kind: "symlink" },
      { path: "/home/box/-d/ff", kind: "other" },
      { path: "/home/box/-d/sub", kind: "dir" },
      { path: "/home/box/-d/sub/n\nl", kind: "file" },
    ]);
    expect(programOf(calls[0]).slice(0, 3)).toEqual(["find", "-H", "/home/box/-d"]);
  });

  it("files: a path that is not there is ENOENT for realpath and entries and undefined for kind", async () => {
    const gone = (tool: string) => execReply({ code: 1 }, "", `${tool}: '/zz': No such file or directory\n`);
    const { machine } = onDest([gone("realpath"), gone("find"), gone("find")]);
    await expect(machine.realpath("/zz")).rejects.toMatchObject({ code: "ENOENT", machine: "dest" });
    await expect(machine.entries("/zz")).rejects.toMatchObject({ code: "ENOENT", machine: "dest" });
    expect(await machine.kind("/zz")).toBeUndefined();
  });

  it("files: a path through a regular file is ENOTDIR for realpath and entries and undefined for kind", async () => {
    const notDir = (tool: string) => execReply({ code: 1 }, "", `${tool}: '/f/x': Not a directory\n`);
    const { machine } = onDest([notDir("realpath"), notDir("find"), notDir("find"), execReply({}, "0\0f\0\0")]);
    await expect(machine.realpath("/f/x")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(machine.entries("/f/x")).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await machine.kind("/f/x")).toBeUndefined();
    await expect(machine.entries("/f")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("files: an exit 1 that is not absence rejects failed for kind, entries and the others", async () => {
    const denied = execReply({ code: 1 }, "", "find: '/p': Permission denied\n");
    const { machine } = onDest([denied, denied, execReply({ code: 2 }, "", "mktemp: boom\n"), execReply({ code: 1 }, "", "rm: busy\n")]);
    await expect(machine.kind("/p")).rejects.toMatchObject({ code: "failed", machine: "dest" });
    await expect(machine.entries("/p")).rejects.toMatchObject({ code: "failed" });
    await expect(machine.makeTempDir()).rejects.toMatchObject({ code: "failed" });
    await expect(machine.remove("/p")).rejects.toMatchObject({ code: "failed" });
  });

  it("files: a reply that breaks find's shape rejects unexpected_reply", async () => {
    const { machine } = onDest([execReply({}, "0\0d\0"), execReply({}, "x\0d\0\0"), execReply({}, ""), execReply({}, "dd")]);
    await expect(machine.entries("/a")).rejects.toMatchObject({ code: "unexpected_reply", machine: "dest" });
    await expect(machine.entries("/a")).rejects.toMatchObject({ code: "unexpected_reply" });
    await expect(machine.kind("/a")).rejects.toMatchObject({ code: "unexpected_reply" });
    await expect(machine.kind("/a")).rejects.toMatchObject({ code: "unexpected_reply" });
  });

  it("files: a find type that is not file, folder or symlink reads as other", async () => {
    const { machine } = onDest([execReply({}, "s"), execReply({}, "0\0d\0\0" + "1\0s\0sock\0" + "1\0b\0blk\0")]);
    expect(await machine.kind("/a")).toBe("other");
    expect(await machine.entries("/a")).toEqual([
      { path: "/a/blk", kind: "other" },
      { path: "/a/sock", kind: "other" },
    ]);
  });

  it("locale: a missing path stays absent or ENOENT when the machine answers in Portuguese unless LC_ALL=C is set", async () => {
    const calls: Call[] = [];
    const runner: Runner = async (file, args) => {
      calls.push({ file, args });
      const plain = args.includes("LC_ALL=C");
      const program = args.slice(args.indexOf("--") + 1);
      if (program[0] === "mktemp") return execReply({}, "/tmp/hc-teleport-AbC123\n");
      if (program[0] === "printenv") return execReply({}, "/home/box\n");
      if (program[0] === "rm") return execReply();
      return execReply({ code: 1 }, "", plain ? `${program[0]}: '/zz': No such file or directory\n` : `${program[0]}: '/zz': Arquivo ou diretório inexistente\n`);
    };
    const machine = new HcMachine("dest", new Hc(runner));
    expect(await machine.kind("/zz")).toBeUndefined();
    await expect(machine.realpath("/zz")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(machine.entries("/zz")).rejects.toMatchObject({ code: "ENOENT" });
    await machine.makeTempDir();
    await machine.remove("/zz");
    await machine.home();
    expect(calls.map((call) => programOf(call)[0])).toEqual(["find", "realpath", "find", "mktemp", "rm", "printenv"]);
    for (const call of calls) expect(call.args, programOf(call)[0]).toEqual(expect.arrayContaining(["--env", "LC_ALL=C"]));
  });
});
