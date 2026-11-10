import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bed, BED_PROJECT_ROOT, BED_START_TIMEOUT_MS, REPO_MOUNT, type Side } from "./bed.ts";

/** Runs one export of the git carry on source, through the real hc and ssh, and prints its outcome as JSON. */
const DRIVER = `
import { readFileSync } from "node:fs";
import { Hc } from "${REPO_MOUNT}/src/platform/hc.ts";
import { processRunner } from "${REPO_MOUNT}/src/platform/process.ts";
import * as carry from "${REPO_MOUNT}/src/git-carry/index.ts";
const { fn, args, viaAnotherCore } = JSON.parse(readFileSync(0, "utf8"));
const real = new Hc();
// The bed has no machine hc reaches through another core, so one is shown the way hc reports it: with no ssh target.
const hc = viaAnotherCore
  ? {
      exec: (...a) => real.exec(...a),
      machines: async () => (await real.machines()).map(({ sshTarget, ...rest }) => rest),
    }
  : real;
const deps = { hc, run: processRunner() };
try {
  const value = await carry[fn](...args, deps);
  process.stdout.write(JSON.stringify({ ok: value ?? null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ failed: String(error?.message ?? error) }));
}
`;

const GIT_USER = ["-c", "user.name=bed", "-c", "user.email=bed@example.test"];

type Carried = {
  status: "carried";
  machine: string;
  id: string;
  cwd: string;
  refs: string[];
  previousBranch?: string;
  previousHead?: string;
  branch: string;
  branchPreviousHead?: string;
};
type Failed = Omit<Carried, "status"> & { status: "failed"; step: string; detail: string };
type Refused = { status: "refused"; reason: string };

