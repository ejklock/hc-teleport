import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discardState, isFinal, listStates, readState, statePath, writeState, type DetachedState } from "../../src/detach/state.ts";

const SESSION = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";

const initial: DetachedState = {
  v: 1,
  session: SESSION,
  source: "t2s",
  machine: "base-digital",
  phase: "waiting",
  waitSeconds: 300,
  timeoutSeconds: 120,
  startedAt: 1_000,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hct-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detached move state", () => {
  it("lives under an absolute XDG_STATE_HOME", () => {
    expect(statePath({ XDG_STATE_HOME: "/var/state" }, "/home/box", SESSION)).toBe(`/var/state/hc-teleport/${SESSION}.json`);
  });

  it("falls back to the home's .local/state when XDG_STATE_HOME is relative, empty or unset", () => {
    const expected = `/home/box/.local/state/hc-teleport/${SESSION}.json`;
    expect(statePath({ XDG_STATE_HOME: "state" }, "/home/box", SESSION)).toBe(expected);
    expect(statePath({ XDG_STATE_HOME: "" }, "/home/box", SESSION)).toBe(expected);
    expect(statePath({}, "/home/box", SESSION)).toBe(expected);
  });

  it("creates the folder on a first write and reads back what it wrote", async () => {
    const path = join(dir, "nested", `${SESSION}.json`);

    await writeState(path, initial);

    expect(await readState(path)).toEqual({ kind: "ok", state: initial });
  });

  it("tells final phases from the two that are still running", () => {
    expect(isFinal("waiting")).toBe(false);
    expect(isFinal("moving")).toBe(false);
    expect(isFinal("timeout")).toBe(true);
  });

  it("writes through a temporary file that is gone afterwards, and reads back what it wrote", async () => {
    const path = join(dir, `${SESSION}.json`);
    const outcome = { reason: "dest_dirty", detail: "x", resumedAt: "t4" };
    await writeState(path, initial);
    await writeState(path, { ...initial, phase: "rolled_back", outcome, sendError: "hc send failed" });

    expect(await readdir(dir)).toEqual([`${SESSION}.json`]);
    expect(await readState(path)).toMatchObject({ kind: "ok", state: { phase: "rolled_back", outcome, sendError: "hc send failed" } });
  });

  it("leaves no file but the state file through every phase, a final one included", async () => {
    const path = join(dir, `${SESSION}.json`);

    for (const phase of ["waiting", "moving", "timeout"] as const) {
      await writeState(path, { ...initial, phase, runner: "t9" });
      expect(await readdir(dir)).toEqual([`${SESSION}.json`]);
    }
  });

  it("removes the state file of a move that never started and nothing else", async () => {
    const path = join(dir, `${SESSION}.json`);
    await writeFile(join(dir, "other.json"), "{}");
    await writeState(path, initial);

    await discardState(path);

    expect(await readdir(dir)).toEqual(["other.json"]);
  });

  it("reads a malformed file as state_unreadable", async () => {
    const path = join(dir, `${SESSION}.json`);
    await writeFile(path, "{not json");
    expect(await readState(path)).toMatchObject({ kind: "unreadable" });
    await writeFile(path, JSON.stringify({ ...initial, phase: "sleeping" }));
    expect(await readState(path)).toMatchObject({ kind: "unreadable" });
    expect(await readState(join(dir, "absent.json"))).toMatchObject({ kind: "unreadable", missing: true });
  });

  it("lists every state file of a folder, a malformed one as unreadable, and none for a missing folder", async () => {
    await writeState(join(dir, "a.json"), initial);
    await writeFile(join(dir, "b.json"), "oops");
    await writeFile(join(dir, "notes.txt"), "ignored");

    const listed = await listStates(dir);

    expect(listed.map((entry) => [entry.path, entry.read.kind])).toEqual([
      [join(dir, "a.json"), "ok"],
      [join(dir, "b.json"), "unreadable"],
    ]);
    expect(await listStates(join(dir, "none"))).toEqual([]);
  });
});
