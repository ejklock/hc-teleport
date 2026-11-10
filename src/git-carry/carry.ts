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
type CarriedState = {
  machine: string;
  /** The repository's top level, the checkout that was worked on; the same path on both machines. */
  cwd: string;
  /** The refs written on the destination, all under `refs/hc-teleport/<id>/`. */
  refs: string[];
  /** What the destination checkout was on before; absent when detached or without a commit. */
  previousBranch?: string;
  previousHead?: string;
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

const idSchema = z.uuid();

const refNames = (id: string): { head: string; staged: string; worktree: string } => ({
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

  const state: CarriedState = { machine, cwd: root, refs: Object.values(refs), ...previous };
  const failure = await dest.restore(snapshot, refs);
  return failure === undefined ? { status: "carried", ...state } : { status: "failed", ...failure, ...state };
}

/** Deletes the refs a carry wrote on the destination and no other, after it carried or failed; deleting what is already gone is not an error. */
export async function removeCarriedRefs(
  carried: Extract<GitCarryOutcome, { status: "carried" | "failed" }>,
  deps: Pick<GitCarryDeps, "hc">,
): Promise<void> {
  const dest = new Destination(deps.hc, carried.machine, carried.cwd);
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

  async deleteRef(ref: string): Promise<void> {
    this.#ok(await this.#git(["update-ref", "-d", ref]), `delete ${ref}`);
  }

  #git(args: readonly string[]): Promise<HcExecResult> {
    return this.#hc.exec(["git", "-C", this.#cwd, ...args], { on: this.#machine, timeout: DEST_TIMEOUT_S });
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
