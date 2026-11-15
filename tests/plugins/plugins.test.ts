import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const readJson = (path: string): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(JSON.parse(read(path)));

const version = readJson("package.json")["version"];

const claudeCommand = "plugins/hc-teleport/commands/hc-teleport.md";
const piPrompt = "packages/hc-teleport-agent/prompts/hc-teleport.md";
const pluginSkill = "plugins/hc-teleport/skills/hc-teleport/SKILL.md";
const packageSkill = "packages/hc-teleport-agent/skills/hc-teleport/SKILL.md";

const splitFrontmatter = (text: string): { front: string; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("no frontmatter");
  return { front: match[1], body: match[2] };
};

describe("plugin manifests", () => {
  it("lists one hc-teleport plugin without a version in the Claude Code marketplace", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(marketplace["plugins"]).toEqual([{ name: "hc-teleport", source: "./plugins/hc-teleport" }]);
    expect(JSON.stringify(marketplace)).not.toContain("version");
  });

  it("lists one hc-teleport plugin without a version in the Codex marketplace", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json");
    const plugins = z.array(z.record(z.string(), z.unknown())).parse(marketplace["plugins"]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: "hc-teleport", source: { source: "local", path: "./plugins/hc-teleport" } });
    expect(JSON.stringify(marketplace)).not.toContain("version");
  });

  it.each([
    ["plugins/hc-teleport/.claude-plugin/plugin.json", "hc-teleport"],
    ["plugins/hc-teleport/plugin.json", "hc-teleport"],
    ["packages/hc-teleport-agent/package.json", "hc-teleport-agent"],
  ])("%s carries the CLI version and its name", (path, name) => {
    const manifest = readJson(path);
    expect(manifest["name"]).toBe(name);
    expect(manifest["version"]).toBe(version);
  });

  it("keeps the Pi skills and prompts folders and ships the prompts folder", () => {
    const manifest = readJson("packages/hc-teleport-agent/package.json");
    expect(manifest["pi"]).toEqual({ skills: ["skills"], prompts: ["prompts"] });
    expect(manifest["files"]).toEqual(expect.arrayContaining(["index.ts", "skills", "prompts", "README.md"]));
  });

  it.each([
    ".claude-plugin/marketplace.json",
    "plugins/hc-teleport/.claude-plugin/plugin.json",
    "plugins/hc-teleport/plugin.json",
    "packages/hc-teleport-agent/package.json",
  ])("%s describes the /hc-teleport command and the Claude Code sessions it moves", (path) => {
    const description = readJson(path)["description"];
    expect(description).toEqual(expect.stringContaining("/hc-teleport"));
    expect(description).toEqual(expect.stringContaining("Claude Code"));
    expect(description).not.toEqual(expect.stringMatching(/\/teleport/));
  });

  it.each([
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "plugins/hc-teleport/.claude-plugin/plugin.json",
    "plugins/hc-teleport/plugin.json",
    "packages/hc-teleport-agent/package.json",
  ])("%s names no MCP server", (path) => {
    expect(read(path).toLowerCase()).not.toContain("mcp");
  });
});

describe("teleport instructions", () => {
  it("keeps the skill copy of the package equal to the plugin's", () => {
    expect(read(packageSkill)).toBe(read(pluginSkill));
  });

  it("gives the Claude command and the Pi prompt the same body", () => {
    expect(splitFrontmatter(read(piPrompt)).body).toBe(splitFrontmatter(read(claudeCommand)).body);
  });

  it.each([
    ["the Claude command", claudeCommand],
    ["the Pi prompt", piPrompt],
    ["the plugin skill", pluginSkill],
  ])("tells the agent in %s to detach, end its turn and name init", (_title, path) => {
    const { body } = splitFrontmatter(read(path));
    expect(body).toContain("hc-teleport <machine> --detach` once");
    expect(body).toMatch(/end (your|the) turn/i);
    expect(body).toMatch(/never wait|do not wait/i);
    expect(body).toMatch(/poll/i);
    expect(body).toContain("not_initialized");
    expect(body).toContain("hc-teleport init");
  });

  it.each([
    ["the Claude command", claudeCommand],
    ["the Pi prompt", piPrompt],
    ["the plugin skill", pluginSkill],
  ])("tells the agent in %s that only Claude Code sessions move and to offer the doctor's machines", (_title, path) => {
    const body = read(path);
    expect(body).toContain("`not_claude`");
    expect(body).toMatch(/sessions cannot move yet/);
    expect(body).toMatch(/no machine is named[^\n]*`hc-teleport doctor`/i);
    expect(body).not.toContain("hc machine ls");
  });

  it("names no teleport command besides hc-teleport", () => {
    expect(() => read("plugins/hc-teleport/commands/teleport.md")).toThrow();
    expect(() => read("packages/hc-teleport-agent/prompts/teleport.md")).toThrow();
  });

  it("gives the Claude command a description, an argument hint and the arguments placeholder", () => {
    const { front, body } = splitFrontmatter(read(claudeCommand));
    expect(front).toMatch(/^description: .+/m);
    expect(front).toMatch(/^argument-hint: .+/m);
    expect(body).toContain("$ARGUMENTS");
  });

  it("gives the Pi prompt a description and the arguments placeholder", () => {
    const { front, body } = splitFrontmatter(read(piPrompt));
    expect(front).toMatch(/^description: .+/m);
    expect(body).toContain("$ARGUMENTS");
  });

  it("gives the skill a name and a description", () => {
    const { front } = splitFrontmatter(read(pluginSkill));
    expect(front).toMatch(/^name: hc-teleport$/m);
    expect(front).toMatch(/^description: .+/m);
  });
});

type Config = { skills?: { paths?: string[] }; command?: Record<string, { template: string; description: string }> };

const runHook = async (config: Config): Promise<Config> => {
  const { server } = await import("../../packages/hc-teleport-agent/index.ts");
  const hooks = await server();
  await hooks.config(config);
  return config;
};

describe("opencode hook", () => {
  it("sits in a package folder holding the hook, the skill and the prompt", () => {
    expect(readdirSync(join(root, "packages/hc-teleport-agent")).sort()).toEqual(["README.md", "index.ts", "package.json", "prompts", "skills"]);
  });

  it("adds its skills directory once however often it runs", async () => {
    const config: Config = { skills: { paths: ["/own/skills"] } };
    await runHook(config);
    await runHook(config);
    const paths = config.skills?.paths ?? [];
    expect(paths.filter((p) => p.endsWith("/packages/hc-teleport-agent/skills"))).toHaveLength(1);
    expect(paths[0]).toBe("/own/skills");
  });

  it("adds the hc-teleport command with the Pi prompt body", async () => {
    const config = await runHook({});
    const { front, body } = splitFrontmatter(read(piPrompt));
    const description = /^description: (.+)$/m.exec(front)?.[1];
    expect(description).toBeDefined();
    expect(config.command?.["hc-teleport"]).toEqual({ template: body, description });
    expect(Object.keys(config.command ?? {})).toEqual(["hc-teleport"]);
  });

  it("leaves a user's own hc-teleport command and other commands untouched", async () => {
    const own = { template: "mine", description: "mine" };
    const other = { template: "x", description: "y" };
    const config = await runHook({ command: { "hc-teleport": own, other } });
    expect(config.command).toEqual({ "hc-teleport": own, other });
  });
});