describe("git carry from source to dest through the real hc and ssh", () => {
  let bed: Bed;
  let sequence = 0;

  beforeAll(async () => {
    bed = await Bed.start();
  }, BED_START_TIMEOUT_MS);

  afterAll(async () => {
    await bed?.stop();
  });

  async function sh(side: Side, cwd: string, script: string): Promise<string> {
    const ran = await bed.run(side, ["sh", "-c", script], { cwd });
    if (ran.code !== 0) throw new Error(`${side}: ${script}\n${ran.stderr}`);
    return ran.stdout;
  }

  /** A repository at one path on both machines, both at the same first commit on main. */
  async function twinRepositories(): Promise<string> {
    sequence += 1;
    const path = `${BED_PROJECT_ROOT}/carry-${sequence}`;
    await sh("source", BED_PROJECT_ROOT, `git init -q -b main ${path}`);
    await sh(
      "source",
      path,
      `printf 'ignored.log\\n' > .gitignore && printf 'one\\n' > tracked.txt && printf 'gone\\n' > gone-staged.txt && printf 'gone\\n' > gone-unstaged.txt && printf '#!/bin/sh\\n' > run.sh && git add -A && git ${GIT_USER.join(" ")} commit -q -m first`,
    );
    await sh("dest", BED_PROJECT_ROOT, `git init -q -b main ${path}`);
    await sh("source", path, `git push -q dest:${path} HEAD:refs/heads/seed`);
    await sh("dest", path, "git checkout -q -B main seed && git branch -q -D seed");
    return path;
  }

  async function commitOnSource(path: string, file: string, text: string): Promise<void> {
    await sh("source", path, `printf '${text}\\n' > ${file} && git add ${file} && git ${GIT_USER.join(" ")} commit -q -m ${file}`);
  }

  async function call(fn: string, ...args: unknown[]): Promise<unknown> {
    return callWith({}, fn, ...args);
  }

  async function callWith(extra: { viaAnotherCore?: boolean }, fn: string, ...args: unknown[]): Promise<unknown> {
    const ran = await bed.run("source", ["node", "--input-type=module", "-e", DRIVER], {
      stdin: JSON.stringify({ fn, args, ...extra }),
      timeoutMs: 110_000,
    });
    expect(ran.stderr).toBe("");
    const outcome = JSON.parse(ran.stdout) as { ok?: unknown; failed?: string };
    if (outcome.failed !== undefined) throw new Error(outcome.failed);
    return outcome.ok;
  }

  const carryGit = (cwd: string, id: string, extra: { viaAnotherCore?: boolean } = {}): Promise<Carried | Failed | Refused> =>
    callWith(extra, "carryGit", { cwd, machine: "dest", id }) as Promise<Carried | Refused>;

  /** What a person would compare to say two checkouts are the same: branch, HEAD, both diffs, untracked files. */
  function observe(side: Side, path: string): Promise<string> {
    return sh(
      side,
      path,
      [
        "git symbolic-ref --short HEAD",
        "git rev-parse HEAD",
        "git diff --cached --binary --full-index",
        "git diff --binary --full-index",
        "git ls-files -z --others --exclude-standard | xargs -0 -r sha1sum --",
        // Only the executable bit is compared: the other permission bits follow each machine's umask.
        `git ls-files -z --others --exclude-standard | xargs -0 -r sh -c 'for f; do if test -L "$f"; then echo "link $f"; elif test -x "$f"; then echo "exec $f"; else echo "file $f"; fi; done' --`,
      ].join("; echo ---; "),
    );
  }

  /** Everything a refused carry must leave alone on a checkout. */
  function untouched(side: Side, path: string): Promise<string> {
    return sh(
      side,
      path,
      [
        "git for-each-ref",
        "git rev-parse HEAD",
        "sha1sum .git/index",
        "git --no-optional-locks status --porcelain=v2 -z --untracked-files=all | od -c",
        "git stash list",
      ].join("; echo ---; "),
    );
  }

  const carriedRefs = (path: string, id = ""): Promise<string> =>
    sh("dest", path, `git for-each-ref --format='%(refname)' refs/hc-teleport/${id}`);

  async function expectCarried(path: string, id: string, cwd = path): Promise<Carried> {
    const before = await untouched("source", path);
    const outcome = await carryGit(cwd, id);
    expect(outcome.status).toBe("carried");
    const carried = outcome as Carried;
    expect(carried.cwd).toBe(path);
    expect(await untouched("source", path)).toBe(before);
    expect(await observe("dest", path)).toBe(await observe("source", path));
    expect((await carriedRefs(path, `${id}/`)).trim().split("\n").sort()).toEqual(
      [`refs/hc-teleport/${id}/head`, `refs/hc-teleport/${id}/staged`, `refs/hc-teleport/${id}/worktree`],
    );
    expect([...carried.refs].sort()).toEqual([
      `refs/hc-teleport/${id}/head`,
      `refs/hc-teleport/${id}/staged`,
      `refs/hc-teleport/${id}/worktree`,
    ]);
    return carried;
  }

  it("carries a destination that lacks the source's latest commits", async () => {
    const path = await twinRepositories();
    const previous = (await sh("dest", path, "git rev-parse HEAD")).trim();
    await commitOnSource(path, "second.txt", "two");
    await commitOnSource(path, "third.txt", "three");
    const carried = await expectCarried(path, randomUUID());
    expect(carried.previousBranch).toBe("main");
    expect(carried.previousHead).toBe(previous);
  });

  it("carries onto a destination on another branch with a clean tree", async () => {
    const path = await twinRepositories();
    await sh("dest", path, "git checkout -q -b other");
    const previous = (await sh("dest", path, "git rev-parse HEAD")).trim();
    await sh("source", path, "printf 'edit\\n' > tracked.txt");
    const carried = await expectCarried(path, randomUUID());
    expect(carried.previousBranch).toBe("other");
    expect(carried.previousHead).toBe(previous);
    expect((await sh("dest", path, "git branch --list main")).trim()).toContain("main");
  });

  it("carries a branch the destination does not have yet", async () => {
    const path = await twinRepositories();
    await sh("source", path, "git checkout -q -b feature/new");
    await commitOnSource(path, "feature.txt", "feature");
    const carried = await expectCarried(path, randomUUID());
    expect(carried.previousBranch).toBe("main");
    expect((await sh("dest", path, "git rev-parse --abbrev-ref HEAD")).trim()).toBe("feature/new");
  });

  it("carries every kind of change in one go", async () => {
    const path = await twinRepositories();
    await commitOnSource(path, "second.txt", "two");
    await sh(
      "source",
      path,
      [
        "printf 'staged\\n' > tracked.txt",
        "git add tracked.txt",
        "printf 'staged then edited\\n' > tracked.txt",
        "git rm -q gone-staged.txt",
        "rm gone-unstaged.txt",
        "printf 'fresh\\n' > fresh.txt",
        "printf 'noise\\n' > ignored.log",
        "printf '\\000\\377\\001\\376\\000\\r\\n' > blob.bin",
        "git add blob.bin",
        "printf '\\000\\001\\002' >> blob.bin",
        "chmod 755 run.sh",
        "chmod 755 fresh.txt",
        "ln -s tracked.txt link",
        "mkdir 'dir with space'",
        "printf 'olá\\n' > 'dir with space/ação ü.txt'",
      ].join(" && "),
    );
    await expectCarried(path, randomUUID());
    const left = await sh("dest", path, "test ! -e ignored.log && test ! -e gone-unstaged.txt && test -L link && echo ok");
    expect(left.trim()).toBe("ok");
    expect((await sh("dest", path, "git diff --cached --name-status")).split("\n").sort()).toContain("D\tgone-staged.txt");
  });

  /** The destination's own view of a checkout: what a failed carry must leave as it was. */
  const destCheckout = (path: string): Promise<string> => observe("dest", path);

  /** Dest on branch other with its index locked by another git process: no status check sees it, and no checkout can run. */
  async function destWithLockedIndex(path: string): Promise<void> {
    await sh("dest", path, "git checkout -q -b other && touch .git/index.lock");
  }

  describe("fails after the push", () => {
    it("reports the step, the refs and the previous branch and head when the checkout cannot run, leaving the checkout as it was", async () => {
      const path = await twinRepositories();
      await destWithLockedIndex(path);
      const previous = (await sh("dest", path, "git rev-parse HEAD")).trim();
      await commitOnSource(path, "second.txt", "two");
      const before = await destCheckout(path);

      const outcome = (await carryGit(path, randomUUID())) as Failed;

      expect(outcome).toMatchObject({ status: "failed", step: "checkout", machine: "dest", cwd: path, previousBranch: "other", previousHead: previous });
      expect(outcome.detail).toMatch(/index\.lock/);
      expect([...outcome.refs].sort()).toEqual(
        (await carriedRefs(path)).trim().split("\n").sort(),
      );
      expect(outcome.refs).toHaveLength(3);
      expect(await destCheckout(path)).toBe(before);

      await call("undoGitCarry", outcome);
      expect(await carriedRefs(path)).toBe("");
    });

    it("reports the checkout's previous branch and head when a later step fails after the checkout moved the branch", async () => {
      const path = await twinRepositories();
      const previous = (await sh("dest", path, "git rev-parse HEAD")).trim();
      await commitOnSource(path, "second.txt", "two");
      // A read-only folder on dest, empty so that git sees no change, where the source has an untracked file.
      await sh("source", path, "mkdir locked && printf 'new\\n' > locked/new.txt");
      await sh("dest", path, "mkdir locked && chmod 555 locked");

      const outcome = (await carryGit(path, randomUUID())) as Failed;

      expect(outcome).toMatchObject({ status: "failed", step: "read-tree of the working tree", machine: "dest", cwd: path, previousBranch: "main", previousHead: previous });
      expect(outcome.refs).toHaveLength(3);
      expect(outcome.detail).not.toBe("");
      expect((await sh("dest", path, "git rev-parse HEAD")).trim()).not.toBe(previous);
      await sh("dest", path, "chmod 755 locked");

      await call("undoGitCarry", outcome);
      expect(await carriedRefs(path)).toBe("");
    });

    it("still throws when the failure comes before the push", async () => {
      const path = await twinRepositories();
      await expect(carryGit(path, "not-a-uuid")).rejects.toThrow(/uuid/i);
    });
  });

  describe("carries again", () => {
    it("carries again with a session id whose refs an earlier attempt left, and leaves other ids alone", async () => {
      const path = await twinRepositories();
      await destWithLockedIndex(path);
      await commitOnSource(path, "second.txt", "two");
      const id = randomUUID();
      const otherId = randomUUID();
      await sh("dest", path, `git update-ref refs/hc-teleport/${otherId}/head HEAD`);
      const otherBefore = (await sh("dest", path, `git rev-parse refs/hc-teleport/${otherId}/head`)).trim();

      const first = await carryGit(path, id);
      expect(first.status).toBe("failed");
      const firstWorktree = (await sh("dest", path, `git rev-parse refs/hc-teleport/${id}/worktree`)).trim();

      // Dest is put back to clean, the source moves on: the new commits do not descend from the old ones.
      await sh("dest", path, "rm .git/index.lock");
      await sh("source", path, "printf 'later\\n' > tracked.txt");
      const carried = await expectCarried(path, id);

      expect(carried.status).toBe("carried");
      const worktree = (await sh("dest", path, `git rev-parse refs/hc-teleport/${id}/worktree`)).trim();
      expect(worktree).not.toBe(firstWorktree);
      expect((await sh("dest", path, `git rev-parse refs/hc-teleport/${id}/head`)).trim()).toBe((await sh("source", path, "git rev-parse HEAD")).trim());
      expect((await sh("dest", path, `git rev-parse refs/hc-teleport/${otherId}/head`)).trim()).toBe(otherBefore);
    });
  });

  describe("from a subdirectory", () => {
    /** A twin whose source has a tracked file below packages/api, and whose dest has that folder, empty. */
    async function twinWithSubdirectory(): Promise<{ path: string; sub: string }> {
      const path = await twinRepositories();
      const sub = `${path}/packages/api`;
      await sh("source", path, "mkdir -p packages/api");
      await commitOnSource(path, "packages/api/index.txt", "api");
      await sh("dest", path, "mkdir -p packages/api");
      return { path, sub };
    }

    it("carries the whole repository for a cwd below the top level, including changes outside it, and names the top level", async () => {
      const { path, sub } = await twinWithSubdirectory();
      await commitOnSource(path, "outside.txt", "outside");
      await sh("source", path, "printf 'edit\\n' > tracked.txt && printf 'fresh\\n' > fresh.txt && printf 'inner\\n' > packages/api/index.txt");
      const carried = await expectCarried(path, randomUUID(), sub);
      expect(carried.cwd).toBe(path);
    });

    it("carries for a cwd with a trailing slash", async () => {
      const { path, sub } = await twinWithSubdirectory();
      await sh("source", path, "printf 'edit\\n' > tracked.txt");
      await expectCarried(path, randomUUID(), `${sub}/`);
    });

    it("carries through a symlinked cwd when both machines have it, and refuses when dest has no such link", async () => {
      const { path, sub } = await twinWithSubdirectory();
      sequence += 1;
      const link = `${BED_PROJECT_ROOT}/link-${sequence}`;
      await sh("source", BED_PROJECT_ROOT, `ln -s ${sub} ${link}`);
      await sh("source", path, "printf 'edit\\n' > tracked.txt");
      const destBefore = await untouched("dest", path);
      expect(await carryGit(link, randomUUID())).toEqual({ status: "refused", reason: "dest_repo_missing" });
      expect(await untouched("dest", path)).toBe(destBefore);

      await sh("dest", BED_PROJECT_ROOT, `ln -s ${sub} ${link}`);
      await expectCarried(path, randomUUID(), link);
    });

    it("refuses a nested folder that is no repository on dest when the top level is absent there", async () => {
      const { path, sub } = await twinWithSubdirectory();
      await sh("dest", BED_PROJECT_ROOT, `rm -rf ${path} && mkdir -p ${sub}`);
      const outcome = await carryGit(sub, randomUUID());
      expect(outcome).toEqual({ status: "refused", reason: "dest_repo_missing" });
    });

    it("refuses a cwd that sits in another repository on dest", async () => {
      const { path, sub } = await twinWithSubdirectory();
      await sh("dest", BED_PROJECT_ROOT, `rm -rf ${sub} && git init -q ${sub}`);
      expect(await carryGit(sub, randomUUID())).toEqual({ status: "refused", reason: "dest_repo_missing" });
      expect(await sh("dest", path, "git for-each-ref refs/hc-teleport")).toBe("");
    });

    it("throws for a cwd that is in no repository on the source", async () => {
      sequence += 1;
      const outside = `${BED_PROJECT_ROOT}/outside-${sequence}`;
      await sh("source", BED_PROJECT_ROOT, `mkdir ${outside}`);
      await expect(carryGit(outside, randomUUID())).rejects.toThrow(/not a git repository/);
    });
  });

  describe("refuses", () => {
    async function expectRefused(path: string, reason: string, extra: { viaAnotherCore?: boolean } = {}, cwd = path): Promise<void> {
      const sourceBefore = await untouched("source", path);
      const destBefore = await untouched("dest", path).catch(() => "no checkout");
      const outcome = await carryGit(cwd, randomUUID(), extra);
      expect(outcome).toEqual({ status: "refused", reason });
      expect(await untouched("source", path)).toBe(sourceBefore);
      expect(await untouched("dest", path).catch(() => "no checkout")).toBe(destBefore);
      if (destBefore !== "no checkout") expect(await carriedRefs(path)).toBe("");
    }

    it("refuses a destination branch holding a commit the source lacks", async () => {
      const path = await twinRepositories();
      await sh("dest", path, `printf 'theirs\\n' > theirs.txt && git add theirs.txt && git ${GIT_USER.join(" ")} commit -q -m theirs`);
      await commitOnSource(path, "mine.txt", "mine");
      await expectRefused(path, "dest_diverged");
    });

    it("refuses a destination with a staged change", async () => {
      const path = await twinRepositories();
      await sh("dest", path, "printf 'x\\n' > tracked.txt && git add tracked.txt");
      await expectRefused(path, "dest_dirty");
    });

    it("refuses a destination with an unstaged change", async () => {
      const path = await twinRepositories();
      await sh("dest", path, "printf 'x\\n' > tracked.txt");
      await expectRefused(path, "dest_dirty");
    });

    it("refuses a destination with an untracked file", async () => {
      const path = await twinRepositories();
      await sh("dest", path, "printf 'x\\n' > stray.txt");
      await expectRefused(path, "dest_dirty");
    });

    it("refuses a destination where the repository is absent", async () => {
      const path = await twinRepositories();
      await sh("dest", BED_PROJECT_ROOT, `rm -rf ${path}`);
      await expectRefused(path, "dest_repo_missing");
    });

    it("refuses a destination folder that holds no repository", async () => {
      const path = await twinRepositories();
      await sh("dest", path, "rm -rf .git");
      const outcome = await carryGit(path, randomUUID());
      expect(outcome).toEqual({ status: "refused", reason: "dest_repo_missing" });
    });

    it("refuses a machine hc reaches without ssh", async () => {
      const path = await twinRepositories();
      await expectRefused(path, "machine_without_ssh", { viaAnotherCore: true });
    });

    it("refuses a session id that is not a UUID before anything runs", async () => {
      const path = await twinRepositories();
      await expect(carryGit(path, "../../heads/main")).rejects.toThrow(/uuid/i);
    });
  });

  describe("undoes", () => {
    /** The destination as a person or git would compare it: refs, HEAD, index, status, and every ignored file's bytes. */
    function destFingerprint(path: string): Promise<string> {
      return sh(
        "dest",
        path,
        [
          "git for-each-ref",
          "git symbolic-ref -q HEAD || git rev-parse HEAD",
          "git ls-files -s",
          "git --no-optional-locks status --porcelain=v2 -z --untracked-files=all | od -c",
          "git ls-files -z --others --ignored --exclude-standard | xargs -0 -r sha1sum --",
        ].join("; echo ---; "),
      );
    }

    async function withIgnoredFile(path: string): Promise<void> {
      await sh("dest", path, "printf 'keep me\\n' > ignored.log");
    }

    async function expectUndone(path: string, outcome: Carried | Failed, before: string, id: string): Promise<void> {
      await call("undoGitCarry", outcome);
      expect(await destFingerprint(path)).toBe(before);
      expect(await carriedRefs(path, `${id}/`)).toBe("");
      await call("undoGitCarry", outcome);
      expect(await destFingerprint(path)).toBe(before);
    }

    async function sourceWithEveryChange(path: string): Promise<void> {
      await sh("source", path, "printf 'edit\\n' > tracked.txt && git rm -q gone-staged.txt && printf 'fresh\\n' > fresh.txt && mkdir -p sub/deeper && printf 'x\\n' > 'sub/deeper/é f.txt' && chmod 755 run.sh && ln -s tracked.txt link");
    }

    it("undoes a carry onto another branch when the carried branch did not exist there", async () => {
      const path = await twinRepositories();
      await sh("source", path, "git checkout -q -b feature/new");
      await commitOnSource(path, "feature.txt", "feature");
      await sourceWithEveryChange(path);
      await withIgnoredFile(path);
      const id = randomUUID();
      const otherId = randomUUID();
      await sh("dest", path, `git update-ref refs/hc-teleport/${otherId}/head HEAD`);
      const before = await destFingerprint(path);
      const outcome = await expectCarried(path, id);
      await expectUndone(path, outcome, before, id);
      expect(await carriedRefs(path, `${otherId}/`)).toContain(otherId);
    });

    it("undoes a fast-forward carry onto the carried branch at an older commit", async () => {
      const path = await twinRepositories();
      await commitOnSource(path, "second.txt", "two");
      await sourceWithEveryChange(path);
      await withIgnoredFile(path);
      const id = randomUUID();
      const before = await destFingerprint(path);
      const outcome = await expectCarried(path, id);
      await expectUndone(path, outcome, before, id);
    });

    it("undoes a carry onto another branch while the carried branch existed at an older commit", async () => {
      const path = await twinRepositories();
      await sh("dest", path, "git checkout -q -b other");
      await commitOnSource(path, "second.txt", "two");
      await sourceWithEveryChange(path);
      await withIgnoredFile(path);
      const id = randomUUID();
      const before = await destFingerprint(path);
      const outcome = await expectCarried(path, id);
      await expectUndone(path, outcome, before, id);
    });

    it("undoes a carry onto a detached destination", async () => {
      const path = await twinRepositories();
      await sh("dest", path, "git checkout -q --detach");
      await commitOnSource(path, "second.txt", "two");
      await sourceWithEveryChange(path);
      const id = randomUUID();
      const before = await destFingerprint(path);
      const outcome = await expectCarried(path, id);
      await expectUndone(path, outcome, before, id);
    });

    it("undoes a carry that failed in the working tree after the checkout moved the branch", async () => {
      const path = await twinRepositories();
      await commitOnSource(path, "second.txt", "two");
      await sh("source", path, "mkdir locked && printf 'new\\n' > locked/new.txt");
      await sh("dest", path, "mkdir locked && chmod 555 locked");
      await withIgnoredFile(path);
      const id = randomUUID();
      const before = await destFingerprint(path);
      const outcome = (await carryGit(path, id)) as Failed;
      expect(outcome.status).toBe("failed");
      await sh("dest", path, "chmod 755 locked");
      await expectUndone(path, outcome, before, id);
    });

    it("undoes a carry reported as failed at the checkout although the checkout ran", async () => {
      const path = await twinRepositories();
      await commitOnSource(path, "second.txt", "two");
      await sourceWithEveryChange(path);
      await withIgnoredFile(path);
      const id = randomUUID();
      const before = await destFingerprint(path);
      const outcome = await expectCarried(path, id);
      const dropped = { ...outcome, status: "failed" as const, step: "checkout", detail: "the connection dropped" };
      await expectUndone(path, dropped as unknown as Failed, before, id);
    });

    it("undoes a carry that failed at the checkout, leaving another process's index lock alone", async () => {
      const path = await twinRepositories();
      await destWithLockedIndex(path);
      await withIgnoredFile(path);
      await commitOnSource(path, "second.txt", "two");
      const id = randomUUID();
      const before = await destFingerprint(path);
      const outcome = (await carryGit(path, id)) as Failed;
      expect(outcome).toMatchObject({ status: "failed", step: "checkout" });
      await expectUndone(path, outcome, before, id);
      expect((await sh("dest", path, "test -e .git/index.lock && echo locked")).trim()).toBe("locked");
    });
  });

  describe("removes", () => {
    it("removes exactly the refs the carry wrote and nothing else, twice over", async () => {
      const path = await twinRepositories();
      await sh("source", path, "printf 'edit\\n' > tracked.txt");
      const otherId = randomUUID();
      await sh("dest", path, `git update-ref refs/hc-teleport/${otherId}/head HEAD && git update-ref refs/heads/keep HEAD`);
      const carried = await expectCarried(path, randomUUID());
      const before = (await sh("dest", path, "git for-each-ref --format='%(refname)'")).trim().split("\n");

      await call("undoGitCarry", carried);
      const after = (await sh("dest", path, "git for-each-ref --format='%(refname)'")).trim().split("\n");
      expect(after).toEqual(before.filter((ref) => !carried.refs.includes(ref)));
      expect(after).toContain(`refs/hc-teleport/${otherId}/head`);
      expect(after).toContain("refs/heads/keep");

      await call("undoGitCarry", carried);
      expect((await sh("dest", path, "git for-each-ref --format='%(refname)'")).trim().split("\n")).toEqual(after);
    });
  });
});
