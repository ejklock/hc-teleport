import { posix } from "node:path";
import type { Hc } from "../platform/hc.ts";
import { LocalMachine, type Machine } from "../platform/machine.ts";
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

/** What a carry asks of a machine: programs and a temporary folder. */
export type GitMachine = Pick<Machine, "name" | "exec" | "makeTempDir" | "remove">;

/** The machine a checkout lives on and the git command that runs there; a non-zero exit rejects with a `ProcessError`. */
export type GitSite = {
  machine: GitMachine;
  git(cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<string>;
};

const SITE_TIMEOUT_S = 300;

/** Git on this host runs through the runner, as the carry's transport does; git on a machine runs through that machine. */
export function siteOf(where: Runner | GitMachine): GitSite {
  if (typeof where === "function") {
    return {
      machine: new LocalMachine(),
      git: (cwd, args, env) => where("git", ["-C", cwd, ...args], env === undefined ? undefined : { env }),
    };
  }
  return {
    machine: where,
    git: async (cwd, args, env) => {
      const argv = ["git", "-C", cwd, ...args];
      const result = await where.exec(argv, { timeoutSeconds: SITE_TIMEOUT_S, ...(env === undefined ? {} : { env }) });
      if (result.code !== 0) throw new ProcessError(argv.join(" "), result.stderr.trim() || `exit ${result.code}`);
      return result.stdout;
    },
  };
}

/**
 * The Mac for `local`, else the hc machine of that name. A program that hc cannot run rejects with hc's own `HcError`, as
 * every caller of a carry already expects, which the `Machine` port would turn into another type.
 */
export function machineNamed(name: string, hc: Pick<Hc, "exec">): GitMachine {
  if (name === "local") return new LocalMachine();
  const exec: Machine["exec"] = (argv, options = {}) =>
    hc.exec(argv, {
      on: name,
      timeout: options.timeoutSeconds ?? SITE_TIMEOUT_S,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  const ok = (reply: { code: number; stderr: string }, what: string): void => {
    if (reply.code !== 0) throw new ProcessError(`${what} on ${name}`, reply.stderr.trim() || `exit ${reply.code}`);
  };
  return {
    name,
    exec,
    makeTempDir: async () => {
      const reply = await exec(["mktemp", "-d", "-t", "hc-teleport-XXXXXX"]);
      ok(reply, "mktemp");
      const folder = reply.stdout.trim();
      if (!posix.isAbsolute(folder) || folder.includes("\n")) {
        throw new ProcessError(`mktemp on ${name}`, `answered ${JSON.stringify(reply.stdout)}, not one absolute path`);
      }
      return folder;
    },
    remove: async (path) => {
      if (!posix.isAbsolute(path)) throw new ProcessError(`rm on ${name}`, `refused the path ${JSON.stringify(path)}, which is not absolute`);
      ok(await exec(["rm", "-rf", "--", path]), "rm");
    },
  };
}

/**
 * Builds the staged and working-tree commits through a copy of the index, so the checkout's own index, refs
 * and files stay as they are; the user's git config never decides who the commits are by. `cwd` may lie anywhere
 * below the repository's top level: the snapshot is of the whole checkout, whose top level it names. The checkout
 * is on this host when `where` is a runner, else on that machine; the copy of the index sits in a temporary folder
 * there, removed whatever happens.
 */
export async function snapshotGit(cwd: string, where: Runner | GitMachine): Promise<SnapshotOutcome> {
  const site = siteOf(where);
  const git = (args: readonly string[], env?: Readonly<Record<string, string>>): Promise<string> => site.git(cwd, args, env);

  const branch = (await git(["branch", "--show-current"])).trim();
  if (branch === "") return { ok: false, reason: "source_detached" };
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();
  const head = await resolveHead(git);
  if (head === undefined) return { ok: false, reason: "source_no_commit" };

  const { machine } = site;
  const scratch = await machine.makeTempDir();
  try {
    const indexFile = posix.join(scratch, "index");
    const original = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    // An absent index is an empty one, which git also reads from a path that does not exist.
    if ((await machine.exec(["test", "-e", original], { timeoutSeconds: SITE_TIMEOUT_S })).code === 0) {
      const copied = await machine.exec(["cp", "--", original, indexFile], { timeoutSeconds: SITE_TIMEOUT_S });
      if (copied.code !== 0) throw new ProcessError(`cp ${original} ${indexFile}`, copied.stderr.trim() || `exit ${copied.code}`);
    }
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
    await machine.remove(scratch);
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
