import { z } from "zod";
import type { Hc, HcExecResult } from "../platform/hc.ts";
import type { Runner } from "../platform/process.ts";
import { snapshotGit, type GitSnapshot, type SourceRefusal } from "./snapshot.ts";

export type GitCarryDeps = { hc: Pick<Hc, "exec" | "machines">; run: Runner };

export type GitCarryRequest = {
  /** An absolute path in the checkout, the same on both machines: the top level or a folder below it. */
  cwd: string;
  machine: string;
  /** The session id; it names the temporary refs. */
  id: string;
};

export type GitCarryRefusal = SourceRefusal | "machine_without_ssh" | "dest_repo_missing" | "dest_dirty" | "dest_diverged";

/** What a carry leaves on the destination once its refs are pushed. */
export type CarriedState = {
  machine: string;
  /** The session id the refs are named by. */
  id: string;
  /** The repository's top level, the checkout that was worked on; the same path on both machines. */
  cwd: string;
  /** The refs written on the destination, all under `refs/hc-teleport/<id>/`. */
  refs: string[];
  /** What the destination checkout was on before; absent when detached or without a commit. */
  previousBranch?: string;
  previousHead?: string;
  /** The branch the carry moved or created on the destination. */
  branch: string;
  /** Where that branch stood on the destination before the carry; absent when the carry created it. */
  branchPreviousHead?: string;
  /** The commits the source was carried as: its HEAD, its index and its working tree. */
  carried: { head: string; staged: string; worktree: string };
};

export type GitCarryOutcome =
  | ({ status: "carried" } & CarriedState)
  | ({
      /** A destination step failed after the refs were pushed: the refs stay, and the fields above are what a rollback needs. */
      status: "failed";
      /** The step that failed, such as "checkout". */
      step: string;
      /** What git or hc said. */
      detail: string;
    } & CarriedState)
  | { status: "refused"; reason: GitCarryRefusal };

const PUSH_TIMEOUT_MS = 600_000;
const DEST_TIMEOUT_S = 300;
const CLEAN_BATCH = 100;

const idSchema = z.uuid();

export const refNames = (id: string): { head: string; staged: string; worktree: string } => ({
  head: `refs/hc-teleport/${id}/head`,
  staged: `refs/hc-teleport/${id}/staged`,
  worktree: `refs/hc-teleport/${id}/worktree`,
});

/**
 * Makes the checkout at `cwd` on `machine` match the one here: commits, staged, unstaged and untracked changes, binary
 * and mode changes. Everything is checked before the first push; a refusal writes nothing on either side. Ignored files
 * stay behind. The source checkout, its index and its branch are not changed. The checkout is the whole repository
 * holding `cwd`, which the destination must hold at the same top level path. A destination step that fails after
 * the push resolves as `failed`, never throws: the refs stay and the outcome carries the destination's previous branch
 * and HEAD. This session's refs from an earlier attempt are overwritten.
 */
export async function carryGit(request: GitCarryRequest, deps: GitCarryDeps): Promise<GitCarryOutcome> {
  const id = idSchema.parse(request.id);
  const { cwd, machine } = request;
  if (!cwd.startsWith("/")) throw new Error(`the checkout path must be absolute, got ${cwd}`);

  const found = (await deps.hc.machines()).find((candidate) => candidate.name === machine);
  if (found === undefined) throw new Error(`hc knows no machine named ${machine}`);
  if (found.sshTarget === undefined) return { status: "refused", reason: "machine_without_ssh" };

  const taken = await snapshotGit(cwd, deps.run);
  if (!taken.ok) return { status: "refused", reason: taken.reason };
  const { snapshot } = taken;
  const { root } = snapshot;

  const dest = new Destination(deps.hc, machine, root);
  const refusal = await destinationRefusal(dest, deps.run, cwd, snapshot);
  if (refusal !== undefined) return { status: "refused", reason: refusal };

  const previous = await dest.previousState();
  const branchPreviousHead = await dest.branchHead(snapshot.branch);
  const refs = refNames(id);
  // Forced: nothing but this carry writes under this session's id, and an earlier attempt may have left its refs.
  const pushed = [
    `+${snapshot.head}:${refs.head}`,
    `+${snapshot.staged}:${refs.staged}`,
    `+${snapshot.worktree}:${refs.worktree}`,
  ];
  await deps.run("git", ["-C", root, "push", "--atomic", "--quiet", "--", `${found.sshTarget}:${root}`, ...pushed], {
    timeoutMs: PUSH_TIMEOUT_MS,
  });

  const state: CarriedState = {
    machine,
    id,
    cwd: root,
    refs: Object.values(refs),
    ...previous,
    branch: snapshot.branch,
    ...(branchPreviousHead === undefined ? {} : { branchPreviousHead }),
    carried: { head: snapshot.head, staged: snapshot.staged, worktree: snapshot.worktree },
  };
  const failure = await dest.restore(snapshot, refs);
  return failure === undefined ? { status: "carried", ...state } : { status: "failed", ...failure, ...state };
}

