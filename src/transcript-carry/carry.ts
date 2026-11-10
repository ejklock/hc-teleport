import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { HcError, type Hc } from "../platform/hc.ts";
import { rewriteHome } from "./rewrite.ts";

/** Room under hc's 8 MiB cap on what one `hc exec` takes on stdin. */
const CHUNK_BYTES = 7 * 1024 * 1024;
const APPEND_TIMEOUT_S = 120;

export type CarryRefusalReason =
  | "transcript_outside_config"
  | "transcript_not_text"
  | "transcript_line_too_long"
  | "transcript_missing";

/** The carry stopped before writing anything because the source is not one it may carry. */
export class TranscriptCarryError extends Error {
  readonly reason: CarryRefusalReason;

  constructor(reason: CarryRefusalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "TranscriptCarryError";
    this.reason = reason;
  }
}

export type CarryRequest = {
  /** The hc machine that receives the files. */
  machine: string;
  /** Absolute source paths under `sourceConfigDir`. */
  transcript: { file: string; dir?: string };
  sourceConfigDir: string;
  sourceHome: string;
  destConfigDir: string;
  destHome: string;
};

export type CarryDeps = { hc: Pick<Hc, "exec"> };

export type CarryResult = {
  machine: string;
  destConfigDir: string;
  /** Every destination file the carry placed. */
  written: string[];
  /** Files that existed before; `keptAt` holds the previous content until an undo restores it. */
  replaced: { path: string; keptAt: string }[];
  /** Places in the carried files that already held the destination home before the rewrite. */
  destHomeCount: number;
};

type Prepared = { destPath: string; chunks: string[] };

/**
 * Writes the transcript and the files under its sibling directory to the same relative
 * paths under the destination config directory, with the source home rewritten to the
 * destination home. Each file arrives by rename, so a reader sees the old file or the
 * whole new one; a failure part way puts back what was already placed.
 */
export async function carryTranscript(request: CarryRequest, deps: CarryDeps): Promise<CarryResult> {
  assertAbsolute(request.destConfigDir, "destination config directory");
  const sources = await collectSources(request);
  let destHomeCount = 0;
  const prepared: Prepared[] = [];
  for (const source of sources) {
    const rewritten = rewriteHome(await readText(source), request.sourceHome, request.destHome);
    destHomeCount += rewritten.existing;
    prepared.push({
      destPath: join(request.destConfigDir, relative(request.sourceConfigDir, source)),
      chunks: toChunks(rewritten.text, source),
    });
  }

  const result: CarryResult = { machine: request.machine, destConfigDir: request.destConfigDir, written: [], replaced: [], destHomeCount };
  try {
    for (const file of prepared) await place(file, result, deps);
  } catch (error) {
    await undoTranscriptCarry(result, deps).catch(() => undefined);
    throw error;
  }
  return result;
}

/** Removes the files a carry created and puts back the ones it replaced; running it again does nothing. */
export async function undoTranscriptCarry(result: CarryResult, deps: CarryDeps): Promise<void> {
  const remote = new Remote(result.machine, deps);
  const replacedPaths = new Set(result.replaced.map((entry) => entry.path));
  for (const entry of result.replaced) {
    assertInside(result.destConfigDir, entry.path);
    assertInside(result.destConfigDir, entry.keptAt);
    if (await remote.exists(entry.keptAt)) await remote.run(["mv", "-f", "--", entry.keptAt, entry.path]);
  }
  for (const path of result.written) {
    assertInside(result.destConfigDir, path);
    if (!replacedPaths.has(path)) await remote.run(["rm", "-f", "--", path]);
  }
}

async function place(file: Prepared, result: CarryResult, deps: CarryDeps): Promise<void> {
  assertInside(result.destConfigDir, file.destPath);
  const remote = new Remote(result.machine, deps);
  const id = randomBytes(6).toString("hex");
  const temporary = `${file.destPath}.teleport-${id}.tmp`;
  await remote.run(["mkdir", "-p", "--", dirname(file.destPath)]);
  try {
    for (const chunk of file.chunks) {
      // dd appends without a shell; the temporary name is new, so the first chunk creates it.
      await remote.run(["dd", `of=${temporary}`, "oflag=append", "conv=notrunc", "status=none"], chunk);
    }
    if (await remote.exists(file.destPath)) {
      const keptAt = `${file.destPath}.teleport-${id}.prev`;
      // A hard link keeps the old content reachable while the rename below swaps the name at once.
      await remote.run(["ln", "--", file.destPath, keptAt]);
      result.replaced.push({ path: file.destPath, keptAt });
    }
    await remote.run(["mv", "-f", "--", temporary, file.destPath]);
    result.written.push(file.destPath);
  } catch (error) {
    await remote.run(["rm", "-f", "--", temporary]).catch(() => undefined);
    throw error;
  }
}

