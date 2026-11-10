import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processRunner } from "../../src/platform/process.ts";
import { snapshotGit } from "../../src/git-carry/snapshot.ts";

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-carry-snapshot-"));
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
  commit("first");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    encoding: "utf8",
  });
}

function commit(message: string): void {
  git(["commit", "-q", "-m", message]);
}

function write(path: string, content: string | Buffer): void {
  writeFileSync(join(repo, path), content);
}

function sha1(bytes: Buffer | string): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (path === ".git") return [];
    return entry.isDirectory() ? walk(dir, path) : [path];
  });
}

/** Everything the snapshot must leave alone, in a form two readings can be compared on. */
function fingerprint(): Record<string, unknown> {
  const files = Object.fromEntries(
    walk(repo)
      .sort()
      .map((path) => {
        const stat = lstatSync(join(repo, path));
        const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(join(repo, path))) : readFileSync(join(repo, path));
        return [path, `${stat.mode.toString(8)} ${sha1(bytes)}`];
      }),
  );
  return {
    index: sha1(readFileSync(join(repo, ".git", "index"))),
    head: git(["rev-parse", "HEAD"]),
    refs: git(["for-each-ref"]),
    stash: git(["stash", "list"]),
    status: git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    files,
  };
}

async function snapshot() {
  const outcome = await snapshotGit(repo, processRunner());
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  return outcome.snapshot;
}

/** The expected content of the working-tree commit, from git's own listing of what is on disk. */
function onDisk(): Map<string, string> {
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter((p) => p !== "");
  const present = new Map<string, string>();
  for (const path of [...new Set(listed)]) {
    let stat;
    try {
      stat = lstatSync(join(repo, path));
    } catch {
      continue;
    }
    const kind = stat.isSymbolicLink() ? "120000" : stat.mode & 0o100 ? "100755" : "100644";
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(join(repo, path))) : readFileSync(join(repo, path));
    present.set(path, `${kind} ${sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))}`);
  }
  return present;
}

function treeOf(commit: string): Map<string, string> {
  const entries = git(["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0").filter((e) => e !== "");
  return new Map(
    entries.map((entry) => {
      const [meta = "", path = ""] = entry.split("\t");
      const [mode, , object] = meta.split(" ");
      return [path, `${mode} ${object}`];
    }),
  );
}

/** Runs the snapshot, then checks the commits against the checkout and the checkout against itself. */
async function snapshotsLeavingTheSourceAlone() {
  const before = fingerprint();
  const expectedWorktree = onDisk();
  const taken = await snapshot();
  expect(fingerprint()).toEqual(before);
  expect(`${taken.head}\n`).toBe(before["head"]);
  expect(git(["rev-parse", `${taken.staged}^`])).toBe(`${taken.head}\n`);
  expect(git(["rev-parse", `${taken.worktree}^`])).toBe(`${taken.staged}\n`);
  expect(git(["diff-tree", "-r", "--no-abbrev", taken.head, taken.staged])).toBe(
    git(["diff", "--cached", "--raw", "--no-abbrev"]),
  );
  expect(treeOf(taken.worktree)).toEqual(expectedWorktree);
  return taken;
}

describe("snapshots a source checkout from a subdirectory", () => {
  async function fromSubdirectory(cwd: string) {
    const outcome = await snapshotGit(cwd, processRunner());
    if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
    return outcome.snapshot;
  }

  it("names the repository's top level and holds changes outside the subdirectory", async () => {
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    write("packages/api/inside.txt", "inside\n");
    git(["add", "-A"]);
    commit("subdirectory");
    write("tracked.txt", "edited outside\n");
    write("fresh.txt", "untracked outside\n");
    write("packages/api/inside.txt", "edited inside\n");
    const before = fingerprint();

    const taken = await fromSubdirectory(join(repo, "packages", "api"));

    expect(taken.root).toBe(repo);
    expect(git(["show", `${taken.worktree}:tracked.txt`])).toBe("edited outside\n");
    expect(git(["show", `${taken.worktree}:fresh.txt`])).toBe("untracked outside\n");
    expect(git(["show", `${taken.worktree}:packages/api/inside.txt`])).toBe("edited inside\n");
    expect(fingerprint()).toEqual(before);
  });

  it("names the same top level for the top level itself and for a path with a trailing slash", async () => {
    mkdirSync(join(repo, "packages"), { recursive: true });
    expect((await fromSubdirectory(repo)).root).toBe(repo);
    expect((await fromSubdirectory(`${join(repo, "packages")}/`)).root).toBe(repo);
  });

  it("names the repository a symlinked subdirectory is in, by its real path", async () => {
    mkdirSync(join(repo, "packages"), { recursive: true });
    const link = join(root, "link");
    symlinkSync(join(repo, "packages"), link);
    expect((await fromSubdirectory(link)).root).toBe(repo);
  });

  it("rejects a folder in no repository", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    await expect(snapshotGit(outside, processRunner())).rejects.toThrow(/not a git repository/);
  });
});

