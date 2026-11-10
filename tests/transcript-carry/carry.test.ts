import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hc, HcExecOptions, HcExecResult } from "../../src/platform/hc.ts";
import { HcError } from "../../src/platform/hc.ts";
import { carryTranscript, TranscriptCarryError, type CarryRequest } from "../../src/transcript-carry/carry.ts";

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
