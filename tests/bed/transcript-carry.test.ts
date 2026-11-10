import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bed, BED_START_TIMEOUT_MS, REPO_MOUNT } from "./bed.ts";

const SOURCE_HOME = "/Users/mac";
const DEST_HOME = "/home/box";
const MEGABYTE = 1024 * 1024;
const HOME_MARK = "@HOME@";

type Seed = { path: string; template?: string; repeat?: number; bytesHex?: string };
type Seeded = { path: string; sourceSha: string; expectedSha: string; size: number };
type Carried = {
  machine: string;
  written: string[];
  replaced: { path: string; keptAt: string }[];
  destHomeCount: number;
};

/** Runs on source: seeds files, runs the carry or its undo through the real hc, and prints the outcome as JSON. */
const DRIVER = `
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { carryTranscript, undoTranscriptCarry, TranscriptCarryError } from "${REPO_MOUNT}/src/transcript-carry/index.ts";
import { Hc } from "${REPO_MOUNT}/src/platform/hc.ts";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const { op, input } = JSON.parse(readFileSync(0, "utf8"));
try {
  if (op === "seed") {
    const seeded = input.files.map((file) => {
      const template = file.template ?? "";
      const body = template.repeat(file.repeat ?? 1);
      const data = file.bytesHex === undefined ? Buffer.from(body.replaceAll("${HOME_MARK}", "${SOURCE_HOME}")) : Buffer.from(file.bytesHex, "hex");
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, data);
      const expected = Buffer.from(body.replaceAll("${HOME_MARK}", "${DEST_HOME}"));
      return { path: file.path, sourceSha: sha(data), expectedSha: sha(expected), size: expected.length };
    });
    process.stdout.write(JSON.stringify({ ok: seeded }));
  } else if (op === "sha") {
    process.stdout.write(JSON.stringify({ ok: input.paths.map((path) => sha(readFileSync(path))) }));
  } else {
    const deps = { hc: new Hc() };
    const value = op === "carry" ? await carryTranscript(input, deps) : await undoTranscriptCarry(input, deps);
    process.stdout.write(JSON.stringify({ ok: value ?? null }));
  }
} catch (error) {
  const reason = error instanceof TranscriptCarryError ? error.reason : undefined;
  process.stdout.write(JSON.stringify({ failed: String(error?.message ?? error), reason }));
}
`;

let counter = 0;

