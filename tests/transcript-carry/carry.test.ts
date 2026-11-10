import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hc, HcExecOptions, HcExecResult } from "../../src/platform/hc.ts";
import { HcError } from "../../src/platform/hc.ts";
import { LocalMachine, MachineError, type Entry, type EntryKind, type ExecResult, type Machine } from "../../src/platform/machine.ts";
import { carryTranscript, TranscriptCarryError, undoTranscriptCarry, type CarryDeps, type CarryRequest } from "../../src/transcript-carry/carry.ts";

type Call = { argv: string[]; stdin?: string };
type Behavior = (call: Call) => Partial<HcExecResult> | undefined;

const MISSING_PT = "Arquivo ou diretório inexistente";

/** A runner that records every call and answers 0 unless the behavior says otherwise. */
function fakeHc(behavior: Behavior = () => undefined) {
  const calls: Call[] = [];
  const hc: Pick<Hc, "exec"> = {
    async exec(argv: readonly string[], options: HcExecOptions = {}): Promise<HcExecResult> {
      const call: Call = { argv: [...argv], ...(options.stdin === undefined ? {} : { stdin: options.stdin }) };
      calls.push(call);
      return { code: 0, stdout: "", stderr: "", ...behavior(call) };
    },
  };
  return { hc, calls };
}

const verbs = (calls: Call[]) => calls.map((call) => call.argv[0]);
const isExistenceCheck = (call: Call) => call.argv[0] === "test";

