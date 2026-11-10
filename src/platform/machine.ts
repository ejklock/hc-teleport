import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, lstat, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import { Hc, HcError } from "./hc.ts";
import { PROCESS_MAX_BUFFER } from "./process.ts";

/** What a machine reports about a path; `other` covers sockets, pipes and devices. */
export type EntryKind = "file" | "dir" | "symlink" | "other";

export type Entry = { path: string; kind: EntryKind };

export type MachineExecOptions = {
  /** The program's working directory; an absolute path. */
  cwd?: string;
  /** Written to the program's stdin, then the stream ends. */
  stdin?: string;
  /** Added to the program's environment for this call only; names are letters, digits and `_`. Values can show in `ps`, so a secret never goes here. */
  env?: Readonly<Record<string, string>>;
  /** Whole seconds from 1 to 600 the program may run; 60 when unset. */
  timeoutSeconds?: number;
};

/** A program's outcome; a non-zero `code` is a result, not a failure. */
export type ExecResult = { code: number; stdout: string; stderr: string };

/**
 * Failures a caller can tell apart by `code`: `not_absolute` for a path that does not start with `/`,
 * `ENOENT` and `ENOTDIR` for a path, `not_text` for a file that is not UTF-8, `exec_failed` for a program
 * that could not run to an exit code, `no_home` for a machine with no absolute home, `unexpected_reply` for a
 * reply that broke the contract, and `failed` for any other refusal by the machine.
 */
export type MachineErrorCode = "not_absolute" | "ENOENT" | "ENOTDIR" | "not_text" | "exec_failed" | "no_home" | "unexpected_reply" | "failed";

export class MachineError extends Error {
  readonly code: MachineErrorCode;
  readonly machine: string;

  constructor(machine: string, code: MachineErrorCode, detail: string) {
    super(`${machine}: ${detail}`);
    this.name = "MachineError";
    this.code = code;
    this.machine = machine;
  }
}

/**
 * One host's programs, text files and folders; the same calls behave the same on the local host and on an hc machine.
 * Every path is absolute: a relative one rejects `not_absolute` before anything runs, because it would mean
 * a different folder on each side.
 */
export interface Machine {
  /** `local` for the host this process runs on, else the hc machine's name. */
  readonly name: string;
  /** Runs a program with no shell. A signal, a timeout or a program that cannot start rejects with a `MachineError` naming the program and the machine. */
  exec(argv: readonly string[], options?: MachineExecOptions): Promise<ExecResult>;
  /** The machine's absolute home directory. */
  home(): Promise<string>;
  /** A text file exactly as stored, a leading byte-order mark included; rejects `ENOENT`, or `not_text` for bytes that are not UTF-8. */
  readFile(path: string): Promise<string>;
  /** Replaces a text file with `text`, making missing folders. */
  writeFile(path: string, text: string): Promise<void>;
  /** The path with every symlink resolved; rejects `ENOENT`. */
  realpath(path: string): Promise<string>;
  /** Every entry under `dir`, recursively and sorted by path, none followed through a symlink; rejects `ENOENT`. */
  entries(dir: string): Promise<readonly Entry[]>;
  /** What `path` is without following a symlink, or `undefined` when nothing is there. */
  kind(path: string): Promise<EntryKind | undefined>;
  /** Creates a fresh folder under the machine's temp folder and resolves its path. */
  makeTempDir(): Promise<string>;
  /** Deletes a folder and everything in it; a path that is not there is fine. */
  remove(path: string): Promise<void>;
}

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEMP_PREFIX = "hc-teleport";

function assertAbsolute(machine: string, path: string): void {
  if (!path.startsWith("/")) throw new MachineError(machine, "not_absolute", `${JSON.stringify(path)} is not an absolute path`);
}

