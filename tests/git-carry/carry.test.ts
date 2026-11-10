import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carryGit, undoGitCarry, type GitCarryDeps, type GitCarryOutcome } from "../../src/git-carry/carry.ts";
import { parkSource } from "../../src/git-carry/index.ts";
import { snapshotGit } from "../../src/git-carry/snapshot.ts";
import { HcError } from "../../src/platform/hc.ts";
import { ProcessError, processRunner, type Runner } from "../../src/platform/process.ts";

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

describe("carryGit from a remote source", () => {
  const SSH = "dev.example.test";
  let dev: string;
  let folders: string[];
  let atFetch: string[];
  let calls: number;
  let failFetch: boolean;
  let sshTarget: string | undefined;

  beforeEach(() => {
    dev = join(realpathSync(root), "dev");
    execFileSync("git", ["clone", "-q", repo, dev]);
    mkdirSync(join(repo, "sub"));
    mkdirSync(join(dev, "sub"));
    folders = [];
    atFetch = [];
    calls = 0;
    failFetch = false;
    sshTarget = SSH;
  });

  const inDev = (args: readonly string[]): string =>
    execFileSync("git", ["-C", dev, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { encoding: "utf8" });

  const readings = (dir: string): string[] =>
    [
      ["for-each-ref"],
      ["rev-parse", "--verify", "-q", "HEAD"],
      ["symbolic-ref", "-q", "HEAD"],
      ["ls-files", "-s"],
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
    ].map((args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout);

  /** hc with one machine, `dev`, that is a second checkout on this host; the Mac's path is read as that checkout's. */
  const hc = {
    machines: () => {
      calls += 1;
      return Promise.resolve([{ name: "dev", state: "online", ...(sshTarget === undefined ? {} : { sshTarget }) }]);
    },
    exec: (argv: readonly string[], options?: { env?: Readonly<Record<string, string>> }) => {
      calls += 1;
      const [program = "", ...rest] = argv.map((part) => part.split(repo).join(dev));
      const result = spawnSync(program, rest, { encoding: "utf8", env: { ...process.env, ...options?.env } });
      if (program === "mktemp") folders.push(result.stdout.trim());
      return Promise.resolve({ code: result.status ?? 1, stdout: result.stdout.split(dev).join(repo), stderr: result.stderr });
    },
  };

  /** The Mac's fetch reads the source's checkout directly, and notes the refs the source holds while it runs. */
  const macRun: Runner = (file, args, options) => {
    if (!args.includes("fetch")) return processRunner()(file, args, options);
    atFetch.push(inDev(["for-each-ref", "refs/hc-teleport/"]));
    if (failFetch) return Promise.reject(new ProcessError("git fetch", "the machine is unreachable"));
    return processRunner()(file, args.map((arg) => (arg === `${SSH}:${repo}` ? dev : arg)), options);
  };

  const carry = (cwd = repo) => carryGit({ cwd, machine: "local", source: "dev", id: randomUUID() }, { hc, run: macRun });

  function changeDev(): void {
    writeFileSync(join(dev, "second.txt"), "second\n");
    inDev(["add", "-A"]);
    inDev(["commit", "-q", "-m", "second"]);
    writeFileSync(join(dev, "tracked.txt"), "staged\n");
    inDev(["add", "tracked.txt"]);
    writeFileSync(join(dev, "tracked.txt"), "staged then edited\n");
    writeFileSync(join(dev, "fresh.txt"), "fresh\n");
    writeFileSync(join(dev, "blob.bin"), Buffer.from([0, 255, 1, 254, 0, 13, 10]));
  }

  const expectNothingWrittenAnywhere = async (outcome: Promise<GitCarryOutcome>, reason: string): Promise<void> => {
    const [macBefore, devBefore] = [readings(repo), readings(dev)];
    expect(await outcome).toEqual({ status: "refused", reason });
    expect(readings(repo)).toEqual(macBefore);
    expect(readings(dev)).toEqual(devBefore);
    expect(atFetch).toEqual([]);
    for (const folder of folders) expect(existsSync(folder)).toBe(false);
  };

  it("brings commits, staged, unstaged, untracked and binary changes to the Mac and leaves the source as it was", async () => {
    changeDev();
    const devBefore = readings(dev);

    const outcome = await carry();

    expect(outcome).toMatchObject({ status: "carried", source: "dev", machine: "local", cwd: repo, branch: "main" });
    expect(git(["rev-parse", "HEAD"])).toBe(inDev(["rev-parse", "HEAD"]));
    expect(git(["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(
      inDev(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    );
    expect(git(["ls-files", "-s"])).toBe(inDev(["ls-files", "-s"]));
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("staged then edited\n");
    expect(readFileSync(join(repo, "blob.bin"))).toEqual(Buffer.from([0, 255, 1, 254, 0, 13, 10]));
    expect(readings(dev)).toEqual(devBefore);
    expect(atFetch).toHaveLength(1);
    expect(atFetch[0]?.trim().split("\n")).toHaveLength(3);
    expect(inDev(["for-each-ref", "refs/hc-teleport/"])).toBe("");
    expect(folders).toHaveLength(1);
    expect(existsSync(folders[0] ?? "")).toBe(false);
  });

  it("carries the top level when the session folder lies below it", async () => {
    changeDev();

    const outcome = await carry(join(repo, "sub"));

    expect(outcome).toMatchObject({ status: "carried", cwd: repo });
    expect(git(["rev-parse", "HEAD"])).toBe(inDev(["rev-parse", "HEAD"]));
  });

  it("removes the source's refs and its temporary folder when the Mac's fetch fails, and changes nothing on the Mac", async () => {
    changeDev();
    failFetch = true;
    const [macBefore, devBefore] = [readings(repo), readings(dev)];

    await expect(carry()).rejects.toThrow("the machine is unreachable");

    expect(atFetch).toHaveLength(1);
    expect(readings(repo)).toEqual(macBefore);
    expect(readings(dev)).toEqual(devBefore);
    expect(inDev(["for-each-ref", "refs/hc-teleport/"])).toBe("");
    expect(folders).toHaveLength(1);
    expect(existsSync(folders[0] ?? "")).toBe(false);
  });

  it("undoes a carry from a remote source, putting the Mac's checkout back", async () => {
    changeDev();
    const macBefore = readings(repo);
    const outcome = await carry();
    if (outcome.status !== "carried") throw new Error(`not carried: ${outcome.status}`);

    await undoGitCarry(outcome, { hc });

    expect(readings(repo)).toEqual(macBefore);
  });

  describe("refuses and writes nothing on either side", () => {
    it("when the Mac's checkout has uncommitted work", async () => {
      changeDev();
      writeFileSync(join(repo, "mine.txt"), "mine\n");
      await expectNothingWrittenAnywhere(carry(), "dest_dirty");
    });

    it("when the Mac has a commit on the branch that the source lacks", async () => {
      changeDev();
      writeFileSync(join(repo, "mac-only.txt"), "mac\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "mac only"]);
      await expectNothingWrittenAnywhere(carry(), "dest_diverged");
    });

    it("when the Mac holds no checkout at that path", async () => {
      changeDev();
      rmSync(join(repo, ".git"), { recursive: true });
      await expectNothingWrittenAnywhere(carry(), "dest_repo_missing");
    });

    it("when the source is on a detached HEAD", async () => {
      inDev(["checkout", "-q", "--detach"]);
      await expectNothingWrittenAnywhere(carry(), "source_detached");
    });

    it("when the source has no commit", async () => {
      rmSync(join(dev, ".git"), { recursive: true });
      inDev(["init", "-q", "-b", "main"]);
      await expectNothingWrittenAnywhere(carry(), "source_no_commit");
    });

    it("when hc reports no ssh host for the source", async () => {
      changeDev();
      sshTarget = undefined;
      await expectNothingWrittenAnywhere(carry(), "machine_without_ssh");
    });
  });

  it.each([
    ["both ends the Mac, by default", "local", undefined],
    ["both ends the Mac, by name", "local", "local"],
    ["neither end the Mac", "dev", "other"],
  ])("throws a RangeError before anything runs when %s", async (_title, machine, source) => {
    const request = { cwd: repo, machine, id: randomUUID(), ...(source === undefined ? {} : { source }) };

    await expect(carryGit(request, { hc, run: macRun })).rejects.toBeInstanceOf(RangeError);

    expect(calls).toBe(0);
  });
});

describe("carryGit, undoGitCarry and parkSource when hc fails", () => {
  const hcDown = (): HcError => new HcError("hc exec: dev-home is offline");
  const spawned = (argv: readonly string[], options?: { env?: Readonly<Record<string, string>> }) => {
    const result = spawnSync(argv[0] ?? "git", argv.slice(1), { encoding: "utf8", env: { ...process.env, ...options?.env } });
    return Promise.resolve({ code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr });
  };
  const machines = () => Promise.resolve([{ name: "dest", state: "online", sshTarget: "dest.example.test" }]);

  /** hc that runs programs here and rejects with an hc failure on a call whose argv holds every word of `on`, for the first `times` such calls. */
  function flaky(on: readonly string[], times = Infinity) {
    let down = 0;
    return {
      machines,
      exec: (argv: readonly string[], options?: { env?: Readonly<Record<string, string>> }) => {
        if (on.every((word) => argv.includes(word)) && down < times) {
          down += 1;
          return Promise.reject(hcDown());
        }
        return spawned(argv, options);
      },
    };
  }

  it.each([
    ["the destination's top level", ["--show-toplevel"]],
    ["the destination's status", ["status"]],
    ["the destination's branch head", ["refs/heads/main"]],
    ["the destination's current branch", ["symbolic-ref"]],
  ])("carryGit rejects an HcError when hc fails on %s, before anything is pushed", async (_title, on) => {
    const outcome = carryGit({ cwd: repo, machine: "dest", id: randomUUID() }, { run, hc: flaky(on) });

    await expect(outcome).rejects.toBeInstanceOf(HcError);
  });

  describe("on the undo", () => {
    /** A destination that moved to the carried commit, as a failed step leaves it. */
    function movedDestination(id: string) {
      const previousHead = git(["rev-parse", "HEAD"]).trim();
      git(["checkout", "-q", "-b", "scratch"]);
      writeFileSync(join(repo, "carried.txt"), "carried\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "carried"]);
      const carriedHead = git(["rev-parse", "HEAD"]).trim();
      git(["checkout", "-q", "main"]);
      git(["branch", "-q", "-D", "scratch"]);
      const refs = ["head", "staged", "worktree"].map((name) => `refs/hc-teleport/${id}/${name}`);
      for (const ref of refs) git(["update-ref", ref, carriedHead]);
      git(["checkout", "-q", "-B", "main", carriedHead, "--"]);
      return {
        status: "carried" as const,
        machine: "dest",
        id,
        cwd: repo,
        refs,
        previousBranch: "main",
        previousHead,
        branch: "main",
        branchPreviousHead: previousHead,
        carried: { head: carriedHead, staged: carriedHead, worktree: carriedHead },
      };
    }

    it.each([
      ["looking for the carry's refs", ["rev-parse"]],
      ["reading where the checkout stands", ["symbolic-ref"]],
      ["rewinding the checkout", ["read-tree"]],
      ["deleting a ref", ["update-ref", "-d"]],
    ])("undoGitCarry rejects an HcError when hc fails %s", async (_title, on) => {
      const outcome = movedDestination(randomUUID());

      await expect(undoGitCarry(outcome, { hc: flaky(on) })).rejects.toBeInstanceOf(HcError);
    });
  });

  describe("on a remote source", () => {
    const SSH = "dev.example.test";
    let dev: string;
    const inDev = (args: readonly string[]): string =>
      execFileSync("git", ["-C", dev, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { encoding: "utf8" });
    const refsOnDev = (): string => inDev(["for-each-ref", "refs/hc-teleport/"]);

    beforeEach(() => {
      dev = join(realpathSync(root), "dev");
      execFileSync("git", ["clone", "-q", repo, dev]);
      writeFileSync(join(dev, "second.txt"), "second\n");
      inDev(["add", "-A"]);
      inDev(["commit", "-q", "-m", "second"]);
    });

    /** hc whose machine `dev` is a second checkout here, failing on the calls `flaky` would. */
    function devHc(on: readonly string[], times = Infinity) {
      const inner = flaky(on, times);
      return {
        machines: () => Promise.resolve([{ name: "dev", state: "online", sshTarget: SSH }]),
        exec: (argv: readonly string[], options?: { env?: Readonly<Record<string, string>> }) =>
          inner
            .exec(argv.map((part) => part.split(repo).join(dev)), options)
            .then((reply) => ({ ...reply, stdout: reply.stdout.split(dev).join(repo) })),
      };
    }

    const fetchFromDev: Runner = (file, args, options) =>
      processRunner()(file, args.map((arg) => (arg === `${SSH}:${repo}` ? dev : arg)), options);

    const carry = (hc: ReturnType<typeof devHc>, id = randomUUID()) =>
      carryGit({ cwd: repo, machine: "local", source: "dev", id }, { hc, run: fetchFromDev });

    it.each([
      ["the snapshot's first call", ["git"]],
      ["the snapshot's commit", ["commit-tree"]],
      ["the temporary folder's removal", ["rm"]],
    ])("carryGit rejects an HcError when hc fails on %s of a remote source", async (_title, on) => {
      await expect(carry(devHc(on))).rejects.toBeInstanceOf(HcError);
      expect(refsOnDev()).toBe("");
    });

    it("carryGit rejects an HcError when hc keeps failing on the cleanup after the fetch", async () => {
      await expect(carry(devHc(["update-ref", "-d"]))).rejects.toBeInstanceOf(HcError);
    });

    it("carryGit deletes the other refs and names the one left when hc fails on one deletion after the fetch", async () => {
      const id = randomUUID();

      const failure = await carry(devHc(["update-ref", "-d"], 1), id).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HcError);
      expect((failure as HcError).message).toContain(`left on the source: refs/hc-teleport/${id}/head`);
      expect((failure as HcError).message).not.toContain(`${id}/staged`);
      expect(refsOnDev().trim().split("\n").map((line) => line.split(/\s+/)[2])).toEqual([`refs/hc-teleport/${id}/head`]);
    });

    it("carryGit rejects a ProcessError naming the ref left when git fails to delete a ref after the fetch", async () => {
      const id = randomUUID();
      const inner = devHc(["\0"]);
      const hc = {
        ...inner,
        exec: (argv: readonly string[], options?: { env?: Readonly<Record<string, string>> }) =>
          argv.includes("update-ref") && argv.includes("-d") && argv.some((part) => part.endsWith(`${id}/head`))
            ? Promise.resolve({ code: 1, stdout: "", stderr: "fatal: cannot lock ref" })
            : inner.exec(argv, options),
      };

      const failure = await carry(hc, id).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ProcessError);
      expect((failure as ProcessError).message).toContain("fatal: cannot lock ref");
      expect((failure as ProcessError).message).toContain(`left on the source: refs/hc-teleport/${id}/head`);
    });

    it("parkSource rejects an HcError when hc fails on the source, first or later", async () => {
      const taken = await snapshotGit(dev, run);
      if (!taken.ok) throw new Error(taken.reason);
      const id = randomUUID();
      const outcome = {
        status: "carried" as const,
        machine: "local",
        source: "dev",
        cwd: dev,
        id,
        refs: ["head", "staged", "worktree"].map((name) => `refs/hc-teleport/${id}/${name}`),
        branch: taken.snapshot.branch,
        carried: { head: taken.snapshot.head, staged: taken.snapshot.staged, worktree: taken.snapshot.worktree },
      };
      const never: Runner = () => Promise.reject(new Error("the source is remote"));

      await expect(parkSource(outcome, { run: never, hc: { exec: flaky(["update-ref"]).exec } })).rejects.toBeInstanceOf(HcError);
      await expect(parkSource(outcome, { run: never, hc: { exec: flaky(["read-tree"]).exec } })).rejects.toBeInstanceOf(HcError);
    });
  });
});

describe.each([
  ["through the stub hc machine", "dest"],
  ["with the Mac as the destination", "local"],
])("undoGitCarry undoes from what the destination holds %s", (_where, destination) => {
  const exec = (argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const result = spawnSync(argv[0] ?? "git", argv.slice(1), { encoding: "utf8" });
    return Promise.resolve({ code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr });
  };
  const undoDeps = { hc: { exec, machines: () => Promise.resolve([]) } };

  function fingerprint(): string {
    return [
      git(["for-each-ref"]),
      spawnSync("git", ["-C", repo, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" }).stdout,
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
        machine: destination,
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

  it("undoes a carry onto the local machine on this host, never asking hc", async () => {
    const id = randomUUID();
    const { before, outcome } = pushed(id);
    git(["checkout", "-q", "-B", "main", outcome.carried.head, "--"]);
    git(["read-tree", "-u", "--reset", outcome.carried.worktree]);
    const onLocal = { ...outcome, machine: "local" };
    const noHc = { hc: { exec: () => Promise.reject(new Error("hc was asked")), machines: () => Promise.resolve([]) } };

    await undoGitCarry(onLocal, noHc);

    expect(fingerprint()).toBe(before);
    expect(refsLeft(id)).toBe("");
    await undoGitCarry(onLocal, noHc);
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

  describe("on a destination with no commit", () => {
    interface UnbornOptions {
      /** Tracked paths the source force-adds, whatever its ignore rules say. */
      forced?: string[];
      /** The source's `.gitignore`, carried with the commit. */
      sourceIgnore?: string;
      /** Lines added to the destination's `.git/info/exclude`. */
      destExclude?: string;
      /** Files the destination holds before the carry, by path. */
      preexisting?: Record<string, string>;
    }

    /** A destination made by `git init` with one ignored file, and the carry's refs fetched onto it from the source. */
    function unbornDestination(id: string, unbornBranch: string, carriedBranch: string, options: UnbornOptions = {}) {
      const source = repo;
      git(["checkout", "-q", "-b", "scratch"]);
      writeFileSync(join(source, "carried.txt"), "carried\n");
      if (options.sourceIgnore !== undefined) writeFileSync(join(source, ".gitignore"), options.sourceIgnore);
      for (const path of options.forced ?? []) {
        mkdirSync(dirname(join(source, path)), { recursive: true });
        writeFileSync(join(source, path), `carried ${path}\n`);
        git(["--literal-pathspecs", "add", "-f", "--", path]);
      }
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "carried"]);
      const carriedHead = git(["rev-parse", "HEAD"]).trim();
      repo = join(realpathSync(root), "dest");
      mkdirSync(repo);
      git(["init", "-q", "-b", unbornBranch]);
      writeFileSync(join(repo, ".git", "info", "exclude"), `ignored.log\n${options.destExclude ?? ""}`);
      writeFileSync(join(repo, "ignored.log"), "kept\n");
      for (const [path, content] of Object.entries(options.preexisting ?? {})) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), content);
      }
      const before = fingerprint();
      const refs = ["head", "staged", "worktree"].map((name) => `refs/hc-teleport/${id}/${name}`);
      git(["fetch", "-q", source, `refs/heads/scratch:${refs[0]}`]);
      git(["update-ref", refs[1] ?? "", carriedHead]);
      git(["update-ref", refs[2] ?? "", carriedHead]);
      const state = {
        machine: destination,
        id,
        cwd: repo,
        refs,
        previousBranch: unbornBranch,
        branch: carriedBranch,
        carried: { head: carriedHead, staged: carriedHead, worktree: carriedHead },
      };
      return { before, carriedHead, state };
    }

    /** What the carry's checkout and working-tree read-tree leave behind: the branch, a staged file, an untracked file and an edit. */
    function checkedOut(branch: string, head: string): void {
      git(["checkout", "-q", "-B", branch, head, "--"]);
      writeFileSync(join(repo, "carried-staged.txt"), "staged\n");
      git(["add", "carried-staged.txt"]);
      writeFileSync(join(repo, "carried-new.txt"), "new\n");
      writeFileSync(join(repo, "carried.txt"), "edited\n");
    }

    it.each([
      ["a carried outcome onto the unborn branch of the same name", "main", "main", "carried"],
      ["a carried outcome onto an unborn branch of another name", "trunk", "feature", "carried"],
      ["a failed checkout where nothing moved", "trunk", "feature", "nothing"],
      ["a failed read-tree of the working tree after the checkout ran", "main", "main", "read-tree"],
      ["a failed read-tree of the working tree on another branch name", "trunk", "feature", "read-tree"],
    ])("puts the checkout back after %s, and changes nothing on a second call", async (_title, unborn, branch, ran) => {
      const id = randomUUID();
      const { before, carriedHead, state } = unbornDestination(id, unborn, branch);
      if (ran !== "nothing") checkedOut(branch, carriedHead);
      const outcome: Extract<GitCarryOutcome, { status: "carried" | "failed" }> =
        ran === "carried"
          ? { status: "carried", ...state }
          : { status: "failed", step: ran === "nothing" ? "checkout" : "read-tree of the working tree", detail: "dropped", ...state };

      await undoGitCarry(outcome, undoDeps);

      expect(fingerprint()).toBe(before);
      expect(refsLeft(id)).toBe("");
      expect(git(["ls-files", "-s"])).toBe("");
      await undoGitCarry(outcome, undoDeps);
      expect(fingerprint()).toBe(before);
    });

    it.each([
      ["a carried .gitignore", { forced: [".vscode/settings.json"], sourceIgnore: ".vscode/\n" }, "carried"],
      [
        "the destination's own exclude file, beside a pre-existing ignored file",
        { forced: [".vscode/settings.json"], destExclude: ".vscode/\n", preexisting: { ".vscode/keep.json": "{\"a\": 1}\n" } },
        "carried",
      ],
      ["a name with a space, a newline and a leading dash", { forced: ["-odd dir/a\nb -c.txt"], sourceIgnore: "-odd*/\n" }, "carried"],
      ["a failed read-tree of the working tree", { forced: [".vscode/settings.json"], sourceIgnore: ".vscode/\n" }, "read-tree"],
    ])("removes every carried tracked file that an ignore rule matches, through %s", async (_title, options, ran) => {
      const id = randomUUID();
      const { before, carriedHead, state } = unbornDestination(id, "main", "main", options);
      checkedOut("main", carriedHead);
      const outcome: Extract<GitCarryOutcome, { status: "carried" | "failed" }> =
        ran === "carried"
          ? { status: "carried", ...state }
          : { status: "failed", step: "read-tree of the working tree", detail: "dropped", ...state };
      for (const path of options.forced) expect(existsSync(join(repo, path))).toBe(true);

      await undoGitCarry(outcome, undoDeps);

      expect(fingerprint()).toBe(before);
      expect(refsLeft(id)).toBe("");
      for (const path of options.forced) expect(existsSync(join(repo, path))).toBe(false);
      for (const [path, content] of Object.entries("preexisting" in options ? options.preexisting : {})) {
        expect(readFileSync(join(repo, path), "utf8")).toBe(content);
      }
      await undoGitCarry(outcome, undoDeps);
      expect(fingerprint()).toBe(before);
    });

    it.each([
      ["tracked", true],
      ["untracked", false],
    ])("removes carried %s files whose names start like pathspec magic", async (_title, tracked) => {
      const id = randomUUID();
      const names = [":!x.txt", ":(top)y.txt"];
      const { before, carriedHead, state } = unbornDestination(id, "main", "main", tracked ? { forced: names } : {});
      checkedOut("main", carriedHead);
      if (!tracked) for (const name of names) writeFileSync(join(repo, name), "untracked\n");
      for (const name of names) expect(existsSync(join(repo, name))).toBe(true);
      expect(git(["--literal-pathspecs", "ls-files", "-z"]).includes(":!x.txt")).toBe(tracked);
      expect(process.env["GIT_LITERAL_PATHSPECS"]).toBeUndefined();
      const outcome: Extract<GitCarryOutcome, { status: "carried" | "failed" }> = { status: "carried", ...state };

      await undoGitCarry(outcome, undoDeps);

      for (const name of names) expect(existsSync(join(repo, name))).toBe(false);
      expect(fingerprint()).toBe(before);
      expect(refsLeft(id)).toBe("");
      await undoGitCarry(outcome, undoDeps);
      expect(fingerprint()).toBe(before);
    });
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