describe("carryTranscript against an injected runner", () => {
  const destConfigDir = "/dest/cfg";
  const destFile = join(destConfigDir, "projects/p/s1.jsonl");
  const destAgent = join(destConfigDir, "projects/p/s1/subagents/a.jsonl");
  let root: string;
  let request: CarryRequest;
  let transcript: string;
  let agent: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "carry-unit-"));
    const project = join(root, "projects/p");
    transcript = join(project, "s1.jsonl");
    agent = join(project, "s1/subagents/a.jsonl");
    await mkdir(join(project, "s1/subagents"), { recursive: true });
    await writeFile(transcript, '{"cwd":"/Users/mac/x"}\n');
    await writeFile(agent, '{"cwd":"/Users/mac/y"}\n');
    request = {
      machine: "dest",
      transcript: { file: transcript, dir: join(project, "s1") },
      sourceConfigDir: root,
      sourceHome: "/Users/mac",
      destConfigDir,
      destHome: "/home/box",
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The temporary name the dd calls for a destination file write to. */
  const temporaryOf = (calls: Call[], dest: string) => {
    const dd = calls.find((call) => call.argv[0] === "dd" && call.argv[1]?.startsWith(`of=${dest}.teleport-`));
    return dd?.argv[1]?.slice("of=".length) ?? "missing";
  };

  it("puts back the first file and removes the temporary one when the second file's append fails", async () => {
    const { hc, calls } = fakeHc((call) => {
      if (isExistenceCheck(call)) return { code: 1 };
      return call.argv[0] === "dd" && call.argv[1]?.includes(destAgent) ? { code: 1, stderr: "disk full" } : undefined;
    });
    await expect(carryTranscript(request, { hc })).rejects.toThrow(/dd on dest exited 1: disk full/);
    const failing = calls.findIndex((call) => call.argv[0] === "dd" && call.argv[1]?.includes(destAgent));
    expect(failing).toBeGreaterThan(0);
    expect(calls.slice(failing + 1).map((call) => call.argv)).toEqual([
      ["rm", "-f", "--", temporaryOf(calls, destAgent)],
      ["rm", "-f", "--", destFile],
    ]);
  });

  it("puts back the kept-aside copy when the rename onto an existing file fails", async () => {
    const { hc, calls } = fakeHc((call) => (call.argv[0] === "mv" && call.argv[4] === destFile ? { code: 1, stderr: "busy" } : undefined));
    await expect(carryTranscript(request, { hc })).rejects.toThrow(/mv on dest exited 1: busy/);
    const keptAt = calls.find((call) => call.argv[0] === "ln")?.argv[3] ?? "missing";
    expect(keptAt).toContain(".prev");
    const failing = calls.findIndex((call) => call.argv[0] === "mv");
    expect(calls[failing - 1]?.argv).toEqual(["ln", "--", destFile, keptAt]);
    expect(calls.slice(failing + 1).map((call) => call.argv)).toEqual([
      ["rm", "-f", "--", temporaryOf(calls, destFile)],
      ["test", "-e", keptAt, "-o", "-L", keptAt],
      ["mv", "-f", "--", keptAt, destFile],
    ]);
  });

  it("puts back nothing and writes nothing when a file is not text", async () => {
    await writeFile(agent, Buffer.from([0x7b, 0x22, 0xff, 0x7d]));
    const { hc, calls } = fakeHc();
    await expect(carryTranscript(request, { hc })).rejects.toBeInstanceOf(TranscriptCarryError);
    expect(calls).toEqual([]);
  });

  it("puts back nothing and writes nothing when a file in the sibling directory is a symlink", async () => {
    await symlink(transcript, join(root, "projects/p/s1/link.jsonl"));
    const { hc, calls } = fakeHc();
    await expect(carryTranscript(request, { hc })).rejects.toMatchObject({ reason: "transcript_outside_config" });
    expect(calls).toEqual([]);
  });

  it("places each file by a rename from a temporary name next to it", async () => {
    const { hc, calls } = fakeHc((call) => (isExistenceCheck(call) ? { code: 1 } : undefined));
    const result = await carryTranscript(request, { hc });
    expect(result.written).toEqual([destFile, destAgent]);
    expect(verbs(calls)).toEqual(["mkdir", "dd", "test", "mv", "mkdir", "dd", "test", "mv"]);
    expect(calls[1]?.stdin).toBe('{"cwd":"/home/box/x"}\n');
    expect(calls[3]?.argv).toEqual(["mv", "-f", "--", temporaryOf(calls, destFile), destFile]);
  });

  describe("exists", () => {
    it("exists reads a missing path as missing whatever language the message is in", async () => {
      const { hc, calls } = fakeHc((call) => (isExistenceCheck(call) ? { code: 1, stderr: MISSING_PT } : undefined));
      const result = await carryTranscript(request, { hc });
      expect(result.replaced).toEqual([]);
      expect(verbs(calls)).not.toContain("ln");
    });

    it("exists reads an existing path as existing whatever language the message is in", async () => {
      const { hc, calls } = fakeHc((call) => (isExistenceCheck(call) ? { code: 0, stderr: "ação concluída" } : undefined));
      const result = await carryTranscript(request, { hc });
      expect(result.replaced.map((entry) => entry.path)).toEqual([destFile, destAgent]);
      expect(verbs(calls)).toContain("ln");
    });

    it("exists decides by exit code alone: a plain exit 1 with no message reads as missing", async () => {
      const { hc } = fakeHc((call) => (isExistenceCheck(call) ? { code: 1 } : undefined));
      await expect(carryTranscript(request, { hc })).resolves.toMatchObject({ replaced: [] });
    });

    it("exists raises an error naming the machine and path on any other failure", async () => {
      const { hc, calls } = fakeHc((call) => (isExistenceCheck(call) ? { code: 2, stderr: MISSING_PT } : undefined));
      const failure = carryTranscript(request, { hc });
      await expect(failure).rejects.toBeInstanceOf(HcError);
      await expect(failure).rejects.toThrow(/on dest exited 2/);
      await expect(failure).rejects.toThrow(destFile);
      expect(verbs(calls)).not.toContain("mv");
    });
  });
});

/** A stand-in for an hc machine that reads and lists through the scratch folders of this host. */
class NamedMachine implements Machine {
  readonly #inner: Machine;
  readonly name: string;

  constructor(name: string, inner: Machine) {
    this.name = name;
    this.#inner = inner;
  }

  exec: Machine["exec"] = (argv, options) => this.#inner.exec(argv, options);
  home: Machine["home"] = () => this.#inner.home();
  readFile: Machine["readFile"] = (path) => this.#inner.readFile(path);
  writeFile: Machine["writeFile"] = (path, text) => this.#inner.writeFile(path, text);
  realpath: Machine["realpath"] = (path) => this.#inner.realpath(path);
  entries: Machine["entries"] = (dir) => this.#inner.entries(dir);
  kind: Machine["kind"] = (path) => this.#inner.kind(path);
  makeTempDir: Machine["makeTempDir"] = () => this.#inner.makeTempDir();
  remove: Machine["remove"] = (path) => this.#inner.remove(path);
}