describe("transcript carry through the real hc", () => {
  let bed: Bed;

  beforeAll(async () => {
    bed = await Bed.start();
  }, BED_START_TIMEOUT_MS);

  afterAll(async () => {
    await bed?.stop();
  });

  async function drive(op: string, input: unknown): Promise<unknown> {
    const ran = await bed.run("source", ["node", "--input-type=module", "-e", DRIVER], {
      stdin: JSON.stringify({ op, input }),
      timeoutMs: 115_000,
    });
    expect(ran.stderr).toBe("");
    const outcome = JSON.parse(ran.stdout) as { ok?: unknown; failed?: string; reason?: string };
    if (outcome.failed !== undefined) throw Object.assign(new Error(outcome.failed), { reason: outcome.reason });
    return outcome.ok;
  }

  const seed = async (...files: Seed[]) => (await drive("seed", { files })) as Seeded[];

  /** A fresh pair of config directories, so one case never sees another's files. */
  function layout() {
    counter += 1;
    const sourceConfigDir = `${SOURCE_HOME}/cfg-${counter}`;
    const destConfigDir = `${DEST_HOME}/cfg-${counter}`;
    const project = `${sourceConfigDir}/projects/-work-app`;
    const file = `${project}/session-1.jsonl`;
    const input = {
      machine: "dest",
      transcript: { file, dir: `${project}/session-1` },
      sourceConfigDir,
      sourceHome: SOURCE_HOME,
      destConfigDir,
      destHome: DEST_HOME,
    };
    return { sourceConfigDir, destConfigDir, project, file, input, destFile: file.replace(sourceConfigDir, destConfigDir) };
  }

  async function destShas(paths: string[]): Promise<string[]> {
    const shas: string[] = [];
    for (const path of paths) {
      const ran = await bed.run("dest", ["sha256sum", path]);
      expect(ran.code, `${path}: ${ran.stderr}`).toBe(0);
      shas.push(ran.stdout.split(" ")[0] ?? "");
    }
    return shas;
  }

  async function destFiles(dir: string): Promise<string[]> {
    const ran = await bed.run("dest", ["find", dir, "-type", "f"]);
    return ran.code === 0 ? ran.stdout.split("\n").filter((line) => line !== "").sort() : [];
  }

  const line = `{"cwd":"${HOME_MARK}/app","other":"/Users/macbook/x","ü":"é"}\n`;

  it("carries a transcript that has no sibling directory", async () => {
    const t = layout();
    const [seeded] = await seed({ path: t.file, template: line, repeat: 3 });
    const result = (await drive("carry", t.input)) as Carried;
    expect(result.written).toEqual([t.destFile]);
    expect(result.replaced).toEqual([]);
    expect(result.destHomeCount).toBe(0);
    expect(await destShas([t.destFile])).toEqual([seeded?.expectedSha]);
    expect(await drive("sha", { paths: [t.file] })).toEqual([seeded?.sourceSha]);
    expect(await destFiles(t.destConfigDir)).toEqual([t.destFile]);
  });

  it("carries the subagent files with the transcript and nothing else from the config directory", async () => {
    const t = layout();
    const sub = `${t.project}/session-1/subagents`;
    const seeded = await seed(
      { path: t.file, template: line },
      { path: `${sub}/agent-a.jsonl`, template: line, repeat: 2 },
      { path: `${sub}/agent-b.jsonl`, template: "", repeat: 1 },
      { path: `${t.sourceConfigDir}/.credentials.json`, template: '{"token":"x"}' },
      { path: `${t.project}/other-session.jsonl`, template: line },
    );
    const result = (await drive("carry", t.input)) as Carried;
    const expected = [t.file, `${sub}/agent-a.jsonl`, `${sub}/agent-b.jsonl`].map((p) => p.replace(t.sourceConfigDir, t.destConfigDir)).sort();
    expect([...result.written].sort()).toEqual(expected);
    expect(await destFiles(t.destConfigDir)).toEqual(expected);
    expect(await destShas(expected)).toEqual([seeded[0], seeded[1], seeded[2]].map((s) => s?.expectedSha));
  });

  it("carries a 20 MB transcript of short lines byte for byte after the rewrite", async () => {
    const t = layout();
    const [seeded] = await seed({ path: t.file, template: line, repeat: Math.ceil((20 * MEGABYTE) / line.length) });
    expect(seeded?.size).toBeGreaterThan(20 * MEGABYTE);
    await drive("carry", t.input);
    expect(await destShas([t.destFile])).toEqual([seeded?.expectedSha]);
    const size = await bed.run("dest", ["stat", "-c", "%s", t.destFile]);
    expect(Number(size.stdout)).toBe(seeded?.size);
  });

  it("a reader of the target sees a file that is never partial while a 20 MB copy replaces an older one", async () => {
    const t = layout();
    const [seeded] = await seed({ path: t.file, template: line, repeat: Math.ceil((20 * MEGABYTE) / line.length) });
    await bed.run("dest", ["mkdir", "-p", `${t.destConfigDir}/projects/-work-app`]);
    await bed.run("dest", ["tee", t.destFile], { stdin: "older copy\n" });
    const [olderSha] = await destShas([t.destFile]);
    const stopFile = `${t.destConfigDir}/reader-stop`;

    // The reader hashes the target in a loop on dest until the stop file appears; a missing file would print an error instead of a hash.
    const reader = bed.run("dest", ["sh", "-c", 'while [ ! -e "$2" ]; do sha256sum "$1" 2>&1; done', "reader", t.destFile, stopFile], { timeoutMs: 110_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await drive("carry", t.input);
    await bed.run("dest", ["touch", stopFile]);

    const seen = (await reader).stdout.split("\n").filter((entry) => entry !== "");
    const hashes = seen.map((entry) => entry.split(" ")[0]);
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.filter((entry) => !/^[0-9a-f]{64} /.test(entry))).toEqual([]);
    expect(hashes.filter((hash) => hash !== olderSha && hash !== seeded?.expectedSha)).toEqual([]);
    expect(hashes).toContain(olderSha);
    expect(hashes.at(-1)).toBe(seeded?.expectedSha);
  });

  it("carries over an older copy: replaced at once, the previous one kept aside", async () => {
    const t = layout();
    const [seeded] = await seed({ path: t.file, template: line });
    await bed.run("dest", ["mkdir", "-p", `${t.destConfigDir}/projects/-work-app`]);
    await bed.run("dest", ["tee", t.destFile], { stdin: "older copy\n" });
    const result = (await drive("carry", t.input)) as Carried;
    expect(result.replaced).toHaveLength(1);
    expect(result.replaced[0]?.path).toBe(t.destFile);
    const kept = await bed.run("dest", ["cat", result.replaced[0]?.keptAt ?? "missing"]);
    expect(kept.stdout).toBe("older copy\n");
    expect(await destShas([t.destFile])).toEqual([seeded?.expectedSha]);
  });

  it("carries and counts the places that already held the destination home", async () => {
    const t = layout();
    await seed({ path: t.file, template: `{"a":"${DEST_HOME}/x","b":"${HOME_MARK}/y"}\n` });
    const result = (await drive("carry", t.input)) as Carried;
    expect(result.destHomeCount).toBe(1);
  });

  it("undoes a carry: created files removed, replaced files restored, nothing left over", async () => {
    const t = layout();
    const sub = `${t.project}/session-1/subagents/agent-a.jsonl`;
    await seed({ path: t.file, template: line }, { path: sub, template: line });
    await bed.run("dest", ["mkdir", "-p", `${t.destConfigDir}/projects/-work-app`]);
    await bed.run("dest", ["tee", t.destFile], { stdin: "older copy\n" });
    const result = (await drive("carry", t.input)) as Carried;
    expect(await destFiles(t.destConfigDir)).not.toEqual([t.destFile]);

    await drive("undo", result);
    expect(await destFiles(t.destConfigDir)).toEqual([t.destFile]);
    expect((await bed.run("dest", ["cat", t.destFile])).stdout).toBe("older copy\n");

    await expect(drive("undo", result)).resolves.toBeNull();
    expect(await destFiles(t.destConfigDir)).toEqual([t.destFile]);
    expect((await bed.run("dest", ["cat", t.destFile])).stdout).toBe("older copy\n");
  });

  describe("undoes nothing because the carry refuses", () => {
    async function refused(t: ReturnType<typeof layout>, reason: string): Promise<void> {
      await expect(drive("carry", t.input)).rejects.toMatchObject({ reason });
      expect(await destFiles(t.destConfigDir)).toEqual([]);
    }

    it("when the transcript is a symlink", async () => {
      const t = layout();
      const [target] = await seed({ path: `${SOURCE_HOME}/elsewhere-${counter}.jsonl`, template: line });
      await bed.run("source", ["mkdir", "-p", t.project]);
      await bed.run("source", ["ln", "-s", target?.path ?? "", t.file]);
      await refused(t, "transcript_outside_config");
    });

    it("when a file in the sibling directory is a symlink", async () => {
      const t = layout();
      const [target] = await seed({ path: `${SOURCE_HOME}/elsewhere-${counter}.jsonl`, template: line });
      await seed({ path: t.file, template: line });
      await bed.run("source", ["mkdir", "-p", `${t.project}/session-1`]);
      await bed.run("source", ["ln", "-s", target?.path ?? "", `${t.project}/session-1/link.jsonl`]);
      await refused(t, "transcript_outside_config");
    });

    it("when the transcript lies outside the source config directory", async () => {
      const t = layout();
      const outside = `${SOURCE_HOME}/outside-${counter}/session-1.jsonl`;
      await seed({ path: outside, template: line });
      await expect(drive("carry", { ...t.input, transcript: { file: outside } })).rejects.toMatchObject({ reason: "transcript_outside_config" });
      expect(await destFiles(t.destConfigDir)).toEqual([]);
    });

    it("when a file is not valid UTF-8", async () => {
      const t = layout();
      await seed({ path: t.file, template: line }, { path: `${t.project}/session-1/subagents/bad.jsonl`, bytesHex: "7b22ff7d0a" });
      await refused(t, "transcript_not_text");
    });

    it("when a single line is longer than a chunk", async () => {
      const t = layout();
      await seed({ path: t.file, template: "x", repeat: 8 * MEGABYTE });
      await refused(t, "transcript_line_too_long");
    });

    it("when the transcript is missing", async () => {
      const t = layout();
      await refused(t, "transcript_missing");
    });
  });

  describe("from a remote source to the Mac", () => {
    /** A fresh pair of config directories with dest as the source machine and the Mac (`local`) as the destination. */
    function backLayout() {
      counter += 1;
      const sourceConfigDir = `${DEST_HOME}/back-${counter}`;
      const destConfigDir = `${SOURCE_HOME}/back-${counter}`;
      const project = `${sourceConfigDir}/projects/-work-app`;
      const file = `${project}/session-1.jsonl`;
      const input = {
        machine: "local",
        sourceMachine: "dest",
        transcript: { file, dir: `${project}/session-1` },
        sourceConfigDir,
        sourceHome: DEST_HOME,
        destConfigDir,
        destHome: SOURCE_HOME,
      };
      const onMac = (path: string) => path.replace(sourceConfigDir, destConfigDir);
      return { sourceConfigDir, destConfigDir, project, file, input, onMac };
    }

    async function seedOnDest(path: string, text: string): Promise<void> {
      const dir = path.slice(0, path.lastIndexOf("/"));
      expect((await bed.run("dest", ["mkdir", "-p", dir])).code).toBe(0);
      expect((await bed.run("dest", ["tee", path], { stdin: text })).code).toBe(0);
    }

    async function seedOnMac(path: string, text: string): Promise<void> {
      const dir = path.slice(0, path.lastIndexOf("/"));
      expect((await bed.run("source", ["mkdir", "-p", dir])).code).toBe(0);
      expect((await bed.run("source", ["tee", path], { stdin: text })).code).toBe(0);
    }

    async function macFiles(dir: string): Promise<string[]> {
      const ran = await bed.run("source", ["find", dir, "-type", "f"]);
      return ran.code === 0 ? ran.stdout.split("\n").filter((entry) => entry !== "").sort() : [];
    }

    const text = (home: string) => `{"cwd":"${home}/app","other":"/home/boxer/x","ü":"é"}\n`;

    it("carries the transcript and its subagent folder, with the Mac home in place of the remote one", async () => {
      const t = backLayout();
      const agent = `${t.project}/session-1/subagents/agent-a.jsonl`;
      await seedOnDest(t.file, text(DEST_HOME));
      await seedOnDest(agent, text(DEST_HOME).repeat(3));
      await seedOnDest(`${t.sourceConfigDir}/.credentials.json`, '{"token":"x"}');
      const result = (await drive("carry", t.input)) as Carried;
      expect([...result.written].sort()).toEqual([t.onMac(t.file), t.onMac(agent)].sort());
      expect((await bed.run("source", ["cat", t.onMac(t.file)])).stdout).toBe(text(SOURCE_HOME));
      expect((await bed.run("source", ["cat", t.onMac(agent)])).stdout).toBe(text(SOURCE_HOME).repeat(3));
      expect(await macFiles(t.destConfigDir)).toEqual([t.onMac(t.file), t.onMac(agent)].sort());
    });

    /** Writes a file on dest piece by piece, each piece under what one `hc exec` takes on stdin. */
    async function seedLargeOnDest(path: string, pieces: string[]): Promise<void> {
      expect((await bed.run("dest", ["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))])).code).toBe(0);
      expect((await bed.run("dest", ["rm", "-f", path])).code).toBe(0);
      for (const piece of pieces) expect((await bed.run("dest", ["tee", "-a", path], { stdin: piece, timeoutMs: 115_000 })).code).toBe(0);
    }

    it("carries a 20 MB transcript past hc's read cap with multi-byte characters on every range boundary, byte for byte", async () => {
      const t = backLayout();
      // Filler of 0 to 6 bytes in front of each line moves the multi-byte characters across every offset a boundary can fall on.
      const lines: string[] = [];
      let size = 0;
      for (let index = 0; size < 20 * MEGABYTE; index += 1) {
        const lineText = `{"cwd":"${DEST_HOME}/é","t":"😀ü€${"x".repeat(index % 7)}","n":${index}}\n`;
        lines.push(lineText);
        size += Buffer.byteLength(lineText);
      }
      const original = lines.join("").slice(0, -1);
      const pieces: string[] = [];
      for (let at = 0; at < lines.length; at += 40_000) pieces.push(lines.slice(at, at + 40_000).join(""));
      pieces[pieces.length - 1] = (pieces.at(-1) ?? "").slice(0, -1);
      await seedLargeOnDest(t.file, pieces);
      await drive("carry", t.input);
      const expected = Buffer.from(original.replaceAll(`${DEST_HOME}/`, `${SOURCE_HOME}/`));
      const landed = await bed.run("source", ["sha256sum", t.onMac(t.file)]);
      expect(landed.stdout.split(" ")[0]).toBe(createHash("sha256").update(expected).digest("hex"));
      const bytes = await bed.run("source", ["stat", "-c", "%s", t.onMac(t.file)]);
      expect(Number(bytes.stdout)).toBe(expected.length);
    });

    it("refuses a byte that is not UTF-8 deep in a large remote transcript and writes nothing", async () => {
      const t = backLayout();
      await seedLargeOnDest(t.file, [text(DEST_HOME).repeat(100_000)]);
      expect((await bed.run("dest", ["sh", "-c", "printf '\\377\\n' >> \"$1\"", "sh", t.file])).code).toBe(0);
      await expect(drive("carry", t.input)).rejects.toMatchObject({ reason: "transcript_not_text" });
      expect(await macFiles(t.destConfigDir)).toEqual([]);
    });

    it("refuses a remote line longer than a chunk and writes nothing", async () => {
      const t = backLayout();
      expect((await bed.run("dest", ["mkdir", "-p", t.project])).code).toBe(0);
      expect((await bed.run("dest", ["sh", "-c", "head -c 8388608 /dev/zero | tr '\\0' x > \"$1\"", "sh", t.file])).code).toBe(0);
      await expect(drive("carry", t.input)).rejects.toMatchObject({ reason: "transcript_line_too_long" });
      expect(await macFiles(t.destConfigDir)).toEqual([]);
    });

    it("refuses a symlink in the remote subagent folder and writes nothing", async () => {
      const t = backLayout();
      await seedOnDest(t.file, text(DEST_HOME));
      await seedOnDest(`${t.project}/elsewhere.jsonl`, text(DEST_HOME));
      expect((await bed.run("dest", ["mkdir", "-p", `${t.project}/session-1`])).code).toBe(0);
      expect((await bed.run("dest", ["ln", "-s", `${t.project}/elsewhere.jsonl`, `${t.project}/session-1/link.jsonl`])).code).toBe(0);
      await expect(drive("carry", t.input)).rejects.toMatchObject({ reason: "transcript_outside_config" });
      expect(await macFiles(t.destConfigDir)).toEqual([]);
    });

    it("undoes the carry: created files removed, a replaced file restored", async () => {
      const t = backLayout();
      const agent = `${t.project}/session-1/subagents/agent-a.jsonl`;
      await seedOnDest(t.file, text(DEST_HOME));
      await seedOnDest(agent, text(DEST_HOME));
      await seedOnMac(t.onMac(t.file), "older copy\n");
      const result = (await drive("carry", t.input)) as Carried;
      expect(result.replaced).toHaveLength(1);
      expect((await bed.run("source", ["cat", t.onMac(t.file)])).stdout).toBe(text(SOURCE_HOME));

      await drive("undo", result);
      expect(await macFiles(t.destConfigDir)).toEqual([t.onMac(t.file)]);
      expect((await bed.run("source", ["cat", t.onMac(t.file)])).stdout).toBe("older copy\n");
    });
  });
});
