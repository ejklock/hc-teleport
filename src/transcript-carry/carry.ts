import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { HcError, type Hc } from "../platform/hc.ts";
import { HcMachine, LocalMachine, MachineError, type Machine } from "../platform/machine.ts";
import { rewriteHome } from "./rewrite.ts";

/** Room under hc's 8 MiB cap on what one `hc exec` takes on stdin. */
const CHUNK_BYTES = 7 * 1024 * 1024;
const APPEND_TIMEOUT_S = 120;
/** Bytes read from a remote file by one program, so the hex it prints stays under hc's output cap. */
const READ_RANGE_BYTES = 1024 * 1024;
const LOCAL = "local";

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

/** The carry could not put back what it had changed; `left` names each destination path not restored. */
export class TranscriptPutBackError extends Error {
  readonly left: readonly string[];

  constructor(left: readonly string[], cause: unknown) {
    super(`the transcript files could not be put back: ${left.join("; ")}`, { cause });
    this.name = "TranscriptPutBackError";
    this.left = left;
  }
}

export type CarryRequest = {
  /** The machine that receives the files: `local` for the Mac, else an hc machine. */
  machine: string;
  /** The machine the files are read from; `local` (the Mac) when absent. Exactly one end is the Mac. */
  sourceMachine?: string;
  /** Absolute source paths under `sourceConfigDir`. */
  transcript: { file: string; dir?: string };
  sourceConfigDir: string;
  sourceHome: string;
  destConfigDir: string;
  destHome: string;
};

export type CarryDeps = {
  /** Reaches every hc machine; the carry only runs programs through it. */
  hc: Pick<Hc, "exec">;
  /** Answers for a machine name; by default `local` is the Mac and any other name an hc machine through `hc`. */
  machine?: (name: string) => Machine;
};

export type CarryResult = {
  /** The machine the files were read from. */
  sourceMachine: string;
  /** The machine the files were placed on. */
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
 * destination home. One end is the Mac (`local`) and the other an hc machine. Each file
 * arrives by rename, so a reader sees the old file or the whole new one; a failure part
 * way puts back what was already placed. A put-back that itself fails is reported as a
 * `TranscriptPutBackError` whose `cause` is the placing error and whose `left` names what
 * stays on the destination.
 */
export async function carryTranscript(request: CarryRequest, deps: CarryDeps): Promise<CarryResult> {
  const sourceName = request.sourceMachine ?? LOCAL;
  if ((sourceName === LOCAL) === (request.machine === LOCAL)) {
    throw new RangeError(`exactly one end of a carry is the Mac (${LOCAL}), got source ${JSON.stringify(sourceName)} and destination ${JSON.stringify(request.machine)}`);
  }
  assertAbsolute(request.destConfigDir, "destination config directory");
  const source = machineFor(sourceName, deps);
  const sources = await collectSources(request, source);
  let destHomeCount = 0;
  const prepared: Prepared[] = [];
  for (const path of sources) {
    const rewritten = rewriteHome(await readText(source, path), request.sourceHome, request.destHome);
    destHomeCount += rewritten.existing;
    prepared.push({
      destPath: join(request.destConfigDir, relative(request.sourceConfigDir, path)),
      chunks: toChunks(rewritten.text, path),
    });
  }

  const result: CarryResult = {
    sourceMachine: sourceName,
    machine: request.machine,
    destConfigDir: request.destConfigDir,
    written: [],
    replaced: [],
    destHomeCount,
  };
  try {
    for (const file of prepared) await place(file, result, deps);
  } catch (error) {
    try {
      await undoTranscriptCarry(result, deps);
    } catch (putBack) {
      if (putBack instanceof TranscriptPutBackError) throw new TranscriptPutBackError(putBack.left, error);
    }
    throw error;
  }
  return result;
}

/**
 * Removes the files a carry created and puts back the ones it replaced; running it again does nothing.
 * Every entry is tried even after one fails; the ones left behind come back in a `TranscriptPutBackError`.
 */
export async function undoTranscriptCarry(result: CarryResult, deps: CarryDeps): Promise<void> {
  const remote = new Remote(machineFor(result.machine, deps));
  const replacedPaths = new Set(result.replaced.map((entry) => entry.path));
  const left: string[] = [];
  let first: unknown;
  const attempt = async (what: string, step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      first ??= error;
      left.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const entry of result.replaced) {
    await attempt(`${entry.path} not restored, the original stays at ${entry.keptAt}`, async () => {
      assertInside(result.destConfigDir, entry.path);
      assertInside(result.destConfigDir, entry.keptAt);
      if (await remote.exists(entry.keptAt)) await remote.run(["mv", "-f", "--", entry.keptAt, entry.path]);
    });
  }
  for (const path of result.written) {
    if (replacedPaths.has(path)) continue;
    await attempt(`${path} not removed`, async () => {
      assertInside(result.destConfigDir, path);
      await remote.run(["rm", "-f", "--", path]);
    });
  }
  if (left.length > 0) throw new TranscriptPutBackError(left, first);
}

function machineFor(name: string, deps: CarryDeps): Machine {
  const machine = deps.machine === undefined ? defaultMachine(name, deps.hc) : deps.machine(name);
  // Only a failure of hc is an HcError; the Mac's own failures keep the error the Mac raised.
  return name === LOCAL ? machine : new HcFailuresAsHcError(machine);
}

function defaultMachine(name: string, hc: Pick<Hc, "exec">): Machine {
  if (name === LOCAL) return new LocalMachine();
  const unsupported = async (): Promise<never> => {
    throw new MachineError(name, "failed", "the carry reads and writes remote files through programs, not through hc file calls");
  };
  return new HcMachine(name, { exec: (argv, options) => hc.exec(argv, options), readFile: unsupported, writeFile: unsupported });
}

/** Lets a failure of hc itself surface as the `HcError` callers know, whatever `Machine` wrapped it. */
class HcFailuresAsHcError implements Machine {
  readonly #inner: Machine;
  readonly name: string;

  constructor(inner: Machine) {
    this.#inner = inner;
    this.name = inner.name;
  }

  exec: Machine["exec"] = (argv, options) => this.#guard(() => this.#inner.exec(argv, options));
  home: Machine["home"] = () => this.#guard(() => this.#inner.home());
  readFile: Machine["readFile"] = (path) => this.#guard(() => this.#inner.readFile(path));
  writeFile: Machine["writeFile"] = (path, text) => this.#guard(() => this.#inner.writeFile(path, text));
  realpath: Machine["realpath"] = (path) => this.#guard(() => this.#inner.realpath(path));
  entries: Machine["entries"] = (dir) => this.#guard(() => this.#inner.entries(dir));
  kind: Machine["kind"] = (path) => this.#guard(() => this.#inner.kind(path));
  makeTempDir: Machine["makeTempDir"] = () => this.#guard(() => this.#inner.makeTempDir());
  remove: Machine["remove"] = (path) => this.#guard(() => this.#inner.remove(path));

  async #guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof MachineError && error.code === "exec_failed") throw new HcError(error.message);
      throw error;
    }
  }
}