describe("carryTranscript from a remote source to the Mac", () => {
  const CAP = 7 * 1024 * 1024;
  const SOURCE_HOME = "/home/box";
  const DEST_HOME = "/Users/mac";
  const mac = new LocalMachine();
  let root: string;
  let sourceConfigDir: string;
  let destConfigDir: string;
  let project: string;
  let request: CarryRequest;
  let deps: CarryDeps;

  const sourceFile = () => join(project, "s1.jsonl");
  const sourceAgent = () => join(project, "s1/subagents/a.jsonl");
  const destPathOf = (path: string) => path.replace(sourceConfigDir, destConfigDir);
  const destTree = async () => (await mac.entries(destConfigDir).catch(() => [])).map((entry) => entry.path);
  const destFiles = async () => (await mac.entries(destConfigDir)).filter((entry) => entry.kind === "file").map((entry) => entry.path);
  const lineOf = (bytes: number) => `{"p":"${"x".repeat(bytes - 9)}"}\n`;

  async function seedSource(file: string, content: string | Buffer): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "carry-remote-"));
    sourceConfigDir = join(root, "src-cfg");
    destConfigDir = join(root, "dest-cfg");
    project = join(sourceConfigDir, "projects/p");
    await seedSource(sourceFile(), `{"cwd":"${SOURCE_HOME}/x"}\n`);
    await seedSource(sourceAgent(), `{"cwd":"${SOURCE_HOME}/y"}\n`);
    request = {
      machine: "local",
      sourceMachine: "dev",
      transcript: { file: sourceFile(), dir: join(project, "s1") },
      sourceConfigDir,
      sourceHome: SOURCE_HOME,
      destConfigDir,
      destHome: DEST_HOME,
    };
    deps = { hc: fakeHc().hc, machine: (name) => (name === "local" ? mac : new NamedMachine(name, mac)) };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("carries the transcript and its subagent files with the home rewritten and records both machines", async () => {
    const result = await carryTranscript(request, deps);
    expect(result).toMatchObject({ sourceMachine: "dev", machine: "local", destConfigDir });
    expect(result.written).toEqual([destPathOf(sourceFile()), destPathOf(sourceAgent())]);
    expect(await readFile(destPathOf(sourceFile()), "utf8")).toBe(`{"cwd":"${DEST_HOME}/x"}\n`);
    expect(await readFile(destPathOf(sourceAgent()), "utf8")).toBe(`{"cwd":"${DEST_HOME}/y"}\n`);
  });

  it("carries a 3 MB transcript with no final newline byte for byte after the rewrite", async () => {
    const body = lineOf(1000).repeat(3000) + `{"cwd":"${SOURCE_HOME}/last"}`;
    await seedSource(sourceFile(), body);
    await carryTranscript(request, deps);
    expect(await readFile(destPathOf(sourceFile()), "utf8")).toBe(body.replace(`${SOURCE_HOME}/last`, `${DEST_HOME}/last`));
  });

  it("carries a line of exactly the chunk cap", async () => {
    await seedSource(sourceFile(), lineOf(CAP));
    await carryTranscript(request, deps);
    expect((await stat(destPathOf(sourceFile()))).size).toBe(CAP);
  });

  it("refuses a line one byte over the chunk cap and writes nothing", async () => {
    await seedSource(sourceFile(), lineOf(CAP + 1));
    await expect(carryTranscript(request, deps)).rejects.toMatchObject({ reason: "transcript_line_too_long" });
    expect(await destTree()).toEqual([]);
  });

  it("keeps a leading byte-order mark", async () => {
    await seedSource(sourceFile(), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`{"cwd":"${SOURCE_HOME}/x"}\n`)]));
    await carryTranscript(request, deps);
    const bytes = await readFile(destPathOf(sourceFile()));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe(`{"cwd":"${DEST_HOME}/x"}\n`);
  });

  it("keeps a replaced file aside and the undo puts it back and removes the rest", async () => {
    await seedSource(destPathOf(sourceFile()), "older copy\n");
    const result = await carryTranscript(request, deps);
    expect(result.replaced).toHaveLength(1);
    expect(await readFile(result.replaced[0]?.keptAt ?? "missing", "utf8")).toBe("older copy\n");
    expect(await readFile(destPathOf(sourceFile()), "utf8")).toBe(`{"cwd":"${DEST_HOME}/x"}\n`);

    await undoTranscriptCarry(result, deps);
    expect(await readFile(destPathOf(sourceFile()), "utf8")).toBe("older copy\n");
    expect(await destFiles()).toEqual([destPathOf(sourceFile())]);
  });

  it("leaves the destination as before when placing the second file fails", async () => {
    await seedSource(destPathOf(sourceFile()), "older copy\n");
    let writes = 0;
    const failing = new NamedMachine("local", mac);
    failing.writeFile = async (path, text) => {
      writes += 1;
      if (writes === 2) throw new MachineError("local", "failed", "disk full");
      await mac.writeFile(path, text);
    };
    const failingDeps: CarryDeps = { ...deps, machine: (name) => (name === "local" ? failing : new NamedMachine(name, mac)) };
    await expect(carryTranscript(request, failingDeps)).rejects.toThrow(/disk full/);
    expect(await readFile(destPathOf(sourceFile()), "utf8")).toBe("older copy\n");
    expect(await destFiles()).toEqual([destPathOf(sourceFile())]);
  });

  it("changes nothing on a second undo", async () => {
    await seedSource(destPathOf(sourceFile()), "older copy\n");
    const result = await carryTranscript(request, deps);
    await undoTranscriptCarry(result, deps);
    const after = await destTree();
    await expect(undoTranscriptCarry(result, deps)).resolves.toBeUndefined();
    expect(await destTree()).toEqual(after);
    expect(await readFile(destPathOf(sourceFile()), "utf8")).toBe("older copy\n");
  });

  describe("refuses and writes nothing", () => {
    it("when the transcript is a symlink", async () => {
      const target = join(root, "elsewhere.jsonl");
      await seedSource(target, "{}\n");
      await rm(sourceFile());
      await symlink(target, sourceFile());
      await expect(carryTranscript(request, deps)).rejects.toMatchObject({ reason: "transcript_outside_config" });
      expect(await destTree()).toEqual([]);
    });

    it("when a file in the subagent folder is a symlink", async () => {
      await symlink(sourceFile(), join(project, "s1/link.jsonl"));
      await expect(carryTranscript(request, deps)).rejects.toMatchObject({ reason: "transcript_outside_config" });
      expect(await destTree()).toEqual([]);
    });

    it("when the transcript lies outside the config directory", async () => {
      const outside = join(root, "outside.jsonl");
      await seedSource(outside, "{}\n");
      await expect(carryTranscript({ ...request, transcript: { file: outside } }, deps)).rejects.toMatchObject({ reason: "transcript_outside_config" });
      expect(await destTree()).toEqual([]);
    });

    it("when the transcript is missing", async () => {
      await rm(sourceFile());
      await expect(carryTranscript(request, deps)).rejects.toMatchObject({ reason: "transcript_missing" });
      expect(await destTree()).toEqual([]);
    });

    it("when a file is not text", async () => {
      await seedSource(sourceAgent(), Buffer.from([0x7b, 0x22, 0xff, 0x7d]));
      await expect(carryTranscript(request, deps)).rejects.toMatchObject({ reason: "transcript_not_text" });
      expect(await destTree()).toEqual([]);
    });
  });

  it("throws a RangeError before anything runs when both ends are the Mac", async () => {
    await expect(carryTranscript({ ...request, sourceMachine: "local" }, deps)).rejects.toBeInstanceOf(RangeError);
    const { sourceMachine: _omitted, ...bare } = request;
    await expect(carryTranscript(bare, deps)).rejects.toBeInstanceOf(RangeError);
    expect(await destTree()).toEqual([]);
  });

  it("throws a RangeError before anything runs when neither end is the Mac", async () => {
    await expect(carryTranscript({ ...request, machine: "other" }, deps)).rejects.toBeInstanceOf(RangeError);
    expect(await destTree()).toEqual([]);
  });
});

