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
    expect(calls[0]?.args).toEqual(["exec", "--json", "--on=dest", "--", "echo", "héllo"]);
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
      "exec", "--json", "--on=dest", "--cwd=/tmp", "--env", "A=1", "--env", "B=x y",
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
    expect(calls[0]?.args).toEqual(["file", "read", "--json", "--on=dest", "--cwd=/home/box", "--", "notes.txt"]);
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
    expect(calls[0]?.args).toEqual(["file", "write", "--json", "--on=dest", "--cwd=/home/box", "--", "a.txt"]);
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

// Replies are what hc 0.1.19 printed in the bed.
const startedReply = JSON.stringify({ address: "dest/t1", agent: "claude", cwd: "/home/box", state: "live", turn: 0 });

function waitReply(over: Record<string, unknown>): string {
  return JSON.stringify({
    children: [],
    ended: true,
    exit_code: null,
    reason: "status",
    signal: null,
    status: null,
    terminal: "dest/t1",
    turn: 0,
    ...over,
  });
}

const killedReply = JSON.stringify({
  address: "dest/t1",
  argv: ["claude", "--resume", "abc"],
  cwd: "/home/box",
  exit_code: null,
  reason: "killed",
  signal: 1,
  state: "finished",
  status: null,
});

describe("Hc terminal calls", () => {
  it("starts a program: asks for a detached terminal with no parent and resolves its address", async () => {
    const { run, calls } = recording(startedReply);
    const address = await new Hc(run).run(["claude", "--resume", "u-1"], {
      on: "dest",
      cwd: "/home/box/my folder",
      keep: true,
    });
    expect(address).toBe("dest/t1");
    expect(calls[0]?.file).toBe("hc");
    expect(calls[0]?.args).toEqual([
      "run", "--json", "--bg", "--no-parent", "--on=dest", "--cwd=/home/box/my folder", "--keep",
      "--", "claude", "--resume", "u-1",
    ]);
  });

  it("starts a program: names the terminal when asked and leaves --keep out when not", async () => {
    const { run, calls } = recording(startedReply);
    await new Hc(run).run(["-weird", "--flag"], { on: "dest", name: "carried" });
    expect(calls[0]?.args).toEqual([
      "run", "--json", "--bg", "--no-parent", "--on=dest", "--name=carried", "--", "-weird", "--flag",
    ]);
  });

  it("starts a program: names the argv and the machine when hc fails", async () => {
    const { run } = recording(new ProcessError("hc run", '{"error":{"kind":"machine_unknown"}}'));
    const failure = await new Hc(run).run(["claude"], { on: "nope" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HcError);
    expect((failure as HcError).message).toContain("claude");
    expect((failure as HcError).message).toContain("nope");
    expect((failure as HcError).message).toContain("machine_unknown");
  });

  it.each([
    ["not JSON", "oops"],
    ["no address", JSON.stringify({ state: "live" })],
    ["an address that is not text", JSON.stringify({ address: 7, state: "live" })],
  ])("starts a program: fails on a reply with %s", async (_title, reply) => {
    const { run } = recording(reply);
    await expect(new Hc(run).run(["true"], { on: "dest" })).rejects.toThrow(/hc run.*(not JSON|unexpected shape)/);
  });

  it.each([
    ["idle", waitReply({ status: "idle" }), { kind: "stopped", status: "idle" }],
    ["done", waitReply({ status: "done" }), { kind: "stopped", status: "done" }],
    ["blocked", waitReply({ status: "blocked" }), { kind: "blocked" }],
    ["error", waitReply({ status: "error" }), { kind: "error" }],
    ["an exit code", waitReply({ reason: "exit", exit_code: 3 }), { kind: "exited", code: 3 }],
    ["a signal with no code", waitReply({ reason: "exit", signal: 1 }), { kind: "exited", signal: 1 }],
    ["the timeout", waitReply({ ended: false, reason: "timeout" }), { kind: "timeout" }],
    [
      "a message that reached the waiting terminal",
      waitReply({ ended: false, reason: "message", from: "dest/t2" }),
      { kind: "interrupted", reason: "message" },
    ],
    [
      "a message with no sender",
      waitReply({ ended: false, reason: "message" }),
      { kind: "interrupted", reason: "message" },
    ],
    ["a cleared status", waitReply({ reason: "status", status: null }), { kind: "interrupted", reason: "status_cleared" }],
  ])("waits: resolves %s as its own outcome", async (_title, reply, outcome) => {
    const { run } = recording(reply);
    expect(await new Hc(run).wait("dest/t1", { timeout: 5 })).toEqual(outcome);
  });

  it("waits: asks hc for the whole-second timeout and gives the runner more time", async () => {
    const { run, calls } = recording(waitReply({ status: "idle" }));
    await new Hc(run).wait("dest/t1", { timeout: 30 });
    expect(calls[0]?.args).toEqual(["wait", "--json", "--timeout", "30", "--", "dest/t1"]);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(30_000);
  });

  it.each([0, 601, 1.5, -1, Number.NaN])("waits: refuses a timeout of %s before hc runs", async (timeout) => {
    const { run, calls } = recording(waitReply({ status: "idle" }));
    await expect(new Hc(run).wait("dest/t1", { timeout })).rejects.toThrow(HcError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a status hc has no word for", waitReply({ status: "sleepy" })],
    ["a reason hc has no word for", waitReply({ reason: "message" })],
    ["an end with no reason it can place", waitReply({ ended: false, reason: "status", status: "idle" })],
    ["not JSON", "oops"],
    ["no ended flag", JSON.stringify({ reason: "exit" })],
  ])("waits: fails on %s", async (_title, reply) => {
    const { run } = recording(reply);
    await expect(new Hc(run).wait("dest/t1", { timeout: 5 })).rejects.toThrow(HcError);
  });

  it("waits: never reads a working status as an end", async () => {
    const { run } = recording(waitReply({ status: "working" }));
    await expect(new Hc(run).wait("dest/t1", { timeout: 5 })).rejects.toThrow(HcError);
  });

  it("waits: names the terminal when hc fails", async () => {
    const { run } = recording(new ProcessError("hc wait", '{"error":{"kind":"not_found"}}'));
    const failure = await new Hc(run).wait("dest/t99", { timeout: 5 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HcError);
    expect((failure as HcError).message).toContain("dest/t99");
    expect((failure as HcError).message).toContain("not_found");
  });

  it("ends a terminal: resolves the terminal as hc reports it after the kill", async () => {
    const { run, calls } = recording(killedReply);
    const ended = await new Hc(run).kill("dest/t1");
    expect(calls[0]?.args).toEqual(["kill", "--json", "--", "dest/t1"]);
    expect(ended).toMatchObject({ address: "dest/t1", state: "finished", argv: ["claude", "--resume", "abc"] });
  });

  it.each([
    ["not JSON", "oops"],
    ["a terminal with no state", JSON.stringify({ address: "dest/t1", argv: ["x"], cwd: "/" })],
  ])("ends a terminal: fails on %s", async (_title, reply) => {
    const { run } = recording(reply);
    await expect(new Hc(run).kill("dest/t1")).rejects.toThrow(/hc kill/);
  });

  it("ends a terminal: names the terminal when hc fails", async () => {
    const { run } = recording(new ProcessError("hc kill", '{"error":{"kind":"not_found"}}'));
    const failure = await new Hc(run).kill("dest/t99").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HcError);
    expect((failure as HcError).message).toContain("dest/t99");
  });
});

describe("Hc get", () => {
  it.each([["-t1"], ["t7"], ["dev-home/t3"]])("reads a terminal: passes %s after -- with the flags first", async (address) => {
    const { run, calls } = recording(JSON.stringify({ address, argv: ["claude"], cwd: "/home/box", state: "live" }));
    const terminal = await new Hc(run).terminal(address);
    expect(terminal).toMatchObject({ address, argv: ["claude"], cwd: "/home/box", state: "live" });
    expect(calls[0]?.file).toBe("hc");
    expect(calls[0]?.args).toEqual(["get", "--json", "--", address]);
  });

  it("reads the labels of a terminal as strings and keeps the terminal without any", async () => {
    const labelled = recording(JSON.stringify({ address: "t7", argv: ["x"], cwd: "/", state: "live", labels: { wake: "{}", where: "w" } }));
    const bare = recording(JSON.stringify({ address: "t7", argv: ["x"], cwd: "/", state: "live" }));

    expect((await new Hc(labelled.run).terminal("t7")).labels).toEqual({ wake: "{}", where: "w" });
    expect((await new Hc(bare.run).terminal("t7")).labels).toBeUndefined();
  });
});

describe("Hc serverStatus reads the core name", () => {
  const reply = JSON.stringify({ core: { id: "8d4a003f50c1efe47c29866c4ead22be", name: "dev-home" }, uptime_s: 12, version: "0.1.21" });

  it("from the core of hc server status", async () => {
    const { run, calls } = recording(reply);

    expect(await new Hc(run).serverStatus()).toBe("dev-home");
    expect(calls[0]?.args).toEqual(["server", "status", "--json"]);
  });

  it.each([
    ["no core name", JSON.stringify({ core: { id: "8d4a" }, version: "0.1.21" })],
    ["no core", JSON.stringify({ version: "0.1.21" })],
    ["an empty core name", JSON.stringify({ core: { name: "" } })],
  ])("fails on a reply with %s, naming the command", async (_title, bad) => {
    const failure = await new Hc(recording(bad).run).serverStatus().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(HcError);
    expect((failure as HcError).message).toContain("hc server status --json");
  });

  it("fails when hc exits non-zero", async () => {
    const { run } = recording(new ProcessError("hc server status --json", "no server"));

    await expect(new Hc(run).serverStatus()).rejects.toBeInstanceOf(HcError);
  });
});

describe("keeps the kind of an hc error", () => {
  const spawnFailed = '{"error":{"hint":"","kind":"spawn_failed","message":"cannot start hct-no-such-program-xyz: No such file or directory (os error 2)"}}';

  async function failure(stderr: string): Promise<HcError> {
    const { run } = recording(new ProcessError("hc exec --json --timeout 5 -- hct-no-such-program-xyz --version", stderr));
    const error = await new Hc(run).exec(["hct-no-such-program-xyz", "--version"], { timeout: 5 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HcError);
    return error as HcError;
  }

  it("exposes the kind of a reply on stderr and keeps the message", async () => {
    const error = await failure(spawnFailed);

    expect(error.kind).toBe("spawn_failed");
    expect(error.message).toContain("cannot start hct-no-such-program-xyz");
  });

  it("has no kind when the reply names none", async () => {
    expect((await failure('{"error":{"message":"boom"}}')).kind).toBeUndefined();
  });

  it("has no kind when the output is not JSON", async () => {
    expect((await failure("hc: something broke")).kind).toBeUndefined();
  });

  it("has no kind when the wrapper raised the error itself", async () => {
    const { run } = recording(execReply({ truncated: true }));
    const error = await new Hc(run).exec(["x"]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HcError);
    expect((error as HcError).kind).toBeUndefined();
  });
});

describe("Hc send", () => {
  it("types a line into a terminal: pastes the text after the address, with no flags that change when it is typed", async () => {
    const { run, calls } = recording("");
    await new Hc(run).send("base-digital/t7", "hc-teleport: timeout (wait_timeout): gave up");
    expect(calls[0]?.file).toBe("hc");
    expect(calls[0]?.args).toEqual(["send", "--", "base-digital/t7", "hc-teleport: timeout (wait_timeout): gave up"]);
  });

  it("types a line into a terminal: names the terminal when hc fails", async () => {
    const { run } = recording(new ProcessError("hc send", '{"error":{"kind":"not_found"}}'));
    const failure = await new Hc(run).send("t9", "hello").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HcError);
    expect((failure as HcError).message).toContain("hc send t9");
    expect((failure as HcError).kind).toBe("not_found");
  });
});