async function place(file: Prepared, result: CarryResult, deps: CarryDeps): Promise<void> {
  assertInside(result.destConfigDir, file.destPath);
  const destination = machineFor(result.machine, deps);
  const remote = new Remote(destination);
  const id = randomBytes(6).toString("hex");
  const temporary = `${file.destPath}.teleport-${id}.tmp`;
  await remote.run(["mkdir", "-p", "--", dirname(file.destPath)]);
  try {
    if (destination.name === LOCAL) {
      // No stdin cap applies here, and the Mac's dd has no append mode, so the whole file is written at once.
      await destination.writeFile(temporary, file.chunks.join(""));
    } else {
      for (const chunk of file.chunks) {
        // dd appends without a shell; the temporary name is new, so the first chunk creates it.
        await remote.run(["dd", `of=${temporary}`, "oflag=append", "conv=notrunc", "status=none"], chunk);
      }
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

/** Runs the POSIX programs the placing needs on the destination, so they behave the same on the Mac and on an hc machine. */
class Remote {
  readonly #machine: Machine;

  constructor(machine: Machine) {
    this.#machine = machine;
  }

  async run(argv: readonly string[], stdin?: string): Promise<string> {
    const reply = await this.#exec(argv, stdin);
    if (reply.code !== 0) throw new HcError(`${argv[0]} on ${this.#machine.name} exited ${reply.code}: ${reply.stderr.trim()}`);
    return reply.stdout;
  }

  /** `test` answers by exit code (0 present, 1 absent), so the message language never matters; a dangling symlink counts as present. */
  async exists(path: string): Promise<boolean> {
    const reply = await this.#exec(["test", "-e", path, "-o", "-L", path]);
    if (reply.code === 0 || reply.code === 1) return reply.code === 0;
    throw new HcError(`test ${path} on ${this.#machine.name} exited ${reply.code}: ${reply.stderr.trim()}`);
  }

  #exec(argv: readonly string[], stdin?: string) {
    return this.#machine.exec(argv, {
      timeoutSeconds: APPEND_TIMEOUT_S,
      ...(stdin === undefined ? {} : { stdin }),
    });
  }
}

