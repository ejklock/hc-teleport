import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carryGit, type GitCarryDeps } from "../../src/git-carry/carry.ts";
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