class Remote {
  readonly #machine: string;
  readonly #deps: CarryDeps;

  constructor(machine: string, deps: CarryDeps) {
    this.#machine = machine;
    this.#deps = deps;
  }

  async run(argv: readonly string[], stdin?: string): Promise<string> {
    const reply = await this.#exec(argv, stdin);
    if (reply.code !== 0) throw new HcError(`${argv[0]} on ${this.#machine} exited ${reply.code}: ${reply.stderr.trim()}`);
    return reply.stdout;
  }

  /** `test` answers by exit code (0 present, 1 absent), so the message language never matters; a dangling symlink counts as present. */
  async exists(path: string): Promise<boolean> {
    const reply = await this.#exec(["test", "-e", path, "-o", "-L", path]);
    if (reply.code === 0 || reply.code === 1) return reply.code === 0;
    throw new HcError(`test ${path} on ${this.#machine} exited ${reply.code}: ${reply.stderr.trim()}`);
  }

  #exec(argv: readonly string[], stdin?: string) {
    return this.#deps.hc.exec(argv, {
      on: this.#machine,
      timeout: APPEND_TIMEOUT_S,
      ...(stdin === undefined ? {} : { stdin }),
    });
  }
}

async function collectSources(request: CarryRequest): Promise<string[]> {
  const { file, dir } = request.transcript;
  const outside = (detail: string) => new TranscriptCarryError("transcript_outside_config", detail);
  assertInside(request.sourceConfigDir, file, outside);
  if (dir !== undefined) assertInside(request.sourceConfigDir, dir, outside);
  const configReal = await realpath(request.sourceConfigDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new TranscriptCarryError("transcript_missing", `${file}: the config directory does not exist`);
    throw error;
  });
  const found = [file];
  await vet(file, request.sourceConfigDir, configReal, "file");
  if (dir !== undefined && (await vet(dir, request.sourceConfigDir, configReal, "dir"))) {
    found.push(...(await walk(dir, request.sourceConfigDir, configReal)));
  }
  return found;
}

/** Refuses a path that is a symlink or resolves outside the config directory; false when an optional directory is absent. */
async function vet(path: string, configDir: string, configReal: string, kind: "file" | "dir"): Promise<boolean> {
  assertInside(configDir, path, (detail) => new TranscriptCarryError("transcript_outside_config", detail));
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined) {
    if (kind === "file") throw new TranscriptCarryError("transcript_missing", path);
    return false;
  }
  if (stat.isSymbolicLink()) throw new TranscriptCarryError("transcript_outside_config", `${path} is a symlink`);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new TranscriptCarryError("transcript_missing", `${path} is not a regular ${kind === "file" ? "file" : "directory"}`);
  assertInside(configReal, await realpath(path), (detail) => new TranscriptCarryError("transcript_outside_config", detail));
  return true;
}

/** Every regular file under `dir`, in path order; a symlink anywhere in the tree is refused, and other kinds of entry are left out. */
async function walk(dir: string, configDir: string, configReal: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const paths = entries.map((entry) => ({ entry, path: join(entry.parentPath, entry.name) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const files: string[] = [];
  for (const { entry, path } of paths) {
    if (entry.isSymbolicLink()) throw new TranscriptCarryError("transcript_outside_config", `${path} is a symlink`);
    if (!entry.isFile()) continue;
    await vet(path, configDir, configReal, "file");
    files.push(path);
  }
  return files;
}

async function readText(path: string): Promise<string> {
  try {
    // ignoreBOM keeps a leading byte-order mark in the text, so the bytes come back as they were.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(path));
  } catch (error) {
    if (error instanceof TypeError) throw new TranscriptCarryError("transcript_not_text", `${path} is not valid UTF-8`);
    throw error;
  }
}

/** Splits on line ends so no chunk cuts a line, and none passes the stdin cap. */
function toChunks(text: string, source: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const line = text.slice(start, newline === -1 ? text.length : newline + 1);
    start += line.length;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > CHUNK_BYTES) throw new TranscriptCarryError("transcript_line_too_long", `a line of ${source} is ${bytes} bytes`);
    if (size + bytes > CHUNK_BYTES) {
      chunks.push(current.join(""));
      current = [];
      size = 0;
    }
    current.push(line);
    size += bytes;
  }
  chunks.push(current.join(""));
  return chunks;
}

function assertAbsolute(path: string, what: string): void {
  if (!isAbsolute(path)) throw new RangeError(`the ${what} must be absolute, got ${JSON.stringify(path)}`);
}

function assertInside(base: string, path: string, fail: (detail: string) => Error = (detail) => new RangeError(detail)): void {
  const rel = relative(base, path);
  if (!isAbsolute(path) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw fail(`${path} is not under ${base}`);
  }
}