function assertExecRequest(machine: string, argv: readonly string[], options: MachineExecOptions): void {
  if (options.cwd !== undefined) assertAbsolute(machine, options.cwd);
  if (argv.length === 0) throw new MachineError(machine, "exec_failed", "no program to run");
  const seconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_S) {
    throw new MachineError(machine, "exec_failed", `${argv[0]}: the timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT_S}, got ${seconds}`);
  }
  for (const name of Object.keys(options.env ?? {})) {
    if (!ENV_NAME.test(name)) throw new MachineError(machine, "exec_failed", `${argv[0]}: ${JSON.stringify(name)} is not an environment variable name`);
  }
}

async function homeOf(machine: string, run: (argv: readonly string[]) => Promise<ExecResult>): Promise<string> {
  const printed = await run(["printenv", "HOME"]);
  const home = printed.stdout.endsWith("\n") ? printed.stdout.slice(0, -1) : printed.stdout;
  if (printed.code === 0 && posix.isAbsolute(home)) return home;
  throw new MachineError(
    machine,
    "no_home",
    `printenv HOME gave no absolute home directory: exit code ${printed.code}, output ${JSON.stringify(home)}`,
  );
}

function sorted(entries: Entry[]): Entry[] {
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const errnoSchema = z.object({ code: z.string(), message: z.string() });

function localFailure(error: unknown, detail: string): unknown {
  const errno = errnoSchema.safeParse(error);
  if (!errno.success) return error;
  const code = errno.data.code === "ENOENT" || errno.data.code === "ENOTDIR" ? errno.data.code : "failed";
  return new MachineError("local", code, `${detail}: ${errno.data.message}`);
}

function direntKind(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "dir";
  return entry.isFile() ? "file" : "other";
}

const execFailureSchema = z.object({
  code: z.union([z.number(), z.string(), z.null()]).optional(),
  signal: z.string().nullish(),
  killed: z.boolean().optional(),
  message: z.string(),
});

/** The host this process runs on, through `node:child_process` and `node:fs`. */
export class LocalMachine implements Machine {
  readonly name = "local";

  async exec(argv: readonly string[], options: MachineExecOptions = {}): Promise<ExecResult> {
    assertExecRequest(this.name, argv, options);
    const [program = "", ...args] = argv;
    return new Promise((resolve, reject) => {
      const child: ChildProcess = execFile(
        program,
        args,
        {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: { ...process.env, ...options.env },
          timeout: (options.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000,
          killSignal: "SIGKILL",
          maxBuffer: PROCESS_MAX_BUFFER,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error === null) return resolve({ code: 0, stdout, stderr });
          const failure = execFailureSchema.safeParse(error);
          if (failure.success && typeof failure.data.code === "number") {
            return resolve({ code: failure.data.code, stdout, stderr });
          }
          reject(new MachineError(this.name, "exec_failed", `${program}: ${execFailureDetail(failure.success ? failure.data : undefined, options)}`));
        },
      );
      // A program that exits without reading its stdin closes the pipe; its exit code reports that.
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin ?? "");
    });
  }

  home(): Promise<string> {
    return homeOf(this.name, (argv) => this.exec(argv));
  }

  async readFile(path: string): Promise<string> {
    assertAbsolute(this.name, path);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw localFailure(error, `read ${path}`);
    }
    try {
      // ignoreBOM keeps a leading byte-order mark in the text, so the bytes come back as they were.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new MachineError(this.name, "not_text", `${path} is not valid UTF-8`);
    }
  }

  async writeFile(path: string, text: string): Promise<void> {
    assertAbsolute(this.name, path);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    } catch (error) {
      throw localFailure(error, `write ${path}`);
    }
  }

  async realpath(path: string): Promise<string> {
    assertAbsolute(this.name, path);
    try {
      return await realpath(path);
    } catch (error) {
      throw localFailure(error, `realpath ${path}`);
    }
  }

  async entries(dir: string): Promise<readonly Entry[]> {
    assertAbsolute(this.name, dir);
    const found: Entry[] = [];
    try {
      await this.#collect(dir, found);
    } catch (error) {
      throw localFailure(error, `list ${dir}`);
    }
    return sorted(found);
  }

  async kind(path: string): Promise<EntryKind | undefined> {
    assertAbsolute(this.name, path);
    try {
      return direntKind(await lstat(path));
    } catch (error) {
      const errno = errnoSchema.safeParse(error);
      if (errno.success && (errno.data.code === "ENOENT" || errno.data.code === "ENOTDIR")) return undefined;
      throw localFailure(error, `stat ${path}`);
    }
  }

  async makeTempDir(): Promise<string> {
    try {
      return await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}-`));
    } catch (error) {
      throw localFailure(error, "make a temp folder");
    }
  }

  async remove(path: string): Promise<void> {
    assertAbsolute(this.name, path);
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      throw localFailure(error, `remove ${path}`);
    }
  }

  async #collect(dir: string, into: Entry[]): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      const kind = direntKind(item);
      into.push({ path, kind });
      if (kind === "dir") await this.#collect(path, into);
    }
  }
}

function execFailureDetail(failure: z.infer<typeof execFailureSchema> | undefined, options: MachineExecOptions): string {
  if (failure === undefined) return "the program could not run";
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return `the program wrote more than the output limit of ${PROCESS_MAX_BUFFER} bytes`;
  if (failure.killed === true) return `the program outlived its timeout of ${options.timeoutSeconds ?? DEFAULT_TIMEOUT_S} s`;
  if (failure.signal !== undefined && failure.signal !== null) return `the program ended on signal ${failure.signal} with no exit code`;
  return failure.message;
}

const hcFailureSchema = z.object({ error: z.object({ kind: z.string(), message: z.string() }) });

/** The `{"error": …}` JSON hc prints on stderr, which `Hc` carries at the end of its error message. */
function hcFailureKind(error: HcError): string | undefined {
  const start = error.message.lastIndexOf('{"error"');
  if (start < 0) return undefined;
  try {
    const parsed = hcFailureSchema.safeParse(JSON.parse(error.message.slice(start)));
    return parsed.success ? parsed.data.error.kind : undefined;
  } catch {
    return undefined;
  }
}

const HC_FILE_CODES: Readonly<Record<string, MachineErrorCode>> = { not_found: "ENOENT", not_text: "not_text" };

/** `find -printf` of depth, type and path relative to the start, each ended by NUL, so a name may hold any character but NUL. */
const FIND_FORMAT = "%d\\0%y\\0%P\\0";
const findRecordSchema = z.tuple([z.string().regex(/^\d+$/), z.string().length(1), z.string()]);

const findTypeSchema = z.string().length(1);

/** What a failed program's stderr says, read in the C locale: a missing path, a path through a file, or any other refusal. */
function hcFailureCode(reply: ExecResult): "ENOENT" | "ENOTDIR" | "failed" {
  if (reply.stderr.includes(": No such file or directory")) return "ENOENT";
  if (reply.stderr.includes(": Not a directory")) return "ENOTDIR";
  return "failed";
}

const FIND_KINDS: Readonly<Record<string, EntryKind>> = { f: "file", d: "dir", l: "symlink" };

/** An hc machine, through `hc exec`, `hc file read` and `hc file write`, plus GNU `find`, `realpath`, `mktemp` and `rm` on it. */
export class HcMachine implements Machine {
  readonly name: string;
  readonly #hc: Pick<Hc, "exec" | "readFile" | "writeFile">;

  constructor(name: string, hc: Pick<Hc, "exec" | "readFile" | "writeFile"> = new Hc()) {
    this.name = name;
    this.#hc = hc;
  }

  async exec(argv: readonly string[], options: MachineExecOptions = {}): Promise<ExecResult> {
    assertExecRequest(this.name, argv, options);
    try {
      return await this.#hc.exec(argv, {
        on: this.name,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.env === undefined ? {} : { env: options.env }),
        timeout: options.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
      });
    } catch (error) {
      if (error instanceof HcError) throw new MachineError(this.name, "exec_failed", `${argv[0]}: ${error.message}`);
      throw error;
    }
  }

  home(): Promise<string> {
    return homeOf(this.name, (argv) => this.#exec(argv));
  }

  async readFile(path: string): Promise<string> {
    assertAbsolute(this.name, path);
    try {
      return await this.#hc.readFile(path, { on: this.name });
    } catch (error) {
      throw this.#fileFailure(error, `read ${path}`);
    }
  }

  async writeFile(path: string, text: string): Promise<void> {
    assertAbsolute(this.name, path);
    try {
      await this.#hc.writeFile(path, text, { on: this.name });
    } catch (error) {
      throw this.#fileFailure(error, `write ${path}`);
    }
  }

  async realpath(path: string): Promise<string> {
    assertAbsolute(this.name, path);
    const reply = await this.#exec(["realpath", "-ez", "--", path]);
    this.#assertOk(reply, `realpath ${path}`);
    return reply.stdout.endsWith("\0") ? reply.stdout.slice(0, -1) : reply.stdout;
  }

  async entries(dir: string): Promise<readonly Entry[]> {
    assertAbsolute(this.name, dir);
    // -H follows `dir` itself when it is a symlink to a folder, as the local read does; nothing below it is followed.
    // The path starts with `/`, so find can never read it as an option or an operator.
    const reply = await this.#exec(["find", "-H", dir, "-printf", FIND_FORMAT]);
    this.#assertOk(reply, `list ${dir}`);
    const fields = reply.stdout.split("\0");
    fields.pop();
    const found: Entry[] = [];
    for (let at = 0; at < fields.length; at += 3) {
      const record = findRecordSchema.safeParse(fields.slice(at, at + 3));
      if (!record.success) throw new MachineError(this.name, "unexpected_reply", `find ${dir} printed an unexpected shape: ${record.error.message}`);
      const [depth, type, relative] = record.data;
      const kind = FIND_KINDS[type] ?? "other";
      if (depth === "0") {
        if (kind !== "dir") throw new MachineError(this.name, "ENOTDIR", `list ${dir}: not a directory`);
        continue;
      }
      found.push({ path: posix.join(dir, relative), kind });
    }
    return sorted(found);
  }

  async kind(path: string): Promise<EntryKind | undefined> {
    assertAbsolute(this.name, path);
    const reply = await this.#exec(["find", "-P", path, "-maxdepth", "0", "-printf", "%y"]);
    if (reply.code === 1 && hcFailureCode(reply) !== "failed") return undefined;
    this.#assertOk(reply, `stat ${path}`);
    const type = findTypeSchema.safeParse(reply.stdout);
    if (!type.success) throw new MachineError(this.name, "unexpected_reply", `find ${path} printed an unexpected shape: ${JSON.stringify(reply.stdout)}`);
    return FIND_KINDS[type.data] ?? "other";
  }

  async makeTempDir(): Promise<string> {
    const reply = await this.#exec(["mktemp", "-d", "-t", `${TEMP_PREFIX}-XXXXXX`]);
    this.#assertOk(reply, "make a temp folder");
    return reply.stdout.endsWith("\n") ? reply.stdout.slice(0, -1) : reply.stdout;
  }

  async remove(path: string): Promise<void> {
    assertAbsolute(this.name, path);
    this.#assertOk(await this.#exec(["rm", "-rf", "--", path]), `remove ${path}`);
  }

  /** The machine's own programs run with `LC_ALL=C`, so the messages read here are in English whatever the machine's locale. */
  #exec(argv: readonly string[]): Promise<ExecResult> {
    return this.exec(argv, { env: { LC_ALL: "C" } });
  }

  #assertOk(reply: ExecResult, detail: string): void {
    if (reply.code === 0) return;
    throw new MachineError(this.name, hcFailureCode(reply), `${detail}: exit code ${reply.code}: ${reply.stderr.trim()}`);
  }

  #fileFailure(error: unknown, detail: string): unknown {
    if (!(error instanceof HcError)) return error;
    const code = HC_FILE_CODES[hcFailureKind(error) ?? ""] ?? "failed";
    return new MachineError(this.name, code, `${detail}: ${error.message}`);
  }
}
