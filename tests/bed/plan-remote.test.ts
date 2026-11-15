import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bed, BED_PROJECT_ROOT, BED_START_TIMEOUT_MS, REPO_MOUNT, type Side } from "./bed.ts";

const DEST_HOME = "/home/box";
const CLI = `${REPO_MOUNT}/src/app/cli.ts`;
const CONFIG_DIRS = { claude: ".claude", "claude-klock": ".claude-klock" } as const;
const PLAN_TIMEOUT_MS = 110_000;

type Launcher = keyof typeof CONFIG_DIRS;

describe("hc-teleport plans a move to the Mac of a session that runs on dest, through the real hc and ssh", () => {
  let bed: Bed;

  beforeAll(async () => {
    bed = await Bed.start();
  }, BED_START_TIMEOUT_MS);

  afterAll(async () => {
    await bed?.stop();
  });

  async function exec(side: Side, argv: string[], stdin?: string): Promise<string> {
    const ran = await bed.run(side, argv, stdin === undefined ? {} : { stdin });
    if (ran.code !== 0) throw new Error(`${side}: ${argv.join(" ")} exited ${ran.code}\n${ran.stderr}`);
    return ran.stdout;
  }

  async function put(side: Side, path: string, text: string): Promise<void> {
    await exec(side, ["mkdir", "-p", "--", dirname(path)]);
    await exec(side, ["dd", `of=${path}`, "status=none"], text);
  }

  /** hc reports a terminal's foreground process a moment after the terminal reports idle. */
  async function untilForeground(address: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await exec("source", ["hc", "get", address, "--json"])).includes('"foreground"')) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${address} never reported a foreground process`);
  }

  /** A session idle in an hc terminal on dest, started from source, with a transcript and a subagent folder on dest. */
  async function startOnDest(launcher: Launcher): Promise<{ id: string; address: string; configDir: string; project: string }> {
    const id = randomUUID();
    const cwd = `${BED_PROJECT_ROOT}/plan-${launcher}`;
    const configDir = `${DEST_HOME}/${CONFIG_DIRS[launcher]}`;
    const project = `${configDir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
    await exec("dest", ["mkdir", "-p", "--", cwd]);
    await put("dest", `${project}/${id}.jsonl`, `{"cwd":"${cwd}"}\n`);
    await put("dest", `${project}/${id}/subagents/agent-a.jsonl`, "{}\n");
    const started = await exec("source", ["hc", "run", "--json", "--bg", "--no-parent", "--on=dest", `--cwd=${cwd}`, "--", launcher, "--resume", id]);
    const address = (JSON.parse(started) as { address: string }).address;
    expect(address).toMatch(/^dest\/t\d+$/);
    expect(await exec("source", ["hc", "wait", "--json", "--timeout", "30", "--", address])).toContain("idle");
    await untilForeground(address);
    return { id, address, configDir, project };
  }

  function plan(address: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return bed.run("source", ["node", CLI, address, "local", "--dry-run", "--json"], { timeoutMs: PLAN_TIMEOUT_MS });
  }

  it.each<Launcher>(["claude", "claude-klock"])("prints the %s session the dest registry holds, with its paths and resume command", async (launcher) => {
    const session = await startOnDest(launcher);

    const ran = await plan(session.address);

    expect(ran.code, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      terminal: session.address,
      source: "dest",
      machine: "local",
      cwd: `${BED_PROJECT_ROOT}/plan-${launcher}`,
      session: { id: session.id, configDir: session.configDir, version: "2.1.321" },
      transcript: { file: `${session.project}/${session.id}.jsonl`, dir: `${session.project}/${session.id}` },
      resume: { argv: [launcher, "--resume", session.id] },
      relocate: false,
    });
  });

  it("refuses with local_name_taken while hc lists a machine named local", async () => {
    const started = await exec("source", ["hc", "run", "--json", "--bg", "--no-parent", "--", "claude"]);
    const address = (JSON.parse(started) as { address: string }).address;
    expect(await exec("source", ["hc", "wait", "--json", "--timeout", "30", "--", address])).toContain("idle");
    await exec("source", ["hc", "machine", "rename", "dest", "local"]);

    let ran;
    try {
      ran = await bed.run("source", ["node", CLI, address, "local", "--dry-run", "--json"], { timeoutMs: PLAN_TIMEOUT_MS });
    } finally {
      await exec("source", ["hc", "machine", "rename", "local", "dest"]);
    }

    expect(ran.code, ran.stderr).toBe(3);
    expect(JSON.parse(ran.stdout)).toEqual({ refused: { reason: "local_name_taken", detail: expect.stringContaining("local") } });
  });
});
