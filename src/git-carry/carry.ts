import { z } from "zod";
import { HcError, type Hc } from "../platform/hc.ts";
import type { ExecResult } from "../platform/machine.ts";
import { ProcessError, type Runner } from "../platform/process.ts";
import { machineNamed, siteOf, snapshotGit, type GitMachine, type GitSite, type GitSnapshot, type SourceRefusal } from "./snapshot.ts";

export type GitCarryDeps = { hc: Pick<Hc, "exec" | "machines">; run: Runner };

export type GitCarryRequest = {
  /** An absolute path in the checkout, the same on both machines: the top level or a folder below it. */
  cwd: string;
  /** The destination: `local` for the Mac, else an hc machine's name. */
  machine: string;
  /** The machine holding the checkout carried; `local` when absent. Exactly one of the two ends is `local`. */
  source?: string;
  /** The session id; it names the temporary refs. */
  id: string;
};

export type GitCarryRefusal = SourceRefusal | "machine_without_ssh" | "dest_repo_missing" | "dest_dirty" | "dest_diverged";

/** What a carry leaves on the destination once its refs are pushed. */
export type CarriedState = {
  machine: string;
  /** The machine the checkout was carried from, `local` for the Mac; absent only on an outcome made before this field existed, which means `local`. */
  source?: string;
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

const LOCAL = "local";
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
 * Makes the checkout at `cwd` on `machine` match the one on the source machine: commits, staged, unstaged and
 * untracked changes, binary and mode changes. The Mac, named `local`, is one end and an hc machine the other; the
 * bytes always move by a git command the Mac runs, a push when the Mac is the source and a fetch when it is the
 * destination. A fetch asks for refs, so the source holds this session's refs only while it runs and loses them right
 * after, whether it succeeded or not. Everything is checked before the first byte moves; a refusal writes nothing on
 * either side. Ignored files stay behind. The source checkout, its index and its branch are not changed. The checkout
 * is the whole repository holding `cwd`, which the destination must hold at the same top level path. A destination
 * step that fails after the transfer resolves as `failed`, never throws: the refs stay and the outcome carries the
 * destination's previous branch and HEAD. This session's refs from an earlier attempt are overwritten. Rejects with a
 * `RangeError` when neither end or both ends are the Mac.
 */
export async function carryGit(request: GitCarryRequest, deps: GitCarryDeps): Promise<GitCarryOutcome> {
  const { id, cwd, machine, source, remote } = checkedEnds(request);
  const found = (await deps.hc.machines()).find((candidate) => candidate.name === remote);
  if (found === undefined) throw new Error(`hc knows no machine named ${remote}`);
  if (found.sshTarget === undefined) return { status: "refused", reason: "machine_without_ssh" };

  const from = source === LOCAL ? deps.run : machineNamed(source, deps.hc);
  const taken = await snapshotGit(cwd, from);
  if (!taken.ok) return { status: "refused", reason: taken.reason };
  const { snapshot } = taken;
  const { root } = snapshot;

  const dest = new Destination(machineNamed(machine, deps.hc), root);
  const site = siteOf(from);
  const refusal = await destinationRefusal(dest, site, cwd, snapshot);
  if (refusal !== undefined) return { status: "refused", reason: refusal };

  const previous = await dest.previousState();
  const branchPreviousHead = await dest.branchHead(snapshot.branch);
  const refs = refNames(id);
  const transfer = { run: deps.run, site, root, address: `${found.sshTarget}:${root}`, snapshot, refs };
  await (source === LOCAL ? push(transfer) : fetch(transfer));

  const state: CarriedState = {
    machine,
    source,
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

/** The request's id, path and ends, validated: exactly one end is the Mac, and `remote` names the other. */
function checkedEnds(request: GitCarryRequest): { id: string; cwd: string; machine: string; source: string; remote: string } {
  const id = idSchema.parse(request.id);
  const { cwd, machine } = request;
  const source = request.source ?? LOCAL;
  if (!cwd.startsWith("/")) throw new Error(`the checkout path must be absolute, got ${cwd}`);
  if ((machine === LOCAL) === (source === LOCAL)) {
    throw new RangeError(`a carry runs between the Mac (${LOCAL}) and one hc machine, got ${source} to ${machine}`);
  }
  return { id, cwd, machine, source, remote: machine === LOCAL ? source : machine };
}

type Transfer = {
  run: Runner;
  /** The source checkout, where the snapshot commits are stored. */
  site: GitSite;
  root: string;
  /** `<sshTarget>:<root>` of the remote end. */
  address: string;
  snapshot: GitSnapshot;
  refs: ReturnType<typeof refNames>;
};

/** Pushes the three snapshot commits by sha to this session's refs on the remote destination; forced, because nothing but this carry writes under the id and an earlier attempt may have left its refs. */
async function push({ run, root, address, snapshot, refs }: Transfer): Promise<void> {
  const pushed = [
    `+${snapshot.head}:${refs.head}`,
    `+${snapshot.staged}:${refs.staged}`,
    `+${snapshot.worktree}:${refs.worktree}`,
  ];
  await run("git", ["-C", root, "push", "--atomic", "--quiet", "--", address, ...pushed], { timeoutMs: PUSH_TIMEOUT_MS });
}

/** Tries to delete every ref even when one fails; resolves with an error naming each ref left, of the type of the first failure (hc's, git's or another), or undefined when none is. */
async function deleteRefs(site: GitSite, root: string, refs: readonly string[]): Promise<Error | undefined> {
  const left: string[] = [];
  let first: unknown;
  for (const ref of refs) {
    try {
      await site.git(root, ["update-ref", "-d", ref]);
    } catch (cause) {
      left.push(ref);
      first ??= cause;
    }
  }
  if (left.length === 0) return undefined;
  const suffix = `; left on the source: ${left.join(", ")}`;
  // A `ProcessError`'s message starts with its command, which its constructor puts there again.
  if (first instanceof ProcessError) return new ProcessError(first.command, `${first.message.slice(first.command.length + 2)}${suffix}`);
  return first instanceof HcError ? new HcError(`${first.message}${suffix}`) : new Error(`${first instanceof Error ? first.message : String(first)}${suffix}`);
}

/**
 * Fetches the three snapshot commits into the Mac's checkout from the remote source. A fetch names refs, so the
 * source gets them for the length of the fetch and loses them after it, whatever its outcome; a failure of the
 * fetch comes first, and a ref that could not be removed is reported when the fetch itself went well.
 */
async function fetch({ run, site, root, address, snapshot, refs }: Transfer): Promise<void> {
  const commits: [string, string][] = [
    [refs.head, snapshot.head],
    [refs.staged, snapshot.staged],
    [refs.worktree, snapshot.worktree],
  ];
  let failure: unknown;
  try {
    for (const [ref, commit] of commits) await site.git(root, ["update-ref", ref, commit]);
    await run(
      "git",
      ["-C", root, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", address, ...commits.map(([ref]) => `+${ref}:${ref}`)],
      { timeoutMs: PUSH_TIMEOUT_MS },
    );
  } catch (error) {
    failure = error;
  }
  const leftover = await deleteRefs(site, root, commits.map(([ref]) => ref));
  if (failure !== undefined) throw failure;
  if (leftover !== undefined) throw leftover;
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
  const dest = new Destination(machineNamed(carried.machine, deps.hc), carried.cwd);
  if (!(await dest.hasAnyRef(carried.refs))) return;
  if (await dest.movedFrom(carried)) await dest.rewind(carried);
  for (const ref of carried.refs) await dest.deleteRef(ref);
}

/** Why the destination cannot take the carry, checked in the order a person would fix them; undefined when it can. */
async function destinationRefusal(
  dest: Destination,
  source: GitSite,
  cwd: string,
  snapshot: GitSnapshot,
): Promise<GitCarryRefusal | undefined> {
  if (!(await dest.hasTopLevel(cwd))) return "dest_repo_missing";
  if (await dest.isDirty()) return "dest_dirty";
  if (await hasDiverged(dest, source, snapshot.root, snapshot)) return "dest_diverged";
  return undefined;
}

/** The destination has a commit on the source's branch that the source does not hold. */
async function hasDiverged(dest: Destination, source: GitSite, cwd: string, snapshot: GitSnapshot): Promise<boolean> {
  const theirs = await dest.branchHead(snapshot.branch);
  if (theirs === undefined) return false;
  try {
    await source.git(cwd, ["cat-file", "-e", `${theirs}^{commit}`]);
  } catch (error) {
    if (error instanceof ProcessError) return true;
    throw error;
  }
  const ahead = await source.git(cwd, ["rev-list", "-n", "1", theirs, "--not", snapshot.head]);
  return ahead.trim() !== "";
}

/** One checkout on one machine, driven with git plumbing through the machine; no shell on the way. */
class Destination {
  readonly #machine: GitMachine;
  readonly #cwd: string;

  constructor(machine: GitMachine, cwd: string) {
    this.#machine = machine;
    this.#cwd = cwd;
  }

  /** `folder` is inside a work tree whose top level is this checkout's path; another repository's top level is no match. */
  async hasTopLevel(folder: string): Promise<boolean> {
    const result = await this.#machine.exec(["git", "-C", folder, "rev-parse", "--show-toplevel"], {
      timeoutSeconds: DEST_TIMEOUT_S,
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
      throw new Error(`cannot undo the carry on ${this.#machine.name} at ${this.#cwd}: it recorded neither a branch nor a commit`);
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

  #git(args: readonly string[], options: readonly string[] = []): Promise<ExecResult> {
    return this.#machine.exec(["git", "-C", this.#cwd, ...options, ...args], { timeoutSeconds: DEST_TIMEOUT_S });
  }

  async #optional(args: readonly string[]): Promise<string | undefined> {
    const result = await this.#git(args);
    const text = result.stdout.trim();
    return result.code === 0 && text !== "" ? text : undefined;
  }

  #ok(result: ExecResult, label: string): ExecResult {
    if (result.code !== 0) {
      throw new Error(`git ${label} failed on ${this.#machine.name} at ${this.#cwd} (exit ${result.code}): ${result.stderr.trim()}`);
    }
    return result;
  }
}
