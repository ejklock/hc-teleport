import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bed, BED_START_TIMEOUT_MS, REPO_MOUNT } from "./bed.ts";

const DEST_HOME = "/home/box";
const MEGABYTE = 1024 * 1024;

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
});