/**
 * A remote machine that holds its files in memory, so what it serves is never on this host.
 * It answers the few programs a read needs the way GNU `wc -c` and `od` do.
 */
class MemoryRemote implements Machine {
  readonly name: string;
  readonly files = new Map<string, Buffer>();
  readonly calls: string[][] = [];
  /** Runs after each `od` answers, so a test can change the file between two reads. */
  afterOd: (() => void) | undefined;

  constructor(name: string) {
    this.name = name;
  }

  async exec(argv: readonly string[]): Promise<ExecResult> {
    this.calls.push([...argv]);
    const [program, ...args] = argv;
    const path = args.at(-1) ?? "";
    const data = this.files.get(path);
    if (data === undefined) return { code: 1, stdout: "", stderr: `${program}: ${path}: No such file or directory` };
    if (program === "wc") return { code: 0, stdout: `${data.length} ${path}\n`, stderr: "" };
    if (program === "od") {
      const skip = Number(args[args.indexOf("-j") + 1]);
      const count = Number(args[args.indexOf("-N") + 1]);
      const hex = [...data.subarray(skip, skip + count)].map((byte) => byte.toString(16).padStart(2, "0"));
      const rows: string[] = [];
      for (let at = 0; at < hex.length; at += 16) rows.push(` ${hex.slice(at, at + 16).join(" ")}`);
      this.afterOd?.();
      return { code: 0, stdout: rows.length === 0 ? "" : `${rows.join("\n")}\n`, stderr: "" };
    }
    return { code: 127, stdout: "", stderr: `${program}: not found` };
  }

