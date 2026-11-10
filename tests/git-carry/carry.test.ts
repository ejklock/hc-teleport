import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carryGit, undoGitCarry, type GitCarryDeps, type GitCarryOutcome } from "../../src/git-carry/carry.ts";
import { HcError } from "../../src/platform/hc.ts";
import { processRunner, type Runner } from "../../src/platform/process.ts";

const PREVIOUS_BRANCH = "other-branch";
const PREVIOUS_HEAD = "0123456789abcdef0123456789abcdef01234567";

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-carry-carry-"));
  // git names a repository by its real path, which a temporary directory may not be.
  repo = join(realpathSync(root), "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "tracked.txt"), "one\n");
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

/** Real git on the source; the push is answered without a network. */
const run: Runner = (file, args, options) =>
  args.includes("push") ? Promise.resolve("") : processRunner()(file, args, options);

/** A destination that is clean, at the same top level, on a known branch and HEAD, and fails hc itself on `failing`. */
function deps(failing: string): GitCarryDeps {
  return {
    run,
    hc: {
      machines: () => Promise.resolve([{ name: "dest", state: "online", sshTarget: "dest.example.test" }]),
      exec: (argv) => {
        const reply = (stdout: string, code = 0): Promise<{ code: number; stdout: string; stderr: string }> =>
          Promise.resolve({ code, stdout, stderr: "" });
        if (argv.includes("--show-toplevel")) return reply(`${repo}\n`);
        if (argv.includes("status")) return reply("");
        if (argv.includes("symbolic-ref")) return reply(`${PREVIOUS_BRANCH}\n`);
        if (argv.includes("refs/heads/main")) return reply("", 1);
        if (argv.includes("rev-parse")) return reply(`${PREVIOUS_HEAD}\n`);
        if (argv.includes(failing)) return Promise.reject(new HcError("the machine is unreachable"));
        return reply("");
      },
    },
  };
}

describe("carryGit when hc fails on a destination step after the push", () => {
  it.each([
    ["checkout", "checkout"],
    ["read-tree", "read-tree of the working tree"],
  ])("resolves failed on %s with the rollback data instead of throwing", async (failing, step) => {
    const id = randomUUID();

    const outcome = await carryGit({ cwd: repo, machine: "dest", id }, deps(failing));

    expect(outcome).toMatchObject({
      status: "failed",
      step,
      machine: "dest",
      cwd: repo,
      refs: [`refs/hc-teleport/${id}/head`, `refs/hc-teleport/${id}/staged`, `refs/hc-teleport/${id}/worktree`],
      previousBranch: PREVIOUS_BRANCH,
      previousHead: PREVIOUS_HEAD,
    });
    expect(outcome.status === "failed" && outcome.detail).toContain("the machine is unreachable");
  });
});

describe("undoGitCarry undoes from what the destination holds", () => {
  const exec = (argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const result = spawnSync(argv[0] ?? "git", argv.slice(1), { encoding: "utf8" });
    return Promise.resolve({ code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr });
  };
  const undoDeps = { hc: { exec, machines: () => Promise.resolve([]) } };

  function fingerprint(): string {
    return [
      git(["for-each-ref"]),
      git(["rev-parse", "HEAD"]),
      spawnSync("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8" }).stdout,
      git(["ls-files", "-s"]),
      git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]),
    ].join("\n---\n");
  }

  /** The destination at one commit, with a carried commit and its refs pushed but nothing checked out. */
  function pushed(id: string): { before: string; outcome: Extract<GitCarryOutcome, { status: "failed" }> } {
    const previousHead = git(["rev-parse", "HEAD"]).trim();
    git(["checkout", "-q", "-b", "scratch"]);
    writeFileSync(join(repo, "carried.txt"), "carried\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "carried"]);
    const carriedHead = git(["rev-parse", "HEAD"]).trim();
    git(["checkout", "-q", "main"]);
    git(["branch", "-q", "-D", "scratch"]);
    const before = fingerprint();
    const refs = ["head", "staged", "worktree"].map((name) => `refs/hc-teleport/${id}/${name}`);
    for (const ref of refs) git(["update-ref", ref, carriedHead]);
    return {
      before,
      outcome: {
        status: "failed",
        step: "checkout",
        detail: "the machine dropped",
        machine: "dest",
        id,
        cwd: repo,
        refs,
        previousBranch: "main",
        previousHead,
        branch: "main",
        branchPreviousHead: previousHead,
        carried: { head: carriedHead, staged: carriedHead, worktree: carriedHead },
      },
    };
  }

  beforeEach(() => {
    writeFileSync(join(repo, ".git", "info", "exclude"), "ignored.log\n");
    writeFileSync(join(repo, "ignored.log"), "kept\n");
  });

  /** What a working-tree read-tree leaves behind: an edited tracked file in the index and tree, and a new untracked file. */
  function dirtyTheCheckout(): void {
    writeFileSync(join(repo, "tracked.txt"), "carried edit\n");
    git(["add", "tracked.txt"]);
    writeFileSync(join(repo, "carried-new.txt"), "new\n");
  }

  const refsLeft = (id: string): string => git(["for-each-ref", `refs/hc-teleport/${id}/`]);

  it("undoes a checkout that ran although it was reported as failed, for a fast-forwarded branch", async () => {
    const id = randomUUID();
    const { before, outcome } = pushed(id);
    git(["checkout", "-q", "-B", "main", outcome.carried.head, "--"]);
    git(["read-tree", "-u", "--reset", outcome.carried.worktree]);

    await undoGitCarry(outcome, undoDeps);

    expect(fingerprint()).toBe(before);
    expect(refsLeft(id)).toBe("");
    await undoGitCarry(outcome, undoDeps);
    expect(fingerprint()).toBe(before);
  });

  it("undoes a checkout that ran although it was reported as failed, for a branch the checkout created", async () => {
    const id = randomUUID();
    const { before, outcome } = pushed(id);
    const { branchPreviousHead: _gone, ...rest } = outcome;
    const created = { ...rest, branch: "feature" };
    git(["checkout", "-q", "-B", "feature", outcome.carried.head, "--"]);

    await undoGitCarry(created, undoDeps);

    expect(fingerprint()).toBe(before);
    expect(refsLeft(id)).toBe("");
    await undoGitCarry(created, undoDeps);
    expect(fingerprint()).toBe(before);
  });

  it("deletes only the refs when the checkout moved nothing", async () => {
    const id = randomUUID();
    const { before, outcome } = pushed(id);

    await undoGitCarry(outcome, undoDeps);

    expect(fingerprint()).toBe(before);
    expect(refsLeft(id)).toBe("");
    await undoGitCarry(outcome, undoDeps);
    expect(fingerprint()).toBe(before);
  });

  it("finishes a call that was interrupted before all its refs were deleted", async () => {
    const id = randomUUID();
    const { before, outcome } = pushed(id);
    git(["checkout", "-q", "-B", "main", outcome.carried.head, "--"]);
    git(["update-ref", "-d", outcome.refs[0] ?? ""]);

    await undoGitCarry(outcome, undoDeps);

    expect(fingerprint()).toBe(before);
    expect(refsLeft(id)).toBe("");
  });

  it("undoes a read-tree that failed after HEAD and the branch were already at the previous head", async () => {
    const id = randomUUID();
    const { before, outcome } = pushed(id);
    const previousHead = outcome.previousHead ?? "";
    git(["update-ref", outcome.refs[0] ?? "", previousHead]);
    const failed = { ...outcome, step: "read-tree of the working tree", carried: { ...outcome.carried, head: previousHead } };
    dirtyTheCheckout();

    await undoGitCarry(failed, undoDeps);

    expect(fingerprint()).toBe(before);
    expect(refsLeft(id)).toBe("");
    await undoGitCarry(failed, undoDeps);
    expect(fingerprint()).toBe(before);
  });

  it("finishes an undo that put HEAD and the branch back but stopped before the read-tree", async () => {
    const id = randomUUID();
    const { before, outcome } = pushed(id);
    dirtyTheCheckout();

    await undoGitCarry(outcome, undoDeps);

    expect(fingerprint()).toBe(before);
    expect(refsLeft(id)).toBe("");
    await undoGitCarry(outcome, undoDeps);
    expect(fingerprint()).toBe(before);
  });

  it("refuses an id that is not a UUID and a ref outside the carry's namespace, changing nothing", async () => {
    const id = randomUUID();
    const { outcome } = pushed(id);
    git(["checkout", "-q", "-B", "main", outcome.carried.head, "--"]);
    const moved = fingerprint();

    await expect(undoGitCarry({ ...outcome, id: "../../heads/main" }, undoDeps)).rejects.toThrow(/uuid/i);
    await expect(undoGitCarry({ ...outcome, refs: [...outcome.refs, "refs/heads/main"] }, undoDeps)).rejects.toThrow(
      /refs\/hc-teleport/,
    );

    expect(fingerprint()).toBe(moved);
    expect(refsLeft(id)).not.toBe("");
  });
});