describe("snapshots a source checkout", () => {
  it("names the head commit and the branch of a clean checkout, with two commits that change nothing", async () => {
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(taken.branch).toBe("main");
    expect(taken.root).toBe(repo);
    expect(treeOf(taken.staged)).toEqual(treeOf(taken.head));
    expect(treeOf(taken.worktree)).toEqual(treeOf(taken.head));
  });

  it("puts staged changes in the staged commit and not beyond", async () => {
    write("tracked.txt", "two\n");
    write("added.txt", "new\n");
    git(["add", "tracked.txt", "added.txt"]);
    write("tracked.txt", "three\n");
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(git(["show", `${taken.staged}:tracked.txt`])).toBe("two\n");
    expect(git(["show", `${taken.worktree}:tracked.txt`])).toBe("three\n");
    expect(git(["show", `${taken.staged}:added.txt`])).toBe("new\n");
  });

  it("puts unstaged changes in the working-tree commit only", async () => {
    write("tracked.txt", "edited\n");
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(git(["show", `${taken.staged}:tracked.txt`])).toBe("one\n");
    expect(git(["show", `${taken.worktree}:tracked.txt`])).toBe("edited\n");
  });

  it("carries an untracked file in the working-tree commit only", async () => {
    write("fresh.txt", "untracked\n");
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(treeOf(taken.staged).has("fresh.txt")).toBe(false);
    expect(git(["show", `${taken.worktree}:fresh.txt`])).toBe("untracked\n");
  });

  it("leaves an ignored file out of both commits", async () => {
    write("ignored.log", "noise\n");
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(treeOf(taken.staged).has("ignored.log")).toBe(false);
    expect(treeOf(taken.worktree).has("ignored.log")).toBe(false);
  });

  it("carries a deletion that is staged and one that is not", async () => {
    git(["rm", "-q", "gone-staged.txt"]);
    unlinkSync(join(repo, "gone-unstaged.txt"));
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(treeOf(taken.staged).has("gone-staged.txt")).toBe(false);
    expect(treeOf(taken.staged).has("gone-unstaged.txt")).toBe(true);
    expect(treeOf(taken.worktree).has("gone-unstaged.txt")).toBe(false);
  });

  it("carries a binary file byte for byte", async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 0, 13, 10, 0, 128]);
    write("blob.bin", bytes);
    const taken = await snapshotsLeavingTheSourceAlone();
    const stored = execFileSync("git", ["-C", repo, "cat-file", "blob", `${taken.worktree}:blob.bin`]);
    expect(stored.equals(bytes)).toBe(true);
  });

  it("carries an executable bit change", async () => {
    chmodSync(join(repo, "run.sh"), 0o755);
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(treeOf(taken.worktree).get("run.sh")?.startsWith("100755")).toBe(true);
    expect(treeOf(taken.staged).get("run.sh")?.startsWith("100644")).toBe(true);
  });

  it("carries a symlink as a link", async () => {
    symlinkSync("tracked.txt", join(repo, "link"));
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(treeOf(taken.worktree).get("link")?.startsWith("120000")).toBe(true);
  });

  it("carries a path with spaces and non-ASCII characters", async () => {
    mkdirSync(join(repo, "dir with space"));
    write("dir with space/ação ü.txt", "olá\n");
    const taken = await snapshotsLeavingTheSourceAlone();
    expect(git(["show", `${taken.worktree}:dir with space/ação ü.txt`])).toBe("olá\n");
  });

  it("refuses a detached HEAD and changes nothing", async () => {
    git(["checkout", "-q", "--detach"]);
    const before = fingerprint();
    expect(await snapshotGit(repo, processRunner())).toEqual({ ok: false, reason: "source_detached" });
    expect(fingerprint()).toEqual(before);
  });

  it("refuses a branch with no commit", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    execFileSync("git", ["-C", empty, "init", "-q", "-b", "main"]);
    expect(await snapshotGit(empty, processRunner())).toEqual({ ok: false, reason: "source_no_commit" });
  });
});
