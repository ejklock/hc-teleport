import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessError, type Runner } from "../platform/process.ts";

/** What stands between a checkout and a snapshot of it. */
export type SourceRefusal = "source_detached" | "source_no_commit";

/** The checkout's state as commits already stored in its repository: nothing but objects is written. */
export type GitSnapshot = {
  /** The repository's top level holding the folder snapshotted: the checkout the commits describe. */
  root: string;
  head: string;
  branch: string;
  /** Parent `head`, tree the index. */
  staged: string;
  /** Parent `staged`, tree the working tree: untracked files in, ignored files out. */
  worktree: string;
};

export type SnapshotOutcome = { ok: true; snapshot: GitSnapshot } | { ok: false; reason: SourceRefusal };

const AUTHOR = {
  GIT_AUTHOR_NAME: "hc-teleport",
  GIT_AUTHOR_EMAIL: "hc-teleport@localhost",
  GIT_COMMITTER_NAME: "hc-teleport",
  GIT_COMMITTER_EMAIL: "hc-teleport@localhost",
} as const;

/**
 * Builds the staged and working-tree commits through a copy of the index, so the checkout's own index, refs
 * and files stay as they are; the user's git config never decides who the commits are by. `cwd` may lie anywhere
 * below the repository's top level: the snapshot is of the whole checkout, whose top level it names.
 */
export async function snapshotGit(cwd: string, run: Runner): Promise<SnapshotOutcome> {
  const git = (args: readonly string[], env?: Readonly<Record<string, string>>): Promise<string> =>
    run("git", ["-C", cwd, ...args], env === undefined ? undefined : { env });

  const branch = (await git(["branch", "--show-current"])).trim();
  if (branch === "") return { ok: false, reason: "source_detached" };
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();
  const head = await resolveHead(git);
  if (head === undefined) return { ok: false, reason: "source_no_commit" };

  const scratch = await mkdtemp(join(tmpdir(), "hc-teleport-index-"));
  try {
    const indexFile = join(scratch, "index");
    const original = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    // An absent index is an empty one, which git also reads from a path that does not exist.
    await copyFile(original, indexFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const env = { ...AUTHOR, GIT_INDEX_FILE: indexFile };
    const commitTree = async (parent: string): Promise<string> => {
      const tree = (await git(["write-tree"], env)).trim();
      return (await git(["commit-tree", tree, "-p", parent, "-m", "hc-teleport"], env)).trim();
    };

    const staged = await commitTree(head);
    await git(["add", "-A"], env);
    const worktree = await commitTree(staged);
    return { ok: true, snapshot: { root, head, branch, staged, worktree } };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function resolveHead(git: (args: readonly string[]) => Promise<string>): Promise<string | undefined> {
  try {
    return (await git(["rev-parse", "--verify", "-q", "HEAD"])).trim();
  } catch (error) {
    if (error instanceof ProcessError) return undefined;
    throw error;
  }
}
