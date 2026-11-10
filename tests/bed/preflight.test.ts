import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BED_PROJECT_ROOT, Bed, BED_START_TIMEOUT_MS, REPO_MOUNT } from "./bed.ts";

const DEST_HOME = "/home/box";
const REPO = `${BED_PROJECT_ROOT}/preflight-repo`;
const MISSING_REPO = `${BED_PROJECT_ROOT}/no-such-repo`;
const SUBDIRECTORY = `${REPO}/packages/api`;
const PROFILE = `${DEST_HOME}/.claude-klock`;

/** Runs the preflight on source, through the real hc against dest, and prints its outcome as JSON. */
const DRIVER = `
import { readFileSync } from "node:fs";
import { Hc } from "${REPO_MOUNT}/src/platform/hc.ts";
import { processRunner } from "${REPO_MOUNT}/src/platform/process.ts";
import { preflight } from "${REPO_MOUNT}/src/preflight/index.ts";
import { ClaudeAdapter } from "${REPO_MOUNT}/src/session/claude-adapter.ts";
const plan = JSON.parse(readFileSync(0, "utf8"));
try {
  const result = await preflight({ plan, machine: "dest" }, { hc: new Hc(), run: processRunner(), adapter: new ClaudeAdapter("/Users/mac") });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ failed: String(error?.message ?? error) }));
}
`;

function planFor(overrides: { cwd?: string; executable?: string; version?: string }) {
  return {
    terminal: "t1",
    machine: "dest",
    cwd: overrides.cwd ?? REPO,
    session: { id: "09e11b42-f5c1-4c38-99f1-dd1d8b00355c", configDir: "/Users/mac/.claude-klock", version: overrides.version ?? "2.1.321" },
    transcript: { file: "/Users/mac/.claude-klock/projects/x/s.jsonl" },
    resume: { argv: [overrides.executable ?? "claude-klock", "--resume", "09e11b42-f5c1-4c38-99f1-dd1d8b00355c"] },
  };
}

describe("preflight through the real hc against dest", () => {
  let bed: Bed;

  beforeAll(async () => {
    bed = await Bed.start();
    await ok(["git", "init", "--quiet", REPO]);
    // The source holds the repositories the plans name; MISSING_REPO is on source only.
    await ok(["git", "init", "--quiet", REPO], "source");
    await ok(["git", "init", "--quiet", MISSING_REPO], "source");
    await ok(["mkdir", "-p", PROFILE]);
  }, BED_START_TIMEOUT_MS);

  afterAll(async () => {
    await bed?.stop();
  });

  async function ok(argv: string[], side: "source" | "dest" = "dest"): Promise<void> {
    const ran = await bed.run(side, argv);
    expect(ran, argv.join(" ")).toMatchObject({ code: 0 });
  }

  /** Paths, sizes and modification times under dest's home and project root, apart from hc's own state directory, which hc rewrites for every call it serves. */
  async function listing(): Promise<string> {
    const ran = await bed.run("dest", [
      "find", DEST_HOME, BED_PROJECT_ROOT,
      "-path", `${DEST_HOME}/.local/state/herdr-core`, "-prune", "-o",
      "-printf", "%p %s %T@\n",
    ]);
    expect(ran.code).toBe(0);
    return ran.stdout.split("\n").sort().join("\n");
  }

  /** The preflight's outcome, with dest unchanged by it. */
  async function preflightLeavingDestUntouched(plan: unknown): Promise<unknown> {
    const before = await listing();
    const ran = await bed.run("source", ["node", "--input-type=module", "-e", DRIVER], { stdin: JSON.stringify(plan), timeoutMs: 110_000 });
    expect(ran.stderr).toBe("");
    expect(await listing()).toBe(before);
    return JSON.parse(ran.stdout);
  }

  it("accepts a destination with the repository and the profile directory", async () => {
    expect(await preflightLeavingDestUntouched(planFor({}))).toEqual({
      ok: true,
      destination: { home: DEST_HOME, configDir: PROFILE, version: "2.1.321" },
    });
  });

  it("accepts a subdirectory of the repository when dest holds the same top level, leaving dest unchanged", async () => {
    await ok(["mkdir", "-p", SUBDIRECTORY]);
    await ok(["mkdir", "-p", SUBDIRECTORY], "source");
    expect(await preflightLeavingDestUntouched(planFor({ cwd: SUBDIRECTORY }))).toEqual({
      ok: true,
      destination: { home: DEST_HOME, configDir: PROFILE, version: "2.1.321" },
    });
  });

  it("refuses with dest_repo_missing for a subdirectory whose repository is absent on dest", async () => {
    const nested = `${MISSING_REPO}/packages/api`;
    await ok(["mkdir", "-p", nested], "source");
    await ok(["mkdir", "-p", nested]);
    expect(await preflightLeavingDestUntouched(planFor({ cwd: nested }))).toMatchObject({
      ok: false,
      refusal: { reason: "dest_repo_missing", detail: expect.stringContaining(nested) },
    });
  });

  it("refuses with dest_repo_missing when the path has no repository", async () => {
    expect(await preflightLeavingDestUntouched(planFor({ cwd: MISSING_REPO }))).toMatchObject({
      ok: false,
      refusal: { reason: "dest_repo_missing", detail: expect.stringContaining(MISSING_REPO) },
    });
  });

  it("refuses with dest_executable_missing when the program does not exist", async () => {
    expect(await preflightLeavingDestUntouched(planFor({ executable: "claude-nope" }))).toMatchObject({
      ok: false,
      refusal: { reason: "dest_executable_missing", detail: expect.stringContaining("claude-nope") },
    });
  });

  it("refuses with dest_agent_older when the source runs a newer Claude Code", async () => {
    expect(await preflightLeavingDestUntouched(planFor({ version: "2.1.400" }))).toMatchObject({
      ok: false,
      refusal: { reason: "dest_agent_older" },
    });
  });

  it("refuses with dest_profile_missing once the profile directory is removed", async () => {
    await ok(["rmdir", PROFILE]);
    expect(await preflightLeavingDestUntouched(planFor({}))).toMatchObject({
      ok: false,
      refusal: { reason: "dest_profile_missing", detail: expect.stringContaining(PROFILE) },
    });
  });
});
