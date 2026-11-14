import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, nodeConfigFs, saveConfig } from "../../src/config/config.ts";

let scratch: string;
let file: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "config-"));
  file = join(scratch, "hc-teleport", "config.json");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function write(text: string): Promise<void> {
  await mkdir(join(scratch, "hc-teleport"), { recursive: true });
  await writeFile(file, text);
}

describe("requires the config: where it lives", () => {
  it("reads it under an absolute XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/etc/xdg" }, "/home/me")).toBe("/etc/xdg/hc-teleport/config.json");
  });

  it.each([["relative/dir"], [""], [undefined]])("falls back to $HOME/.config for XDG_CONFIG_HOME %j", (xdg) => {
    expect(configPath(xdg === undefined ? {} : { XDG_CONFIG_HOME: xdg }, "/home/me")).toBe("/home/me/.config/hc-teleport/config.json");
  });
});

describe("requires the config: loading it", () => {
  it("reports a missing file as missing", async () => {
    expect(await loadConfig(file)).toEqual({ kind: "missing" });
  });

  it("returns the allowed machines of a valid file", async () => {
    await write('{"v":1,"allowed":["local","base-digital"]}');
    expect(await loadConfig(file)).toEqual({ kind: "ok", config: { v: 1, allowed: ["local", "base-digital"] } });
  });

  it("accepts an empty allowed list", async () => {
    await write('{"v":1,"allowed":[]}');
    expect(await loadConfig(file)).toEqual({ kind: "ok", config: { v: 1, allowed: [] } });
  });

  it.each([
    ["not JSON", "{nope"],
    ["version 2", '{"v":2,"allowed":[]}'],
    ["allowed not an array", '{"v":1,"allowed":"local"}'],
    ["an empty entry", '{"v":1,"allowed":["local",""]}'],
    ["a non-string entry", '{"v":1,"allowed":["local",3]}'],
    ["a JSON array", "[]"],
  ])("reports %s as unreadable", async (_title, text) => {
    await write(text);
    const loaded = await loadConfig(file);
    expect(loaded).toMatchObject({ kind: "unreadable" });
    expect(loaded).toHaveProperty("detail", expect.stringMatching(/./));
  });

  it("reports a path that is a folder as unreadable", async () => {
    await mkdir(file, { recursive: true });
    const loaded = await loadConfig(file);
    expect(loaded).toMatchObject({ kind: "unreadable" });
    expect(loaded).toHaveProperty("detail", expect.stringMatching(/./));
  });
});

describe("saving the config", () => {
  it("creates the folder and writes the file", async () => {
    await saveConfig(file, { v: 1, allowed: ["local"] });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ v: 1, allowed: ["local"] });
  });

  it("leaves the earlier file intact and no temporary file when the rename fails", async () => {
    await write('{"v":1,"allowed":["old"]}');
    const failing = { ...nodeConfigFs, rename: () => Promise.reject(new Error("disk gone")) };

    await expect(saveConfig(file, { v: 1, allowed: ["new"] }, failing)).rejects.toThrow("disk gone");

    expect(await readFile(file, "utf8")).toBe('{"v":1,"allowed":["old"]}');
    expect(await readdir(join(scratch, "hc-teleport"))).toEqual(["config.json"]);
  });
});
