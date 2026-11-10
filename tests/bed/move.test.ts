import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bed, BED_PROJECT_ROOT, BED_START_TIMEOUT_MS, REPO_MOUNT, type Side } from "./bed.ts";

const SOURCE_HOME = "/Users/mac";
const DEST_HOME = "/home/box";
const CLI = `${REPO_MOUNT}/src/app/cli.ts`;
const GIT_USER = ["-c", "user.name=bed", "-c", "user.email=bed@example.test"];
const RESUME_FAILS = `${DEST_HOME}/.fake-claude-resume-fails`;
const CONFIG_DIRS = { claude: ".claude", "claude-klock": ".claude-klock" } as const;
const MOVE_TIMEOUT_MS = 115_000;

type Launcher = keyof typeof CONFIG_DIRS;

describe("hc-teleport moves a session from source to dest through the real hc, ssh and git", () => {
  let bed: Bed;
  let sequence = 0;

  beforeAll(async () => {
    bed = await Bed.start();
    for (const dir of Object.values(CONFIG_DIRS)) {
      await exec("dest", ["mkdir", "-p", `${DEST_HOME}/${dir}`]);
      await exec("source", ["mkdir", "-p", `${SOURCE_HOME}/${dir}`]);
    }
  }, BED_START_TIMEOUT_MS);

  afterAll(async () => {
    await bed?.stop();
  });

  async function exec(side: Side, argv: string[], cwd?: string, stdin?: string): Promise<string> {
    const ran = await bed.run(side, argv, { ...(cwd === undefined ? {} : { cwd }), ...(stdin === undefined ? {} : { stdin }) });
    if (ran.code !== 0) throw new Error(`${side}: ${argv.join(" ")} exited ${ran.code}\n${ran.stderr}`);
    return ran.stdout;
  }

  async function put(side: Side, path: string, text: string): Promise<void> {
    await exec(side, ["mkdir", "-p", "--", dirname(path)]);
    await exec(side, ["dd", `of=${path}`, "status=none"], undefined, text);
  }

  const git = (side: Side, cwd: string, ...args: string[]) => exec(side, ["git", ...GIT_USER, ...args], cwd);

  type Checkout = { path: string; subdir: string };

  /** A repository at one path on both machines, both at the same first commit on main, with a folder below its top level. */
  async function twinRepositories(): Promise<Checkout> {
    sequence += 1;
    const path = `${BED_PROJECT_ROOT}/move-${sequence}`;
    const subdir = `${path}/packages/api`;
    await git("source", BED_PROJECT_ROOT, "init", "-q", "-b", "main", path);
    await put("source", `${path}/.gitignore`, "ignored.log\n");
    await put("source", `${path}/tracked.txt`, "one\n");
    await put("source", `${subdir}/index.txt`, "api\n");
    await git("source", path, "add", "-A");
    await git("source", path, "commit", "-q", "-m", "first");
    await git("dest", BED_PROJECT_ROOT, "init", "-q", "-b", "main", path);
    await git("source", path, "push", "-q", `dest:${path}`, "HEAD:refs/heads/seed");
    await git("dest", path, "checkout", "-q", "-B", "main", "seed");
    await git("dest", path, "branch", "-q", "-D", "seed");
    return { path, subdir };
  }

  /** Every kind of change the carry takes, on top of a commit the destination lacks. */
  async function changeSource({ path, subdir }: Checkout): Promise<void> {
    await put("source", `${path}/second.txt`, "two\n");
    await git("source", path, "add", "second.txt");
    await git("source", path, "commit", "-q", "-m", "second");
    await put("source", `${path}/tracked.txt`, "staged\n");
    await put("source", `${path}/blob.bin`, "\u0000\u0001\u0002\n");
    await git("source", path, "add", "tracked.txt", "blob.bin");
    await put("source", `${path}/tracked.txt`, "staged then edited\n");
    await put("source", `${subdir}/index.txt`, "api edited\n");
    await put("source", `${path}/fresh.txt`, "fresh\n");
    await put("source", `${path}/ignored.log`, "noise\n");
  }

  /** What a person would compare to say two checkouts are the same: branch, HEAD, both diffs, untracked files. */
  async function observe(side: Side, path: string): Promise<string[]> {
    const untracked = (await git(side, path, "ls-files", "-z", "--others", "--exclude-standard")).split("\0").filter((name) => name !== "");
    return [
      await git(side, path, "symbolic-ref", "--short", "HEAD"),
      await git(side, path, "rev-parse", "HEAD"),
      await git(side, path, "diff", "--cached", "--binary", "--full-index"),
      await git(side, path, "diff", "--binary", "--full-index"),
      untracked.length === 0 ? "" : await exec(side, ["sha1sum", "--", ...untracked], path),
    ];
  }

  /** The session's terminal on source, idle, and its transcript with a subagent file, both naming the source home. */
  async function startSession(launcher: Launcher, cwd: string): Promise<{ id: string; address: string; configDir: string; transcript: string }> {
    const id = randomUUID();
    const configDir = `${SOURCE_HOME}/${CONFIG_DIRS[launcher]}`;
    const project = `${configDir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
    await put("source", `${project}/${id}.jsonl`, `{"cwd":"${cwd}","home":"${SOURCE_HOME}/notes"}\n`);
    await put("source", `${project}/${id}/subagents/agent-a.jsonl`, `{"file":"${SOURCE_HOME}/a.txt"}\n`);
    const started = await exec("source", ["hc", "run", "--json", "--bg", "--no-parent", `--cwd=${cwd}`, "--", launcher, "--resume", id]);
    const address = (JSON.parse(started) as { address: string }).address;
    expect(await exec("source", ["hc", "wait", "--json", "--timeout", "30", "--", address])).toContain("idle");
    return { id, address, configDir, transcript: project };
  }

  async function terminal(side: Side, address: string): Promise<{ state: string; argv: string[]; cwd: string; status?: { state: string } }> {
    return JSON.parse(await exec(side, ["hc", "get", address, "--json"]));
  }

  function addresses(json: string): string[] {
    const found: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          if (key === "address" && typeof inner === "string") found.push(inner);
          else visit(inner);
        }
      }
    };
    visit(JSON.parse(json));
    return found.sort();
  }

  /** What a move that changes nothing must leave alone on one machine: refs, HEAD, index, status, config files, live terminals. */
  async function fingerprint(side: Side, path: string): Promise<string[]> {
    const home = side === "source" ? SOURCE_HOME : DEST_HOME;
    const configFiles = (await exec(side, ["find", `${home}/.claude`, `${home}/.claude-klock`, "-type", "f", "-printf", "%p %s\n"])).split("\n").sort();
    return [
      await git(side, path, "for-each-ref"),
      await git(side, path, "rev-parse", "HEAD"),
      await git(side, path, "ls-files", "--stage"),
      await git(side, path, "--no-optional-locks", "status", "--porcelain=v2", "--untracked-files=all"),
      configFiles.join("\n"),
      addresses(await exec(side, ["hc", "ls", "--json"])).join(","),
    ];
  }

  async function teleport(address: string, ...extra: string[]): Promise<{ code: number; json: Record<string, any>; stderr: string }> {
    const ran = await bed.run("source", ["node", CLI, address, "dest", "--json", ...extra], { timeoutMs: MOVE_TIMEOUT_MS });
    expect(ran.stdout.trim().split("\n")).toHaveLength(1);
    return { code: ran.code, json: JSON.parse(ran.stdout), stderr: ran.stderr };
  }

  it.each<Launcher>(["claude", "claude-klock"])("moves a %s session with every kind of change to dest and parks the source", async (launcher) => {
    const checkout = await twinRepositories();
    await changeSource(checkout);
    const session = await startSession(launcher, checkout.subdir);
    const before = await observe("source", checkout.path);
    const head = (await git("source", checkout.path, "rev-parse", "HEAD")).trim();

    const moved = await teleport(session.address);

    expect(moved.code, moved.stderr).toBe(0);
    const { destination, parked } = moved.json.moved as { destination: string; parked: unknown };
    expect(destination).toMatch(/^dest\/t\d+$/);
    expect(parked).toEqual({ parked: true });

    const live = await terminal("source", destination);
    expect(live).toMatchObject({ state: "live", argv: [launcher, "--resume", session.id], cwd: checkout.subdir });
    const registries = await exec("dest", ["find", `${DEST_HOME}/${CONFIG_DIRS[launcher]}/sessions`, "-name", "*.json", "-exec", "cat", "{}", ";"]);
    expect(registries).toContain(session.id);
    expect(registries).toContain(checkout.subdir);

    expect(await observe("dest", checkout.path)).toEqual(before);
    expect((await git("dest", checkout.path, "rev-parse", "HEAD")).trim()).toBe(head);

    const destProject = session.transcript.replace(SOURCE_HOME, DEST_HOME);
    expect(await exec("dest", ["cat", `${destProject}/${session.id}.jsonl`])).toBe(`{"cwd":"${checkout.subdir}","home":"${DEST_HOME}/notes"}\n`);
    expect(await exec("dest", ["cat", `${destProject}/${session.id}/subagents/agent-a.jsonl`])).toBe(`{"file":"${DEST_HOME}/a.txt"}\n`);

    expect((await terminal("source", session.address)).state).not.toBe("live");
    const parkedRefs = await git("source", checkout.path, "for-each-ref", "--format=%(refname)", `refs/hc-teleport/${session.id}/`);
    expect(parkedRefs).toContain(`refs/hc-teleport/${session.id}/worktree`);
    expect(await git("source", checkout.path, "status", "--porcelain")).toBe("");
    expect((await git("source", checkout.path, "rev-parse", "HEAD")).trim()).toBe(head);
    await exec("source", ["test", "-e", `${checkout.path}/ignored.log`]);
    await exec("source", ["test", "!", "-e", `${checkout.path}/fresh.txt`]);
  });

  it("refuses a dirty destination, exit 3, and changes nothing on either side", async () => {
    const checkout = await twinRepositories();
    await changeSource(checkout);
    await put("dest", `${checkout.path}/tracked.txt`, "edited on dest\n");
    const session = await startSession("claude", checkout.subdir);
    const before = [await fingerprint("source", checkout.path), await fingerprint("dest", checkout.path)];

    const refused = await teleport(session.address);

    expect(refused.code).toBe(3);
    expect(refused.json).toEqual({ refused: { reason: "dest_dirty", detail: expect.any(String) } });
    expect([await fingerprint("source", checkout.path), await fingerprint("dest", checkout.path)]).toEqual(before);
    expect((await terminal("source", session.address)).state).toBe("live");
  });

  it("rolls back a destination that does not come up, exit 4, leaving dest as before and the source untouched", async () => {
    const checkout = await twinRepositories();
    await changeSource(checkout);
    const session = await startSession("claude", checkout.subdir);
    const before = [await fingerprint("source", checkout.path), await fingerprint("dest", checkout.path)];
    await exec("dest", ["touch", RESUME_FAILS]);

    let rolledBack;
    try {
      rolledBack = await teleport(session.address, "--timeout", "20");
    } finally {
      await exec("dest", ["rm", "-f", "--", RESUME_FAILS]);
    }

    expect(rolledBack.code, rolledBack.stderr).toBe(4);
    expect(rolledBack.json).toEqual({ rolledBack: { reason: expect.stringMatching(/^destination_/), detail: expect.any(String) } });
    expect([await fingerprint("source", checkout.path), await fingerprint("dest", checkout.path)]).toEqual(before);
    expect(await git("dest", checkout.path, "for-each-ref", "refs/hc-teleport/")).toBe("");
    expect(await terminal("source", session.address)).toMatchObject({ state: "live", status: { state: "idle" } });
  });
});