async function collectSources(request: CarryRequest, source: Machine): Promise<string[]> {
  const { file, dir } = request.transcript;
  const outside = (detail: string) => new TranscriptCarryError("transcript_outside_config", detail);
  assertInside(request.sourceConfigDir, file, outside);
  if (dir !== undefined) assertInside(request.sourceConfigDir, dir, outside);
  const configReal = await source.realpath(request.sourceConfigDir).catch((error: unknown) => {
    if (error instanceof MachineError && error.code === "ENOENT") throw new TranscriptCarryError("transcript_missing", `${file}: the config directory does not exist`);
    throw error;
  });
  const found = [file];
  await vet(source, file, request.sourceConfigDir, configReal, "file");
  if (dir !== undefined && (await vet(source, dir, request.sourceConfigDir, configReal, "dir"))) {
    found.push(...(await walk(source, dir, request.sourceConfigDir, configReal)));
  }
  return found;
}

/** Refuses a path that is a symlink or resolves outside the config directory; false when an optional directory is absent. */
async function vet(source: Machine, path: string, configDir: string, configReal: string, kind: "file" | "dir"): Promise<boolean> {
  assertInside(configDir, path, (detail) => new TranscriptCarryError("transcript_outside_config", detail));
  const found = await source.kind(path);
  if (found === undefined) {
    if (kind === "file") throw new TranscriptCarryError("transcript_missing", path);
    return false;
  }
  if (found === "symlink") throw new TranscriptCarryError("transcript_outside_config", `${path} is a symlink`);
  if (found !== kind) throw new TranscriptCarryError("transcript_missing", `${path} is not a regular ${kind === "file" ? "file" : "directory"}`);
  assertInside(configReal, await source.realpath(path), (detail) => new TranscriptCarryError("transcript_outside_config", detail));
  return true;
}

/** Every regular file under `dir`, in path order; a symlink anywhere in the tree is refused, and other kinds of entry are left out. */
async function walk(source: Machine, dir: string, configDir: string, configReal: string): Promise<string[]> {
  const files: string[] = [];
  for (const { path, kind } of await source.entries(dir)) {
    if (kind === "symlink") throw new TranscriptCarryError("transcript_outside_config", `${path} is a symlink`);
    if (kind !== "file") continue;
    await vet(source, path, configDir, configReal, "file");
    files.push(path);
  }
  return files;
}

async function readText(source: Machine, path: string): Promise<string> {
  try {
    // A remote file is read in ranges: one `hc file read` stops at hc's size cap without failing.
    return source.name === LOCAL ? await source.readFile(path) : decodeText(await readRanges(source, path));
  } catch (error) {
    if (error instanceof TypeError) throw new TranscriptCarryError("transcript_not_text", `${path} is not valid UTF-8`);
    if (error instanceof MachineError && error.code === "not_text") throw new TranscriptCarryError("transcript_not_text", `${path} is not valid UTF-8`);
    throw error;
  }
}

/** The whole text is decoded at once, so a character split across two ranges is never decoded alone; ignoreBOM keeps a leading byte-order mark. */
function decodeText(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** The file's bytes, read as hex by `od` in ranges that each fit under hc's output cap. */
async function readRanges(source: Machine, path: string): Promise<Buffer> {
  const remote = new Remote(source);
  const sizeOf = async (): Promise<number> => {
    const counted = /^\s*(\d+)\s/.exec(await remote.run(["wc", "-c", "--", path]));
    if (counted?.[1] === undefined) throw new HcError(`wc -c ${path} on ${source.name} printed no byte count`);
    return Number(counted[1]);
  };
  const size = await sizeOf();
  const parts: Buffer[] = [];
  for (let offset = 0; offset < size; offset += READ_RANGE_BYTES) {
    const count = Math.min(READ_RANGE_BYTES, size - offset);
    const printed = await remote.run(["od", "-An", "-v", "-tx1", "-j", String(offset), "-N", String(count), "--", path]);
    const bytes = printed.split(/\s+/).filter((token) => token !== "");
    if (bytes.length !== count || bytes.some((token) => !/^[0-9a-f]{2}$/.test(token))) {
      throw new HcError(`od ${path} on ${source.name} printed ${bytes.length} bytes for a range of ${count}`);
    }
    parts.push(Buffer.from(bytes.join(""), "hex"));
  }
  // A file that grew or shrank during the read would be carried cut off, so it is refused instead.
  const after = await sizeOf();
  if (after !== size) throw new HcError(`${path} on ${source.name} changed while it was read: ${size} bytes, then ${after}`);
  return Buffer.concat(parts);
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