/**
 * Puts the destination checkout back as it was before the carry: the branch it was on (unborn when it had no commit) or the detached commit, the
 * carried branch where it stood or gone when the carry created it, the index and tracked files at that commit (with no
 * commit, every tracked file is removed, ignored or not), the untracked files the carry created removed, and the carry's refs deleted. What to rewind is decided from what the
 * destination holds now, never from the step that failed: a step reported as failed may still have run. A destination
 * already where it was before the carry only loses the refs. Ignored files the carry did not track are never touched. Edits made on the
 * destination after the carry are lost with the carry's own. Calling it again, once the refs are gone, changes nothing.
 * Refuses an id that is not a UUID or a ref outside `refs/hc-teleport/<id>/`, changing nothing.
 */
export async function undoGitCarry(
  carried: Extract<GitCarryOutcome, { status: "carried" | "failed" }>,
  deps: Pick<GitCarryDeps, "hc">,
): Promise<void> {
  const id = idSchema.parse(carried.id);
  const namespace = `refs/hc-teleport/${id}/`;
  const outside = carried.refs.find((ref) => !ref.startsWith(namespace) || ref.includes(".."));
  if (outside !== undefined) throw new Error(`refusing to delete ${outside}: it is not under ${namespace}`);
  const dest = new Destination(deps.hc, carried.machine, carried.cwd);
  if (!(await dest.hasAnyRef(carried.refs))) return;
  if (await dest.movedFrom(carried)) await dest.rewind(carried);
  for (const ref of carried.refs) await dest.deleteRef(ref);
}

/** Why the destination cannot take the carry, checked in the order a person would fix them; undefined when it can. */
async function destinationRefusal(
  dest: Destination,
  run: Runner,
  cwd: string,
  snapshot: GitSnapshot,
): Promise<GitCarryRefusal | undefined> {
  if (!(await dest.hasTopLevel(cwd))) return "dest_repo_missing";
  if (await dest.isDirty()) return "dest_dirty";
  if (await hasDiverged(dest, run, snapshot.root, snapshot)) return "dest_diverged";
  return undefined;
}

/** The destination has a commit on the source's branch that the source does not hold. */
async function hasDiverged(dest: Destination, run: Runner, cwd: string, snapshot: GitSnapshot): Promise<boolean> {
  const theirs = await dest.branchHead(snapshot.branch);
  if (theirs === undefined) return false;
  try {
    await run("git", ["-C", cwd, "cat-file", "-e", `${theirs}^{commit}`]);
  } catch {
    return true;
  }
  const ahead = await run("git", ["-C", cwd, "rev-list", "-n", "1", theirs, "--not", snapshot.head]);
  return ahead.trim() !== "";
}

/** One checkout on one machine, driven with git plumbing through hc; no shell on the way. */
class Destination {
  readonly #hc: GitCarryDeps["hc"];
  readonly #machine: string;
  readonly #cwd: string;

  constructor(hc: GitCarryDeps["hc"], machine: string, cwd: string) {
    this.#hc = hc;
    this.#machine = machine;
    this.#cwd = cwd;
  }