  async home(): Promise<string> {
    return "/home/box";
  }

  async readFile(path: string): Promise<string> {
    const data = this.files.get(path);
    if (data === undefined) throw new MachineError(this.name, "ENOENT", `read ${path}`);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw new MachineError(this.name, "not_text", `${path} is not valid UTF-8`);
    }
  }

  async writeFile(): Promise<void> {
    throw new MachineError(this.name, "failed", "this remote is read only");
  }

  async realpath(path: string): Promise<string> {
    if ((await this.kind(path)) === undefined) throw new MachineError(this.name, "ENOENT", `realpath ${path}`);
    return path;
  }

  async entries(dir: string): Promise<readonly Entry[]> {
    const found = new Map<string, EntryKind>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(`${dir}/`)) continue;
      const parts = file.slice(dir.length + 1).split("/");
      for (let depth = 1; depth < parts.length; depth += 1) found.set(`${dir}/${parts.slice(0, depth).join("/")}`, "dir");
      found.set(file, "file");
    }
    return [...found].map(([path, kind]) => ({ path, kind })).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async kind(path: string): Promise<EntryKind | undefined> {
    if (this.files.has(path)) return "file";
    return [...this.files.keys()].some((file) => file.startsWith(`${path}/`)) ? "dir" : undefined;
  }

  async makeTempDir(): Promise<string> {
    return "/tmp/unused";
  }

  async remove(): Promise<void> {}
}

