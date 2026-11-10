import { z } from "zod";
import type { Runner } from "../platform/process.ts";
import { refNames, type CarriedState, type GitCarryOutcome } from "./carry.ts";
import { snapshotGit } from "./snapshot.ts";

export type ParkOutcome = { parked: true } | { parked: false; reason: string };

const idSchema = z.uuid();

/**
 * Keeps what a carry took from the source under `refs/hc-teleport/<id>/*` and, only when the source still holds exactly
 * what was carried (same branch, HEAD, index and working tree), resets its checkout to HEAD: index and tracked files
 * at HEAD, untracked files removed, ignored files and the branch left alone. A source that changed since keeps its
 * checkout whole and the reason names what changed. `git read-tree -u --reset <worktree>` then `git read-tree <staged>`
 * brings a parked checkout back. Writes on the source only. Refuses an outcome that is not a carried one.
 *
 * Plain git cannot make the check and the reset one step: an edit made in the few git processes between the fresh
 * snapshot and the reset is lost and sits in no ref. The caller stops every writer to the checkout, such as the
 * terminal running in it, before calling.
 */
export async function parkSource(
  carried: Extract<GitCarryOutcome, { status: "carried" }>,
  deps: { run: Runner },
): Promise<ParkOutcome> {
  if (carried.status !== "carried") throw new Error(`only a carried outcome can be parked, got ${String(carried.status)}`);
  const id = idSchema.parse(carried.id);
  const { run } = deps;
  const git = (args: readonly string[]): Promise<string> => run("git", ["-C", carried.cwd, ...args]);
  const refs = refNames(id);
  const { head, staged, worktree } = carried.carried;
  await git(["update-ref", refs.head, head]);
  await git(["update-ref", refs.staged, staged]);
  await git(["update-ref", refs.worktree, worktree]);

  const changed = await whatChanged(carried, run);
  if (changed.length > 0) return { parked: false, reason: `the source changed after the carry: ${changed.join(", ")}` };

  await git(["read-tree", "-u", "--reset", "HEAD"]);
  const listed = await git(["ls-files", "-z", "--others", "--exclude-standard"]);
  const untracked = listed.split("\0").filter((path) => path !== "");
  for (let from = 0; from < untracked.length; from += CLEAN_BATCH) {
    await git(["--literal-pathspecs", "clean", "-f", "-d", "-q", "--", ...untracked.slice(from, from + CLEAN_BATCH)]);
  }
  return { parked: true };
}

const CLEAN_BATCH = 100;

/** What a fresh snapshot of the source differs in from the carried one: "branch", "HEAD", "index", "working tree". */
async function whatChanged(carried: CarriedState, run: Runner): Promise<string[]> {
  const taken = await snapshotGit(carried.cwd, run);
  if (!taken.ok) return ["branch"];
  const { snapshot } = taken;
  const tree = async (commit: string): Promise<string> => (await run("git", ["-C", carried.cwd, "rev-parse", `${commit}^{tree}`])).trim();
  const changed: string[] = [];
  if (snapshot.branch !== carried.branch) changed.push("branch");
  if (snapshot.head !== carried.carried.head) changed.push("HEAD");
  if ((await tree(snapshot.staged)) !== (await tree(carried.carried.staged))) changed.push("index");
  if ((await tree(snapshot.worktree)) !== (await tree(carried.carried.worktree))) changed.push("working tree");
  return changed;
}
