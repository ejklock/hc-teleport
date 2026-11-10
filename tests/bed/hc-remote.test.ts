import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bed, BED_START_TIMEOUT_MS, REPO_MOUNT } from "./bed.ts";

const DEST_HOME = "/home/box";
const MEGABYTE = 1024 * 1024;
/** hc ends an orphaned terminal asynchronously, so a survivor is only proved across a stretch of reads. */
const SURVIVAL_WINDOW_MS = 5_000;

/** Runs one `Hc` method on source, through the real hc, and prints its outcome as JSON. */
const DRIVER = `
import { readFileSync } from "node:fs";
import { Hc } from "${REPO_MOUNT}/src/platform/hc.ts";
const { method, args } = JSON.parse(readFileSync(0, "utf8"));
const hc = new Hc();
try {
  const value = await hc[method](...args);
  process.stdout.write(JSON.stringify({ ok: value ?? null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ failed: String(error?.message ?? error) }));
}
`;

describe("Hc remote calls through the real hc", () => {
  let bed: Bed;

  beforeAll(async () => {
    bed = await Bed.start();
  }, BED_START_TIMEOUT_MS);

  afterAll(async () => {
    await bed?.stop();
  });

  async function call(method: string, ...args: unknown[]): Promise<unknown> {
    const ran = await bed.run(
      "source",
      ["node", "--input-type=module", "-e", DRIVER],
      { stdin: JSON.stringify({ method, args }), timeoutMs: 110_000 },
    );
    expect(ran.stderr).toBe("");
    const outcome = JSON.parse(ran.stdout) as { ok?: unknown; failed?: string };
    if (outcome.failed !== undefined) throw new Error(outcome.failed);
    return outcome.ok;
  }

  it("runs a program on dest and reports its output", async () => {
    const reply = (await call("exec", ["uname", "-m"], { on: "dest" })) as {
      code: number;
      stdout: string;
    };
    expect(reply.code).toBe(0);
    expect(reply.stdout.trim()).not.toBe("");
  });

  it("runs a program on dest: a failing program is a result naming its path", async () => {
    const reply = (await call("exec", ["ls", "/nonexistent"], {
      on: "dest",
    })) as { code: number; stderr: string };
    expect(reply.code).not.toBe(0);
    expect(reply.stderr).toContain("/nonexistent");
  });

  it("runs a program on dest: stdin comes back unchanged", async () => {
    const stdin = "first line\nsecond ü line\n";
    const reply = (await call("exec", ["cat"], { on: "dest", stdin })) as {
      code: number;
      stdout: string;
    };
    expect(reply).toMatchObject({ code: 0, stdout: stdin });
  });

  it("runs a program on dest: one that outlives its timeout fails naming timed_out", async () => {
    const started = Date.now();
    await expect(call("exec", ["sleep", "5"], { on: "dest", timeout: 2 })).rejects.toThrow(/timed_out/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("runs a program on dest: one killed by a signal fails naming the signal", async () => {
    await expect(call("exec", ["sh", "-c", "kill -9 $$"], { on: "dest" })).rejects.toThrow(/signal 9/);
  });

  it("reads and writes a file on dest, and exec sees the same bytes", async () => {
    const path = `${DEST_HOME}/hc-remote/notes.txt`;
    const text = "one\nzwei ü\nthree";
    await call("writeFile", path, text, { on: "dest" });
    expect(await call("readFile", path, { on: "dest" })).toBe(text);
    const shown = (await call("exec", ["cat", path], { on: "dest" })) as {
      stdout: string;
    };
    expect(shown.stdout).toBe(text);
  });

  it("reads and writes a file on dest: a text of 1 MB round-trips", async () => {
    const path = `${DEST_HOME}/hc-remote/one-megabyte.txt`;
    const text = `${"0123456789abcdef".repeat(64)}\n`.repeat(MEGABYTE / 1025);
    await call("writeFile", path, text, { on: "dest" });
    expect(await call("readFile", path, { on: "dest" })).toBe(text);
  });

  it("reads and writes a file on dest: a file past hc's read cap fails instead of coming back cut short", async () => {
    const path = `${DEST_HOME}/hc-remote/past-the-cap.txt`;
    const text = `${"y".repeat(1023)}\n`.repeat(8 * 1024);
    await call("writeFile", path, text, { on: "dest" });
    await expect(call("readFile", path, { on: "dest" })).rejects.toThrow(/truncated/);
  });

  it("lists dest with its ssh target", async () => {
    const machines = (await call("machines")) as { name: string; sshTarget?: string }[];
    expect(machines).toContainEqual(
      expect.objectContaining({ name: "dest", sshTarget: "dest" }),
    );
  });

  type Terminal = { address: string; argv: string[]; cwd: string; state: string; exit_code?: number; status?: { state: string } };
  const terminal = (address: string) => call("terminal", address) as Promise<Terminal>;
  const startOnDest = (argv: string[], cwd = DEST_HOME) => call("run", argv, { on: "dest", cwd, keep: true }) as Promise<string>;
  const waitFor = (address: string, timeout = 30) => call("wait", address, { timeout });

  async function sessionRegistries(): Promise<string> {
    const found = (await call("exec", ["find", `${DEST_HOME}/.claude/sessions`, "-name", "*.json", "-exec", "cat", "{}", ";"], { on: "dest" })) as { stdout: string };
    return found.stdout;
  }

  it("starts claude --resume in a folder with a space and reads it back from dest", async () => {
    const cwd = `${DEST_HOME}/my project`;
    await call("exec", ["mkdir", "-p", cwd], { on: "dest" });
    const id = randomUUID();
    const address = await startOnDest(["claude", "--resume", id], cwd);
    expect(address).toMatch(/^dest\/t\d+$/);
    const started = await terminal(address);
    expect(started).toMatchObject({ cwd, argv: ["claude", "--resume", id], state: "live" });
  });

  it("starts a program in a folder whose name begins with a dash and it runs there", async () => {
    const cwd = `${DEST_HOME}/-x`;
    await call("exec", ["mkdir", "-p", cwd], { on: "dest" });
    const address = await startOnDest(["sh", "-c", "pwd > where.txt"], cwd);
    expect(await waitFor(address)).toMatchObject({ kind: "exited", code: 0 });
    expect(await call("readFile", "where.txt", { on: "dest", cwd })).toBe(`${cwd}\n`);
  });

  it("runs a program on dest in a folder whose name begins with a dash", async () => {
    const cwd = `${DEST_HOME}/-x`;
    await call("exec", ["mkdir", "-p", cwd], { on: "dest" });
    const reply = (await call("exec", ["pwd"], { on: "dest", cwd })) as { code: number; stdout: string };
    expect(reply).toMatchObject({ code: 0, stdout: `${cwd}\n` });
  });

  it("starts a program with an argv element that begins with a dash and it arrives unchanged", async () => {
    const out = `${DEST_HOME}/dash-arg.txt`;
    const argv = ["sh", "-c", `printf '%s' "$1" > ${out}`, "sh", "--dash-arg"];
    const address = await startOnDest(argv);
    expect(await waitFor(address)).toMatchObject({ kind: "exited", code: 0 });
    expect((await terminal(address)).argv).toEqual(argv);
    expect(await call("readFile", out, { on: "dest" })).toBe("--dash-arg");
  });

  it("starts a program that is missing on dest: fails naming it", async () => {
    await expect(startOnDest(["no-such-program-here"])).rejects.toThrow(/no-such-program-here/);
  });

  it("starts a program on an unknown machine: fails naming the machine", async () => {
    await expect(call("run", ["true"], { on: "nowhere" })).rejects.toThrow(/nowhere/);
  });

  /** Runs a one-shot program in an hc terminal on source that starts the dest program, prints its address and ends. */
  async function startFromShortLivedTerminal(run: string): Promise<string> {
    const program = `
      import { Hc } from "${REPO_MOUNT}/src/platform/hc.ts";
      ${run}
    `;
    const launched = await bed.run(
      "source",
      ["hc", "run", "--json", "--timeout", "60", "--", "node", "--input-type=module", "-e", program],
      { timeoutMs: 110_000 },
    );
    expect(launched.code).toBe(0);
    const address = /dest\/t\d+/.exec((JSON.parse(launched.stdout) as { output: string }).output)?.[0];
    if (address === undefined) throw new Error(`no address in ${launched.stdout}`);
    return address;
  }

  it("starts a program that keeps running after the terminal that started it ends", async () => {
    const address = await startFromShortLivedTerminal(
      `const address = await new Hc().run(["sleep", "1000"], { on: "dest", keep: true });
       process.stdout.write(address);`,
    );
    const states: string[] = [];
    const until = Date.now() + SURVIVAL_WINDOW_MS;
    do {
      states.push((await terminal(address)).state);
    } while (Date.now() < until);
    expect(states.length).toBeGreaterThan(1);
    expect(states.filter((state) => state !== "live")).toEqual([]);
  });

  it("starts a program with hc's own default parent: it ends with the terminal that started it", async () => {
    const address = await startFromShortLivedTerminal(
      `import { execFileSync } from "node:child_process";
       const reply = JSON.parse(execFileSync("hc", ["run", "--json", "--bg", "--on", "dest", "--", "sleep", "1000"], { encoding: "utf8" }));
       process.stdout.write(reply.address);`,
    );
    await expect.poll(async () => (await terminal(address)).state, { timeout: 30_000 }).not.toBe("live");
  });

  it("waits for the fake claude to go idle and its registry names the resumed id", async () => {
    const id = randomUUID();
    const address = await startOnDest(["claude", "--resume", id]);
    expect(await waitFor(address)).toEqual({ kind: "stopped", status: "idle" });
    expect((await terminal(address)).status?.state).toBe("idle");
    expect(await sessionRegistries()).toContain(`"sessionId":"${id}"`);
  });

  it("waits for a program that exits 3 and resolves its exit code", async () => {
    const address = await startOnDest(["sh", "-c", "exit 3"]);
    expect(await waitFor(address)).toEqual({ kind: "exited", code: 3 });
  });

  it("waits on a program that never reports and never ends: resolves the timeout and it stays live", async () => {
    const address = await startOnDest(["sleep", "1000"]);
    const started = Date.now();
    expect(await waitFor(address, 2)).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await terminal(address)).state).toBe("live");
  });

  it("waits on an unknown terminal: fails naming it", async () => {
    await expect(waitFor("dest/t9999", 2)).rejects.toThrow(/t9999/);
  });

  it("ends the fake claude on dest: hc keeps its address, finished and killed", async () => {
    const address = await startOnDest(["claude", "--resume", randomUUID()]);
    await waitFor(address);
    const ended = (await call("kill", address)) as Terminal;
    expect(ended).toMatchObject({ address, state: "finished" });
    expect((await terminal(address)).state).toBe("finished");
  });

  it("ends a terminal on source itself", async () => {
    const address = (await call("run", ["sleep", "1000"], {})) as string;
    expect(address).toMatch(/^t\d+$/);
    expect((await terminal(address)).state).toBe("live");
    expect(((await call("kill", address)) as Terminal).state).toBe("finished");
    expect((await terminal(address)).state).toBe("finished");
  });

  it("ends a terminal that already ended: resolves with it as hc reports it", async () => {
    const address = await startOnDest(["sh", "-c", "exit 0"]);
    await waitFor(address);
    expect(((await call("kill", address)) as Terminal).state).toBe("finished");
    expect(((await call("kill", address)) as Terminal).state).toBe("finished");
  });

  it("ends an unknown terminal: fails naming it", async () => {
    await expect(call("kill", "dest/t9999")).rejects.toThrow(/t9999/);
  });
});