  /** `folder` is inside a work tree whose top level is this checkout's path; another repository's top level is no match. */
  async hasTopLevel(folder: string): Promise<boolean> {
    const result = await this.#hc.exec(["git", "-C", folder, "rev-parse", "--show-toplevel"], {
      on: this.#machine,
      timeout: DEST_TIMEOUT_S,
    });
    return result.code === 0 && result.stdout.trim() === this.#cwd;
  }

  async isDirty(): Promise<boolean> {
    const status = await this.#git(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    return this.#ok(status, "status").stdout !== "";
  }

  /** What the checkout is on now, for a rollback; each field is absent when detached or without a commit. */
  async previousState(): Promise<{ previousBranch?: string; previousHead?: string }> {
    const previousBranch = await this.#optional(["symbolic-ref", "-q", "--short", "HEAD"]);
    const previousHead = await this.#optional(["rev-parse", "--verify", "-q", "HEAD"]);
    return {
      ...(previousBranch === undefined ? {} : { previousBranch }),
      ...(previousHead === undefined ? {} : { previousHead }),
    };
  }

  async branchHead(branch: string): Promise<string | undefined> {
    return this.#optional(["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  }

  /**
   * Branch at the carried HEAD, then the working tree, then the index, leaving untracked files untracked. Resolves with
   * the first step that failed, whether git exited non-zero or hc could not run it, and runs no step after it.
   */
  async restore(snapshot: GitSnapshot, refs: ReturnType<typeof refNames>): Promise<{ step: string; detail: string } | undefined> {
    const steps: [string, string[]][] = [
      ["checkout", ["checkout", "-q", "-B", snapshot.branch, refs.head, "--"]],
      ["read-tree of the working tree", ["read-tree", "-u", "--reset", refs.worktree]],
      ["read-tree of the index", ["read-tree", refs.staged]],
    ];
    for (const [step, args] of steps) {
      try {
        const result = await this.#git(args);
        if (result.code !== 0) return { step, detail: `exit ${result.code}: ${result.stderr.trim()}` };
      } catch (error) {
        return { step, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    return undefined;
  }

  async hasAnyRef(refs: readonly string[]): Promise<boolean> {
    for (const ref of refs) {
      if ((await this.#optional(["rev-parse", "--verify", "-q", ref])) !== undefined) return true;
    }
    return false;
  }

  /** The checkout is not where the carry found it: HEAD, the carried branch, or the index, tracked or untracked files differ. */
  async movedFrom(carried: CarriedState): Promise<boolean> {
    const { previousBranch, previousHead, branch, branchPreviousHead } = carried;
    const now = await this.previousState();
    return (
      now.previousBranch !== previousBranch ||
      now.previousHead !== previousHead ||
      (await this.branchHead(branch)) !== branchPreviousHead ||
      (await this.isDirty())
    );
  }

  /** Moves HEAD and the carried branch back, then the index and tracked files to HEAD, then removes what the carry left untracked. */
  async rewind(carried: CarriedState): Promise<void> {
    const { previousBranch, previousHead, branch, branchPreviousHead } = carried;
    if (previousBranch !== undefined) {
      this.#ok(await this.#git(["symbolic-ref", "HEAD", `refs/heads/${previousBranch}`]), "point HEAD at its branch");
    } else if (previousHead !== undefined) {
      this.#ok(await this.#git(["update-ref", "--no-deref", "HEAD", previousHead]), "detach HEAD");
    } else {
      throw new Error(`cannot undo the carry on ${this.#machine} at ${this.#cwd}: it recorded neither a branch nor a commit`);
    }
    if (branchPreviousHead === undefined) {
      this.#ok(await this.#git(["update-ref", "-d", `refs/heads/${branch}`]), `delete branch ${branch}`);
    } else {
      this.#ok(await this.#git(["update-ref", `refs/heads/${branch}`, branchPreviousHead]), `restore branch ${branch}`);
    }
    if (previousHead === undefined) {
      await this.#removeTracked();
    } else {
      this.#ok(await this.#git(["read-tree", "-u", "--reset", previousHead]), "read-tree of the previous commit");
    }
    await this.#removeUntracked();
  }

  /**
   * The checkout had no commit and was clean, so its index was empty and every tracked path now is the carry's, ignored or not.
   * Each is dropped from the index and the disk together; `--exclude-standard` listing would miss the ignored ones.
   */
  async #removeTracked(): Promise<void> {
    const listed = this.#ok(await this.#git(["ls-files", "-z"]), "list tracked files");
    const paths = listed.stdout.split("\0").filter((path) => path !== "");
    for (let from = 0; from < paths.length; from += CLEAN_BATCH) {
      const batch = paths.slice(from, from + CLEAN_BATCH);
      this.#ok(await this.#git(["rm", "-r", "-f", "-q", "--", ...batch], ["--literal-pathspecs"]), "remove tracked files");
    }
  }

  /** The checkout was clean before the carry, so every untracked file now is the carry's. Removed one by one, so folders that were already there stay. */
  async #removeUntracked(): Promise<void> {
    const listed = this.#ok(await this.#git(["ls-files", "-z", "--others", "--exclude-standard"]), "list untracked files");
    const paths = listed.stdout.split("\0").filter((path) => path !== "");
    for (let from = 0; from < paths.length; from += CLEAN_BATCH) {
      const batch = paths.slice(from, from + CLEAN_BATCH);
      this.#ok(await this.#git(["clean", "-f", "-d", "-q", "--", ...batch], ["--literal-pathspecs"]), "clean untracked files");
    }
  }

  async deleteRef(ref: string): Promise<void> {
    this.#ok(await this.#git(["update-ref", "-d", ref]), `delete ${ref}`);
  }

  #git(args: readonly string[], options: readonly string[] = []): Promise<HcExecResult> {
    return this.#hc.exec(["git", "-C", this.#cwd, ...options, ...args], { on: this.#machine, timeout: DEST_TIMEOUT_S });
  }

  async #optional(args: readonly string[]): Promise<string | undefined> {
    const result = await this.#git(args);
    const text = result.stdout.trim();
    return result.code === 0 && text !== "" ? text : undefined;
  }

  #ok(result: HcExecResult, label: string): HcExecResult {
    if (result.code !== 0) {
      throw new Error(`git ${label} failed on ${this.#machine} at ${this.#cwd} (exit ${result.code}): ${result.stderr.trim()}`);
    }
    return result;
  }
}
