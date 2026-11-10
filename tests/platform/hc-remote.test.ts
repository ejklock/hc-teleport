import { describe, expect, it } from "vitest";
import { Hc, HcError } from "../../src/platform/hc.ts";
import { ProcessError, processRunner, type Runner } from "../../src/platform/process.ts";

type Call = { file: string; args: readonly string[]; input?: string; timeoutMs?: number };

function recording(reply: string | Error): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (file, args, options) => {
    calls.push({ file, args, ...options });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { run, calls };
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

function execReply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    code: 0,
    ms: 4,
    signal: null,
    stderr: "",
    stdout: "",
    timed_out: false,
    truncated: false,
    ...over,
  });
}

describe("Hc remote calls", () => {
  it("runs a program: resolves with the exit code and the decoded output", async () => {
    const { run, calls } = recording(execReply({ stdout: b64("héllo\n") }));
    const result = await new Hc(run).exec(["echo", "héllo"], { on: "dest" });
    expect(result).toEqual({ code: 0, stdout: "héllo\n", stderr: "" });
    expect(calls[0]?.file).toBe("hc");
    expect(calls[0]?.args).toEqual(["exec", "--json", "--on", "dest", "--", "echo", "héllo"]);
  });

  it("runs a program: a non-zero exit is a result with its stderr", async () => {
    const { run } = recording(execReply({ code: 1, stderr: b64("ls: /x: No such file\n") }));
    const result = await new Hc(run).exec(["ls", "/x"]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "ls: /x: No such file\n" });
  });

  it("runs a program: passes cwd, env and timeout, and feeds stdin through -i", async () => {
    const { run, calls } = recording(execReply());
    await new Hc(run).exec(["cat"], {
      on: "dest",
      cwd: "/tmp",
      env: { A: "1", B: "x y" },
      timeout: 30,
      stdin: "x\nü",
    });
    expect(calls[0]?.args).toEqual([
      "exec", "--json", "--on", "dest", "--cwd", "/tmp", "--env", "A=1", "--env", "B=x y",
      "--timeout", "30", "-i", "--", "cat",
    ]);
    expect(calls[0]?.input).toBe("x\nü");
  });

  it("runs a program: puts an argv that starts with a dash after --", async () => {
    const { run, calls } = recording(execReply());
    await new Hc(run).exec(["-weird", "--flag"]);
    expect(calls[0]?.args).toEqual(["exec", "--json", "--", "-weird", "--flag"]);
    expect(calls[0]?.input).toBeUndefined();
  });

  it("runs a program: gives the runner more time than the program gets", async () => {
    const { run, calls } = recording(execReply());
    await new Hc(run).exec(["true"], { timeout: 10 });
    await new Hc(run).exec(["true"]);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(10_000);
    expect(calls[1]?.timeoutMs).toBeGreaterThan(60_000);
  });

  it.each([0, 601, 1.5, -1, Number.NaN])("runs a program: refuses a timeout of %s before hc runs", async (timeout) => {
    const { run, calls } = recording(execReply());
    await expect(new Hc(run).exec(["true"], { timeout })).rejects.toThrow(HcError);
    expect(calls).toHaveLength(0);
  });

  it("runs a program: names the argv and the machine when hc fails", async () => {
    const { run } = recording(new ProcessError("hc exec", "no such machine nope"));
    const failure = await new Hc(run).exec(["ls", "/x"], { on: "nope" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HcError);
    expect((failure as HcError).message).toContain("ls /x");
    expect((failure as HcError).message).toContain("nope");
    expect((failure as HcError).message).toContain("no such machine nope");
  });

  it.each([
    ["timed_out", { timed_out: true }, /timed_out/],
    ["truncated", { truncated: true }, /truncated/],
  ])("runs a program: fails when the reply says %s", async (_field, over, named) => {
    const { run } = recording(execReply(over));
    await expect(new Hc(run).exec(["sleep", "9"], { on: "dest" })).rejects.toThrow(named);
  });

  it("runs a program: names timed_out and the timeout when hc ended it at its timeout", async () => {
    const { run } = recording(execReply({ code: null, ms: 2002, signal: 15, timed_out: true }));
    await expect(new Hc(run).exec(["sleep", "5"], { on: "dest", timeout: 2 })).rejects.toThrow(/timed_out after 2 s/);
  });

  it("runs a program: names the signal number when a signal killed it", async () => {
    const { run } = recording(execReply({ code: null, ms: 0, signal: 9 }));
    await expect(new Hc(run).exec(["sh", "-c", "kill -9 $$"])).rejects.toThrow(/signal 9/);
  });

  it("runs a program: a null code with no signal still fails", async () => {
    const { run } = recording(execReply({ code: null }));
    await expect(new Hc(run).exec(["true"])).rejects.toThrow(/no exit code/);
  });

  it("runs a program: a signal that is neither a number nor null is an unexpected shape", async () => {
    const { run } = recording(execReply({ code: null, signal: "SIGKILL" }));
    await expect(new Hc(run).exec(["true"])).rejects.toThrow(/unexpected shape/);
  });

  it.each([
    ["not JSON", "oops"],
    ["a missing code", JSON.stringify({ stdout: "", stderr: "", timed_out: false, truncated: false })],
    ["a stdout that is not base64", execReply({ stdout: "!!not base64!!" })],
    ["a null code", execReply({ code: null, signal: 9 })],
  ])("runs a program: fails on %s", async (_title, reply) => {
    const { run } = recording(reply);
    await expect(new Hc(run).exec(["true"])).rejects.toThrow(HcError);
  });

  it("reads and writes a file: reads a relative path from the cwd", async () => {
    const { run, calls } = recording(JSON.stringify({ first: 1, last: 2, lines: 2, text: "a\nb\n" }));
    const text = await new Hc(run).readFile("notes.txt", { on: "dest", cwd: "/home/box" });
    expect(text).toBe("a\nb\n");
    expect(calls[0]?.args).toEqual(["file", "read", "--json", "--on", "dest", "--cwd", "/home/box", "--", "notes.txt"]);
  });

  it.each(["with a final newline\n", "without a final newline", "", "ü\n\n"])(
    "reads and writes a file: round-trips %j exactly",
    async (text) => {
      let stored = "";
      const run: Runner = async (_file, args, options) => {
        if (args[1] === "write") {
          stored = options?.input ?? "";
          return JSON.stringify({ bytes: Buffer.byteLength(stored), path: "/p" });
        }
        return JSON.stringify({ first: 1, last: 1, lines: 1, text: stored });
      };
      const hc = new Hc(run);
      await hc.writeFile("/p", text, { on: "dest" });
      expect(await hc.readFile("/p", { on: "dest" })).toBe(text);
    },
  );

  it("reads and writes a file: fails when hc cut the text short of the file's last line", async () => {
    const { run } = recording(JSON.stringify({ first: 1, last: 8152, lines: 8192, text: "partial\n" }));
    await expect(new Hc(run).readFile("big.txt", { on: "dest" })).rejects.toThrow(/big\.txt on dest.*truncated/);
  });

  it("reads and writes a file: sends the text on stdin with on and cwd", async () => {
    const { run, calls } = recording(JSON.stringify({ bytes: 3, path: "/home/box/a.txt" }));
    await new Hc(run).writeFile("a.txt", "hi\n", { on: "dest", cwd: "/home/box" });
    expect(calls[0]?.args).toEqual(["file", "write", "--json", "--on", "dest", "--cwd", "/home/box", "--", "a.txt"]);
    expect(calls[0]?.input).toBe("hi\n");
  });

  it("reads and writes a file: fails when hc reports fewer bytes than were sent", async () => {
    const { run } = recording(JSON.stringify({ bytes: 1, path: "/p" }));
    await expect(new Hc(run).writeFile("/p", "hello")).rejects.toThrow(HcError);
  });

  it.each([
    ["read", (hc: Hc) => hc.readFile("missing.txt", { on: "dest" })],
    ["write", (hc: Hc) => hc.writeFile("missing.txt", "x", { on: "dest" })],
  ])("reads and writes a file: names the path and machine when %s fails", async (_title, call) => {
    const { run } = recording(new ProcessError("hc file", "denied"));
    const failure = await call(new Hc(run)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HcError);
    expect((failure as HcError).message).toContain("missing.txt");
    expect((failure as HcError).message).toContain("dest");
    expect((failure as HcError).message).toContain("denied");
  });

  it("reads and writes a file: exposes the target of a machine that reports one", async () => {
    const { run } = recording(
      JSON.stringify({
        machines: [
          { name: "dest", state: "connected", target: "dest" },
          { name: "local", state: "connected" },
        ],
      }),
    );
    const machines = await new Hc(run).machines();
    expect(machines.map((m) => m.target)).toEqual(["dest", undefined]);
  });

  it("reads and writes a file: exposes an ssh target only for a machine hc reaches over ssh", async () => {
    const { run } = recording(
      JSON.stringify({
        machines: [
          { name: "dev-home", state: "connected", target: "dev-home", via: false },
          { name: "inovatec", state: "connected", target: "sh -c", via: true },
          { name: "bare", state: "connected" },
          { name: "no-target", state: "connected", via: false },
          { name: "no-via", state: "connected", target: "somewhere" },
        ],
      }),
    );
    const machines = await new Hc(run).machines();
    expect(machines.map((m) => m.sshTarget)).toEqual(["dev-home", undefined, undefined, undefined, undefined]);
  });

  it("per-call: a call's own timeout replaces the runner's", async () => {
    await expect(processRunner(100)("sleep", ["0.5"], { timeoutMs: 2000 })).resolves.toBe("");
    await expect(processRunner(100)("sleep", ["0.5"])).rejects.toThrow(ProcessError);
  });

  it("per-call: input reaches the program's stdin unchanged", async () => {
    await expect(processRunner()("cat", [], { input: "x\nü" })).resolves.toBe("x\nü");
  });
});