describe("carryTranscript from a remote source that holds its own files", () => {
  const CONFIG = "/remote/cfg";
  const FILE = `${CONFIG}/projects/p/s1.jsonl`;
  const AGENT = `${CONFIG}/projects/p/s1/subagents/a.jsonl`;
  const mac = new LocalMachine();
  let root: string;
  let destConfigDir: string;
  let remote: MemoryRemote;
  let request: CarryRequest;
  let deps: CarryDeps;

  const landed = (path: string) => join(destConfigDir, path.slice(CONFIG.length));
  const destTree = async () => (await mac.entries(destConfigDir).catch(() => [])).map((entry) => entry.path);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "carry-memory-"));
    destConfigDir = join(root, "dest-cfg");
    remote = new MemoryRemote("dev");
    remote.files.set(FILE, Buffer.from('{"cwd":"/home/box/served"}\n'));
    remote.files.set(AGENT, Buffer.from('{"cwd":"/home/box/agent"}\n'));
    request = {
      machine: "local",
      sourceMachine: "dev",
      transcript: { file: FILE, dir: `${CONFIG}/projects/p/s1` },
      sourceConfigDir: CONFIG,
      sourceHome: "/home/box",
      destConfigDir,
      destHome: "/Users/mac",
    };
    deps = { hc: fakeHc().hc, machine: (name) => (name === "local" ? mac : remote) };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lands what the source machine served, which is not on this host", async () => {
    const result = await carryTranscript(request, deps);
    expect(result.written).toEqual([landed(FILE), landed(AGENT)]);
    expect(await readFile(landed(FILE), "utf8")).toBe('{"cwd":"/Users/mac/served"}\n');
    expect(await readFile(landed(AGENT), "utf8")).toBe('{"cwd":"/Users/mac/agent"}\n');
  });

  it("carries a transcript of several read ranges with multi-byte characters across every boundary, byte for byte", async () => {
    const line = '{"cwd":"/home/box/é","t":"😀ü€"}\n';
    // The odd line length shifts the characters through every offset a range boundary can fall on.
    const body = Buffer.from(`${line.repeat(80_000)}{"last":"😀"}`);
    expect(body.length).toBeGreaterThan(2.5 * 1024 * 1024);
    remote.files.set(FILE, body);
    await carryTranscript(request, deps);
    const expected = Buffer.from(body.toString("utf8").replaceAll("/home/box", "/Users/mac"));
    expect((await readFile(landed(FILE))).equals(expected)).toBe(true);
    expect(remote.calls.filter((call) => call[0] === "od").length).toBeGreaterThan(1);
  });

  it("refuses a byte that is not text deep in a large transcript and writes nothing", async () => {
    const body = Buffer.concat([Buffer.from('{"a":"x"}\n'.repeat(300_000)), Buffer.from([0xff]), Buffer.from("\n")]);
    remote.files.set(FILE, body);
    await expect(carryTranscript(request, deps)).rejects.toMatchObject({ reason: "transcript_not_text" });
    expect(await destTree()).toEqual([]);
  });

  it("refuses a line longer than the chunk cap and writes nothing", async () => {
    remote.files.set(FILE, Buffer.from(`${"x".repeat(7 * 1024 * 1024 + 1)}\n`));
    await expect(carryTranscript(request, deps)).rejects.toMatchObject({ reason: "transcript_line_too_long" });
    expect(await destTree()).toEqual([]);
  });
});

