import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parkSource } from "../../src/git-carry/index.ts";
import { snapshotGit } from "../../src/git-carry/snapshot.ts";
import { processRunner, type Runner } from "../../src/platform/process.ts";

let root: string;
let repo: string;
const run = processRunner();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-carry-park-"));
  // git names a repository by its real path, which a temporary directory may not be.
  repo = join(realpathSync(root), "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"]);
  write(".gitignore", "ignored.log\n");
  write("tracked.txt", "one\n");
  write("gone-staged.txt", "staged away\n");
  write("gone-unstaged.txt", "unstaged away\n");
  write("run.sh", "#!/bin/sh\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "first"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    encoding: "utf8",
  });
}

function write(path: string, content: string | Buffer): void {
  writeFileSync(join(repo, path), content);
}

function sha1(bytes: Buffer | string): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function walk(prefix = ""): string[] {
  return readdirSync(join(repo, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (path === ".git") return [];
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** Everything a park must keep or restore: files with their modes, the index, HEAD and the branch. */
function checkout(): Record<string, unknown> {
  const files = Object.fromEntries(
    walk()
      .sort()
      .map((path) => {
        const stat = lstatSync(join(repo, path));
        const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(join(repo, path))) : readFileSync(join(repo, path));
        return [path, `${stat.isSymbolicLink() ? "link" : stat.mode & 0o100 ? "exec" : "file"} ${sha1(bytes)}`];
      }),
  );
  return {
    files,
    index: git(["ls-files", "-s", "-z"]),
    head: git(["rev-parse", "HEAD"]),
    branch: git(["symbolic-ref", "HEAD"]),
    status: git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
  };
}

/** The outcome a carry of the checkout as it is now would have resolved with. */
async function carried(id = randomUUID()) {
  const taken = await snapshotGit(repo, run);
  if (!taken.ok) throw new Error(taken.reason);
  const { snapshot } = taken;
  return {
    status: "carried" as const,
    machine: "dest",
    cwd: snapshot.root,
    id,
    refs: ["head", "staged", "worktree"].map((name) => `refs/hc-teleport/${id}/${name}`),
    branch: snapshot.branch,
    carried: { head: snapshot.head, staged: snapshot.staged, worktree: snapshot.worktree },
  };
}

const refsOf = (id: string): string => git(["for-each-ref", "--format=%(refname) %(objectname)", `refs/hc-teleport/${id}/`]);

function dirty(): void {
  write("tracked.txt", "staged\n");
  git(["add", "tracked.txt"]);
  write("tracked.txt", "staged then edited\n");
  git(["rm", "-q", "gone-staged.txt"]);
  rmSync(join(repo, "gone-unstaged.txt"));
  write("fresh.txt", "fresh\n");
  write("ignored.log", "noise\n");
  write("blob.bin", Buffer.from([0, 255, 1, 254, 0, 13, 10]));
  git(["add", "blob.bin"]);
  write("blob.bin", Buffer.from([0, 255, 1, 254, 0, 13, 10, 0, 1, 2]));
  chmodSync(join(repo, "run.sh"), 0o755);
  symlinkSync("tracked.txt", join(repo, "link"));
  mkdirSync(join(repo, "dir with space"));
  write("dir with space/ação ü.txt", "olá\n");
}

describe("parks the source after a carry", () => {
  it("parks a clean source: refs written, nothing to reset", async () => {
    const outcome = await carried();
    const before = checkout();

    expect(await parkSource(outcome, { run })).toEqual({ parked: true });

    expect(checkout()).toEqual(before);
    expect(refsOf(outcome.id)).toBe(
      [
        `refs/hc-teleport/${outcome.id}/head ${outcome.carried.head}`,
        `refs/hc-teleport/${outcome.id}/staged ${outcome.carried.staged}`,
        `refs/hc-teleport/${outcome.id}/worktree ${outcome.carried.worktree}`,
      ].join("\n") + "\n",
    );
  });

  it("parks every kind of change, resets the checkout to HEAD and keeps ignored files", async () => {
    dirty();
    const outcome = await carried();
    const before = checkout();

    expect(await parkSource(outcome, { run })).toEqual({ parked: true });

    expect(git(["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe("");
    expect(git(["rev-parse", "HEAD"])).toBe(`${outcome.carried.head}\n`);
    expect(git(["symbolic-ref", "--short", "HEAD"])).toBe("main\n");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(repo, "ignored.log"), "utf8")).toBe("noise\n");
    expect(walk().sort()).toEqual([".gitignore", "gone-staged.txt", "gone-unstaged.txt", "ignored.log", "run.sh", "tracked.txt"]);
    expect(lstatSync(join(repo, "run.sh")).mode & 0o100).toBe(0);

    git(["read-tree", "-u", "--reset", `refs/hc-teleport/${outcome.id}/worktree`]);
    git(["read-tree", `refs/hc-teleport/${outcome.id}/staged`]);
    expect(checkout()).toEqual(before);
  });

  describe("when the source changed after the carry", () => {
    async function expectKept(change: () => void, named: RegExp): Promise<void> {
      dirty();
      const outcome = await carried();
      change();
      const before = checkout();

      const result = await parkSource(outcome, { run });

      expect(result.parked).toBe(false);
      expect(result).toMatchObject({ reason: expect.stringMatching(named) });
      expect(checkout()).toEqual(before);
      expect(git(["rev-parse", `refs/hc-teleport/${outcome.id}/head`])).toBe(`${outcome.carried.head}\n`);
      expect(git(["rev-parse", `refs/hc-teleport/${outcome.id}/worktree`])).toBe(`${outcome.carried.worktree}\n`);
    }

    it("keeps an edit made after the carry", async () => {
      await expectKept(() => write("tracked.txt", "later\n"), /working tree/);
    });

    it("keeps a new untracked file", async () => {
      await expectKept(() => write("later.txt", "later\n"), /working tree/);
    });

    it("keeps a new commit", async () => {
      await expectKept(() => {
        write("later.txt", "later\n");
        git(["add", "later.txt"]);
        git(["commit", "-q", "-m", "later"]);
      }, /HEAD/);
    });

    it("keeps a switch to another branch", async () => {
      await expectKept(() => git(["checkout", "-q", "-b", "other"]), /branch/);
    });
  });

  it("keeps a source whose index alone changed after the carry, naming the index", async () => {
    dirty();
    const outcome = await carried();
    git(["add", "tracked.txt"]);
    const before = checkout();

    const result = await parkSource(outcome, { run });

    expect(result).toEqual({ parked: false, reason: "the source changed after the carry: index" });
    expect(checkout()).toEqual(before);
  });

  it("refuses an outcome that is not a carried one, writing nothing on the source", async () => {
    dirty();
    const outcome = { ...(await carried()), status: "failed", step: "checkout", detail: "x" };
    const before = checkout();
    const refsBefore = git(["for-each-ref"]);

    await expect(parkSource(outcome as never, { run })).rejects.toThrow(/carried/);

    expect(checkout()).toEqual(before);
    expect(git(["for-each-ref"])).toBe(refsBefore);
  });

  it("refuses a session id that is not a UUID before writing anything", async () => {
    const outcome = { ...(await carried()), id: "../../heads/main" };
    await expect(parkSource(outcome, { run })).rejects.toThrow(/uuid/i);
    expect(git(["for-each-ref"])).not.toMatch(/\.\.|hc-teleport/);
  });
});

describe("parks the source of a carry from a remote source", () => {
  /** hc whose machine is this host: it runs the program here, and the local runner is never to be used. */
  const hc = {
    exec: (argv: readonly string[], options?: { env?: Readonly<Record<string, string>> }) => {
      const result = spawnSync(argv[0] ?? "git", argv.slice(1), { encoding: "utf8", env: { ...process.env, ...options?.env } });
      return Promise.resolve({ code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr });
    },
  };
  const never: Runner = () => Promise.reject(new Error("the source is remote: nothing runs through the local runner"));

  async function carriedFromDev() {
    const taken = await snapshotGit(repo, run);
    if (!taken.ok) throw new Error(taken.reason);
    const { snapshot } = taken;
    const id = randomUUID();
    return {
      status: "carried" as const,
      machine: "local",
      source: "dev",
      cwd: snapshot.root,
      id,
      refs: ["head", "staged", "worktree"].map((name) => `refs/hc-teleport/${id}/${name}`),
      branch: snapshot.branch,
      carried: { head: snapshot.head, staged: snapshot.staged, worktree: snapshot.worktree },
    };
  }

  it("parks on that machine, keeping every change under the refs and ignored files in place", async () => {
    dirty();
    const outcome = await carriedFromDev();
    const before = checkout();

    expect(await parkSource(outcome, { run: never, hc })).toEqual({ parked: true });

    expect(git(["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe("");
    expect(git(["rev-parse", "HEAD"])).toBe(`${outcome.carried.head}\n`);
    expect(readFileSync(join(repo, "ignored.log"), "utf8")).toBe("noise\n");
    expect(refsOf(outcome.id)).toContain(`refs/hc-teleport/${outcome.id}/worktree ${outcome.carried.worktree}`);
    git(["read-tree", "-u", "--reset", `refs/hc-teleport/${outcome.id}/worktree`]);
    git(["read-tree", `refs/hc-teleport/${outcome.id}/staged`]);
    expect(checkout()).toEqual(before);
  });

  it("keeps a checkout that changed after the carry and names what changed", async () => {
    dirty();
    const outcome = await carriedFromDev();
    write("tracked.txt", "later\n");
    const before = checkout();

    expect(await parkSource(outcome, { run: never, hc })).toEqual({
      parked: false,
      reason: "the source changed after the carry: working tree",
    });

    expect(checkout()).toEqual(before);
  });
});
