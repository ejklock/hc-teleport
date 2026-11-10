import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Machine, MachineError } from "../../src/platform/machine.ts";

const MEGABYTE = 1024 * 1024;
const RELATIVE_PATHS = ["-p", "-delete", "!", "(", "x", "./x", ""];

export type MachineContractOptions = {
  /** Builds the machine under test; runs once before the cases. */
  start: () => Promise<Machine>;
  /** Releases whatever `start` built; runs once after the cases. */
  stop?: () => Promise<void>;
  /** The machine's temp folder, which `makeTempDir` must create under. */
  tempRoot: string;
  /** The machine's absolute home directory. */
  home: string;
  startTimeoutMs?: number;
};

async function failureOf(promise: Promise<unknown>): Promise<MachineError | undefined> {
  return promise.then(
    () => undefined,
    (error: MachineError) => error,
  );
}

/**
 * Registers the cases every `Machine` must pass, so two implementations are held to the same behavior.
 * Call it inside a `describe`; it adds hooks and cases to that suite.
 */
export function machineContract(options: MachineContractOptions): void {
  let machine: Machine;
  let scratch: string;

  async function sh(script: string, ...args: string[]): Promise<void> {
    const ran = await machine.exec(["sh", "-c", script, "sh", ...args]);
    expect(ran).toMatchObject({ code: 0 });
  }

  beforeAll(async () => {
    machine = await options.start();
    scratch = await machine.makeTempDir();
  }, options.startTimeoutMs);

  afterAll(async () => {
    if (machine !== undefined && scratch !== undefined) await machine.remove(scratch);
    await options.stop?.();
  });

  describe("running programs", () => {
    it("runs a program: exit 0 resolves its output", async () => {
      expect(await machine.exec(["printf", "%s", "hello"])).toEqual({ code: 0, stdout: "hello", stderr: "" });
    });

    it("runs a program: a non-zero exit is a result naming its stderr", async () => {
      expect(await machine.exec(["sh", "-c", "echo oops >&2; exit 3"])).toEqual({ code: 3, stdout: "", stderr: "oops\n" });
    });

    it("runs a program: stdin arrives unchanged, non-ASCII included", async () => {
      const stdin = "first line\nzwei ü line\n";
      expect(await machine.exec(["cat"], { stdin })).toEqual({ code: 0, stdout: stdin, stderr: "" });
    });

    it("runs a program: an env entry is visible to it and not to the next call", async () => {
      expect(await machine.exec(["printenv", "MACHINE_TEST_VAR"], { env: { MACHINE_TEST_VAR: "a b" } })).toMatchObject({ code: 0, stdout: "a b\n" });
      expect(await machine.exec(["printenv", "MACHINE_TEST_VAR"])).toMatchObject({ code: 1, stdout: "" });
    });

    it.each(["my project", "-x"])("runs a program in a cwd named %s", async (name) => {
      const cwd = `${scratch}/${name}`;
      await sh('mkdir -p -- "$1"', cwd);
      expect(await machine.exec(["pwd"], { cwd })).toMatchObject({ code: 0, stdout: `${await machine.realpath(cwd)}\n` });
    });

    it("runs a program: an argv element that begins with a dash arrives unchanged", async () => {
      expect(await machine.exec(["sh", "-c", 'printf "%s" "$1"', "sh", "--dash-arg"])).toMatchObject({ code: 0, stdout: "--dash-arg" });
    });

    it("runs a program: one missing on the machine rejects naming it and the machine", async () => {
      const failure = await failureOf(machine.exec(["no-such-program-here"]));
      expect(failure?.code).toBe("exec_failed");
      expect(failure?.message).toContain(machine.name);
      expect(failure?.message).toContain("no-such-program-here");
    });

    it("runs a program: one killed by a signal rejects naming it and the machine", async () => {
      const failure = await failureOf(machine.exec(["sh", "-c", "kill -9 $$"]));
      expect(failure?.code).toBe("exec_failed");
      expect(failure?.message).toContain(machine.name);
      expect(failure?.message).toMatch(/sh.*signal/);
    });

    it("runs a program: one that outlives its timeout rejects naming it and the machine", async () => {
      const started = Date.now();
      const failure = await failureOf(machine.exec(["sleep", "5"], { timeoutSeconds: 1 }));
      expect(failure?.code).toBe("exec_failed");
      expect(failure?.message).toContain(machine.name);
      expect(failure?.message).toMatch(/sleep.*(timeout|timed_out)/);
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it("runs a program: names the machine and resolves its absolute home", async () => {
      expect(machine.name).not.toBe("");
      expect(await machine.home()).toBe(options.home);
    });
  });

  describe("relative paths", () => {
    it.each(RELATIVE_PATHS)("relative path %j is refused by every path-taking method", async (path) => {
      const calls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
        ["readFile", () => machine.readFile(path)],
        ["writeFile", () => machine.writeFile(path, "x")],
        ["realpath", () => machine.realpath(path)],
        ["entries", () => machine.entries(path)],
        ["kind", () => machine.kind(path)],
        ["remove", () => machine.remove(path)],
        ["exec cwd", () => machine.exec(["true"], { cwd: path })],
      ];
      for (const [method, call] of calls) {
        const failure = await failureOf(call());
        expect(failure?.code, `${method} of ${JSON.stringify(path)}`).toBe("not_absolute");
      }
    });

    it.each(["-delete", "!", "-p"])("files: an absolute path ending in %s is a name and nothing else is touched", async (name) => {
      const root = `${scratch}/names`;
      const folder = `${root}/${name}`;
      await machine.writeFile(`${root}/sibling`, "keep");
      await machine.writeFile(`${folder}/inner`, "x");
      expect(await machine.kind(folder)).toBe("dir");
      expect(await machine.entries(folder)).toEqual([{ path: `${folder}/inner`, kind: "file" }]);
      expect(await machine.realpath(folder)).toBe(`${await machine.realpath(root)}/${name}`);
      await machine.remove(folder);
      expect(await machine.kind(folder)).toBeUndefined();
      expect(await machine.readFile(`${root}/sibling`)).toBe("keep");
    });
  });

  describe("files", () => {
    it.each([
      ["empty", ""],
      ["no final newline", "one\ntwo"],
      ["a leading byte-order mark", "﻿bom text\n"],
      ["non-ASCII", "zwei ü, 日本語, 🙂\n"],
      ["1 MB", `${"0123456789abcdef".repeat(64)}\n`.repeat(MEGABYTE / 1025)],
    ])("files: a text with %s round-trips exactly", async (_title, text) => {
      const path = `${scratch}/round/made/trip.txt`;
      await machine.writeFile(path, text);
      expect(await machine.readFile(path)).toBe(text);
    });

    it("files: a missing path rejects ENOENT", async () => {
      expect((await failureOf(machine.readFile(`${scratch}/nope.txt`)))?.code).toBe("ENOENT");
      expect((await failureOf(machine.realpath(`${scratch}/nope.txt`)))?.code).toBe("ENOENT");
      expect((await failureOf(machine.entries(`${scratch}/nope`)))?.code).toBe("ENOENT");
    });

    it("files: a path through a regular file rejects ENOTDIR for realpath and entries and is not there for kind", async () => {
      const file = `${scratch}/plain.txt`;
      await machine.writeFile(file, "x");
      expect((await failureOf(machine.realpath(`${file}/below`)))?.code).toBe("ENOTDIR");
      expect((await failureOf(machine.entries(file)))?.code).toBe("ENOTDIR");
      expect(await machine.kind(`${file}/below`)).toBeUndefined();
    });

    it("files: bytes that are not UTF-8 reject not_text", async () => {
      const path = `${scratch}/binary.bin`;
      await sh(`printf 'a\\377b' > "$1"`, path);
      expect((await failureOf(machine.readFile(path)))?.code).toBe("not_text");
    });

    it("files: realpath resolves a symlink", async () => {
      await sh('mkdir -p -- "$1" && ln -s -- "$1" "$2"', `${scratch}/real-dir`, `${scratch}/pointer`);
      expect(await machine.realpath(`${scratch}/pointer`)).toBe(await machine.realpath(`${scratch}/real-dir`));
    });

    it("files: entries lists everything below sorted by path without following a symlink, and kind agrees", async () => {
      const root = `${scratch}/tree`;
      await sh('mkdir -p -- "$1/dir"', root);
      await sh('cd -- "$1" && touch -- ./-dash "./a b" "./multi\nline" dir/inner.txt && ln -s -- "$1/dir" link && ln -s -- "$1/gone" dangling && mkfifo pipe', root);
      const expected = [
        { path: `${root}/-dash`, kind: "file" },
        { path: `${root}/a b`, kind: "file" },
        { path: `${root}/dangling`, kind: "symlink" },
        { path: `${root}/dir`, kind: "dir" },
        { path: `${root}/dir/inner.txt`, kind: "file" },
        { path: `${root}/link`, kind: "symlink" },
        { path: `${root}/multi\nline`, kind: "file" },
        { path: `${root}/pipe`, kind: "other" },
      ];
      expect(await machine.entries(root)).toEqual(expected);
      for (const { path, kind } of expected) expect(await machine.kind(path)).toBe(kind);
      expect(await machine.kind(`${root}/gone`)).toBeUndefined();
      expect(await machine.kind(`${root}/a b/below`)).toBeUndefined();
    });

    it("files: a path the user cannot read rejects failed for kind and entries, never absent", async (context) => {
      const id = await machine.exec(["id", "-u"]);
      if (id.stdout === "0\n") context.skip("running as root, where mode 000 denies nothing");
      const locked = `${scratch}/locked`;
      await machine.writeFile(`${locked}/inner`, "x");
      await sh('chmod 000 "$1"', locked);
      try {
        expect((await failureOf(machine.kind(`${locked}/inner`)))?.code).toBe("failed");
        expect((await failureOf(machine.entries(locked)))?.code).toBe("failed");
      } finally {
        await sh('chmod 755 "$1"', locked);
      }
    });

    it("files: a temp folder is fresh, named hc-teleport-, and remove deletes it with what is in it and a missing one too", async () => {
      const first = await machine.makeTempDir();
      const second = await machine.makeTempDir();
      expect(first).not.toBe(second);
      expect(first.startsWith(`${options.tempRoot}/`)).toBe(true);
      expect(first.slice(first.lastIndexOf("/") + 1)).toMatch(/^hc-teleport-/);
      await machine.writeFile(`${first}/deep/f.txt`, "x");
      await machine.remove(first);
      expect(await machine.kind(first)).toBeUndefined();
      await machine.remove(first);
      await machine.remove(second);
    });
  });
}