describe("carryTranscript when hc fails", () => {
  const unreachable = () => new HcError("hc exec: machine unreachable");
  const rejectsUnreachable = async (pending: Promise<unknown>) => {
    await expect(pending).rejects.toBeInstanceOf(HcError);
    await expect(pending).rejects.toThrow(/hc exec: machine unreachable/);
  };
  let root: string;
  let destConfigDir: string;
  let sourceRequest: CarryRequest;
  let localSourceRequest: CarryRequest;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "carry-hcfail-"));
    destConfigDir = join(root, "dest-cfg");
    const config = join(root, "src-cfg");
    const file = join(config, "projects/p/s1.jsonl");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"cwd":"/Users/mac/x"}\n');
    await writeFile(join(config, "projects/p/s2.jsonl"), "{}\n");
    localSourceRequest = {
      machine: "dest",
      transcript: { file },
      sourceConfigDir: config,
      sourceHome: "/Users/mac",
      destConfigDir: "/dest/cfg",
      destHome: "/home/box",
    };
    sourceRequest = {
      machine: "local",
      sourceMachine: "dev",
      transcript: { file },
      sourceConfigDir: config,
      sourceHome: "/home/box",
      destConfigDir,
      destHome: "/Users/mac",
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects HcError when the first call to an hc destination fails", async () => {
    const { hc, calls } = fakeHc(() => {
      throw unreachable();
    });
    await rejectsUnreachable(carryTranscript(localSourceRequest, { hc }));
    expect(verbs(calls)).toEqual(["mkdir"]);
  });

  it("rejects HcError and removes the temporary file when a chunk write to an hc destination throws", async () => {
    const { hc, calls } = fakeHc((call) => {
      if (call.argv[0] === "dd") throw unreachable();
      return isExistenceCheck(call) ? { code: 1 } : undefined;
    });
    await rejectsUnreachable(carryTranscript(localSourceRequest, { hc }));
    expect(calls.at(-1)?.argv.slice(0, 3)).toEqual(["rm", "-f", "--"]);
  });

  it("rejects HcError and removes the temporary file when the final rename throws", async () => {
    const { hc, calls } = fakeHc((call) => {
      if (call.argv[0] === "mv") throw unreachable();
      return isExistenceCheck(call) ? { code: 1 } : undefined;
    });
    await rejectsUnreachable(carryTranscript(localSourceRequest, { hc }));
    expect(calls.at(-1)?.argv.slice(0, 3)).toEqual(["rm", "-f", "--"]);
  });

  it("rejects HcError from the undo when the put-back throws", async () => {
    const ok = fakeHc((call) => (isExistenceCheck(call) ? { code: 0 } : undefined));
    const result = await carryTranscript(localSourceRequest, { hc: ok.hc });
    const broken = fakeHc((call) => {
      if (call.argv[0] === "mv") throw unreachable();
      return undefined;
    });
    await rejectsUnreachable(undoTranscriptCarry(result, { hc: broken.hc }));
  });

  /** An hc that answers the calls before the range read the way GNU tools do, then lets `behave` decide wc and od. */
  function sourceHc(behave: (program: string) => Partial<HcExecResult> | undefined) {
    return fakeHc((call) => {
      const path = call.argv.at(-1) ?? "";
      if (call.argv[0] === "realpath") return { stdout: `${path}\0` };
      if (call.argv[0] === "find") return { stdout: "f" };
      return behave(call.argv[0] ?? "");
    });
  }

  it.each(["wc", "od"])("rejects HcError naming the failure when %s on an hc source throws, writing nothing", async (program) => {
    const { hc, calls } = sourceHc((name) => {
      if (name === program) throw unreachable();
      return name === "wc" ? { stdout: "4 file\n" } : { stdout: " 7b 7d 0a 0a\n" };
    });
    const failure = carryTranscript(sourceRequest, { hc });
    await expect(failure).rejects.toBeInstanceOf(HcError);
    await expect(failure).rejects.toThrow(/hc exec: machine unreachable/);
    expect(verbs(calls)).toContain(program);
    await expect(mac.entries(destConfigDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects HcError naming the failure when the first call to an hc source throws", async () => {
    const { hc } = fakeHc(() => {
      throw unreachable();
    });
    const failure = carryTranscript(sourceRequest, { hc });
    await expect(failure).rejects.toBeInstanceOf(HcError);
    await expect(failure).rejects.toThrow(/hc exec: machine unreachable/);
  });

  it("keeps a failure of the Mac's own program a MachineError, not an HcError", async () => {
    const mac = new LocalMachine();
    const failing = new NamedMachine("local", mac);
    failing.exec = async () => {
      throw new MachineError("local", "exec_failed", "mkdir: the program could not run");
    };
    const failure = carryTranscript(sourceRequest, { hc: fakeHc().hc, machine: (name) => (name === "local" ? failing : new NamedMachine(name, mac)) });
    await expect(failure).rejects.toBeInstanceOf(MachineError);
    await expect(failure).rejects.toMatchObject({ code: "exec_failed" });
  });

  it("rejects HcError when a remote file grows while it is read", async () => {
    const remote = new MemoryRemote("dev");
    const file = "/remote/cfg/projects/p/s1.jsonl";
    remote.files.set(file, Buffer.from('{"a":1}\n'));
    remote.afterOd = () => remote.files.set(file, Buffer.from('{"a":1}\n{"b":2}\n'));
    const failure = carryTranscript(
      { ...sourceRequest, sourceMachine: "dev", sourceConfigDir: "/remote/cfg", transcript: { file } },
      { hc: fakeHc().hc, machine: (name) => (name === "local" ? mac : remote) },
    );
    await expect(failure).rejects.toBeInstanceOf(HcError);
    await expect(failure).rejects.toThrow(/changed while it was read/);
    await expect(mac.entries(destConfigDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  const mac = new LocalMachine();
});
