import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputEnded, renderDoctor, runDoctor, runInit } from "../../src/app/init.ts";
import { nodeConfigFs } from "../../src/config/config.ts";
import { HcError, type HcExecOptions, type HcExecResult, type HcMachine } from "../../src/platform/hc.ts";

const MACHINES = ["base-digital", "planet-argon", "inovatec"];

function listed(...names: string[]): HcMachine[] {
  return names.map((name) => ({ name, state: "connected" }));
}

type ExecCall = { argv: readonly string[]; options: HcExecOptions };

type FakeHcOptions = {
  machines?: readonly string[];
  core?: string;
  exec?: (call: ExecCall) => HcExecResult | Error;
};

function fakeHc(options: FakeHcOptions = {}) {
  const calls: ExecCall[] = [];
  return {
    calls,
    serverStatus: () => Promise.resolve(options.core ?? "dev-home"),
    machines: () => Promise.resolve(listed(...(options.machines ?? MACHINES))),
    exec: (argv: readonly string[], execOptions: HcExecOptions = {}): Promise<HcExecResult> => {
      const call = { argv, options: execOptions };
      calls.push(call);
      const outcome = options.exec?.(call) ?? { code: 0, stdout: "2.1.321 (Claude Code)\n", stderr: "" };
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

let scratch: string;
let path: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "init-"));
  path = join(scratch, "xdg", "hc-teleport", "config.json");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A prompt that answers each question from `answers` in order and records the questions it was asked. */
function scripted(answers: readonly string[]) {
  const questions: string[] = [];
  const lines = [...answers];
  const ask = (question: string): Promise<string> => {
    questions.push(question);
    const next = lines.shift();
    return next === undefined ? Promise.reject(new InputEnded()) : Promise.resolve(next);
  };
  return { ask, questions };
}

async function wizard(answers: readonly string[], hc = fakeHc()) {
  const prompt = scripted(answers);
  const out: string[] = [];
  await runInit({ hc, ask: prompt.ask, out: (line) => out.push(line), path, fs: nodeConfigFs });
  return { questions: prompt.questions, out };
}

async function stored(): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("init wizard", () => {
  it("asks about the core by its name, then each hc machine in order, and writes the answers", async () => {
    const { questions } = await wizard(["y", "n", "y", "n"]);

    expect(questions).toHaveLength(4);
    expect(questions[0]).toContain("dev-home");
    expect(questions.slice(1).map((question, index) => question.includes(MACHINES[index] ?? "?"))).toEqual([true, true, true]);
    expect(await stored()).toEqual({ v: 1, allowed: ["local", "planet-argon"] });
  });

  it("keeps the previous answers when only Enter is pressed", async () => {
    await wizard(["y", "n", "y", "n"]);

    const { questions } = await wizard(["", "", "", ""]);

    expect(await stored()).toEqual({ v: 1, allowed: ["local", "planet-argon"] });
    expect(questions[0]).toContain("Y/n");
    expect(questions[1]).toContain("y/N");
  });

  it("lets a later answer change an earlier one", async () => {
    await wizard(["y", "n", "y", "n"]);

    await wizard(["n", "yes", "", "no"]);

    expect(await stored()).toEqual({ v: 1, allowed: ["base-digital", "planet-argon"] });
  });

  it("asks again after an answer that is not y, yes, n, no or Enter", async () => {
    const { questions } = await wizard(["maybe", "Y", "n", "n", "n"]);

    expect(questions).toHaveLength(5);
    expect(questions[1]).toBe(questions[0]);
    expect(await stored()).toEqual({ v: 1, allowed: ["local"] });
  });

  it("writes an empty list and says no machine may receive a session when every answer is no", async () => {
    const { out } = await wizard(["n", "n", "n", "n"]);

    expect(await stored()).toEqual({ v: 1, allowed: [] });
    expect(out.join("\n")).toContain("no machine may receive a session");
  });

  it("names the file it wrote", async () => {
    const { out } = await wizard(["y", "y", "y", "y"]);

    expect(out.join("\n")).toContain(path);
  });

  it("creates the config folder when it is absent", async () => {
    await wizard(["y", "n", "n", "n"]);

    expect(await readdir(join(scratch, "xdg", "hc-teleport"))).toEqual(["config.json"]);
  });

  it("starts from no previous answers when the existing file is unreadable", async () => {
    await mkdir(join(scratch, "xdg", "hc-teleport"), { recursive: true });
    await writeFile(path, "{broken");

    await wizard(["", "", "y", ""]);

    expect(await stored()).toEqual({ v: 1, allowed: ["planet-argon"] });
  });

  it("keeps the earlier file intact when the write fails", async () => {
    await wizard(["y", "n", "n", "n"]);
    const prompt = scripted(["n", "y", "y", "y"]);
    const fs = { ...nodeConfigFs, rename: () => Promise.reject(new Error("disk gone")) };

    await expect(runInit({ hc: fakeHc(), ask: prompt.ask, out: () => undefined, path, fs })).rejects.toThrow("disk gone");

    expect(await stored()).toEqual({ v: 1, allowed: ["local"] });
  });

  it("stops without writing when the input ends", async () => {
    await expect(wizard(["y"])).rejects.toBeInstanceOf(InputEnded);

    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});

describe("doctor", () => {
  const allowed = (...names: string[]) => ({ v: 1 as const, allowed: names });

  it("reports a reachable machine with the version claude prints", async () => {
    const hc = fakeHc();

    const lines = await runDoctor({ hc, config: allowed("base-digital") });

    expect(lines).toEqual([{ name: "base-digital", status: "ok", detail: "2.1.321 (Claude Code)" }]);
    expect(hc.calls[0]?.argv).toEqual(["claude", "--version"]);
    expect(hc.calls[0]?.options).toMatchObject({ on: "base-digital" });
  });

  it("checks local on the core, without --on", async () => {
    const hc = fakeHc();

    const lines = await runDoctor({ hc, config: allowed("local") });

    expect(lines).toEqual([{ name: "local", status: "ok", detail: "2.1.321 (Claude Code)" }]);
    expect(hc.calls[0]?.options.on).toBeUndefined();
  });

  it("reports a machine hc cannot reach as unreachable with the reason", async () => {
    const hc = fakeHc({ exec: ({ options }) => (options.on === "planet-argon" ? new HcError("cannot reach planet-argon: timed out") : { code: 0, stdout: "2.1.0\n", stderr: "" }) });

    const lines = await runDoctor({ hc, config: allowed("base-digital", "planet-argon") });

    expect(lines).toEqual([
      { name: "base-digital", status: "ok", detail: "2.1.0" },
      { name: "planet-argon", status: "unreachable", detail: "cannot reach planet-argon: timed out" },
    ]);
  });

  it("reports claude missing when claude --version exits non-zero", async () => {
    const hc = fakeHc({ exec: () => ({ code: 127, stdout: "", stderr: "claude: not found\n" }) });

    const lines = await runDoctor({ hc, config: allowed("inovatec") });

    expect(lines).toEqual([{ name: "inovatec", status: "claude missing", detail: "claude: not found" }]);
  });

  it.each(["local", "base-digital"])("reports claude missing on %s when hc cannot start the program", async (name) => {
    const message = 'hc exec claude --version: {"error":{"kind":"spawn_failed","message":"cannot start claude: No such file or directory (os error 2)"}}';
    const hc = fakeHc({ exec: () => new HcError(message) });

    const lines = await runDoctor({ hc, config: allowed(name) });

    expect(lines).toEqual([{ name, status: "claude missing", detail: message }]);
    expect(renderDoctor(lines).exit).toBe(1);
  });

  it("reports unreachable for an hc error that names no kind", async () => {
    const hc = fakeHc({ exec: () => new HcError("hc exec claude --version: hc: broke") });

    const lines = await runDoctor({ hc, config: allowed("local") });

    expect(lines).toEqual([{ name: "local", status: "unreachable", detail: "hc exec claude --version: hc: broke" }]);
  });

  it("names a config machine that hc machine ls no longer lists, without running anything on it", async () => {
    const hc = fakeHc();

    const lines = await runDoctor({ hc, config: allowed("gone-box") });

    expect(lines).toEqual([{ name: "gone-box", status: "not in hc machine ls", detail: "" }]);
    expect(hc.calls).toEqual([]);
  });

  it("prints one line per machine and exits 0 only when every line is ok", () => {
    const ok = { name: "local", status: "ok", detail: "2.1.321" };
    const bad = { name: "inovatec", status: "unreachable", detail: "timed out" };

    expect(renderDoctor([ok])).toEqual({ text: "local  ok  2.1.321", exit: 0 });
    expect(renderDoctor([ok, bad])).toEqual({ text: "local  ok  2.1.321\ninovatec  unreachable  timed out", exit: 1 });
  });

  it("writes nothing", async () => {
    await mkdir(join(scratch, "xdg", "hc-teleport"), { recursive: true });
    await writeFile(path, '{"v":1,"allowed":["local"]}');

    await runDoctor({ hc: fakeHc(), config: allowed("local", "base-digital") });

    expect(await readdir(join(scratch, "xdg", "hc-teleport"))).toEqual(["config.json"]);
    expect(await readFile(path, "utf8")).toBe('{"v":1,"allowed":["local"]}');
  });
});
