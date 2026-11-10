import { execFile } from "node:child_process";

export const PROCESS_TIMEOUT_MS = 15_000;
export const PROCESS_MAX_BUFFER = 16 * 1024 * 1024;

/** What one call may set on top of the runner's own defaults. */
export type RunOptions = {
  /** Written to the program's stdin, then the stream ends. */
  input?: string;
  /** Replaces the runner's timeout for this call. */
  timeoutMs?: number;
};

export type Runner = (file: string, args: readonly string[], options?: RunOptions) => Promise<string>;

export class ProcessError extends Error {
  readonly command: string;

  constructor(command: string, detail: string) {
    super(`${command}: ${detail}`);
    this.name = "ProcessError";
    this.command = command;
  }
}

/** Runs a program without a shell and resolves with its stdout; any failure, a timeout included, rejects. A call may bring its own input and timeout. */
export function processRunner(timeoutMs: number = PROCESS_TIMEOUT_MS): Runner {
  return (file, args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        file,
        [...args],
        { timeout: options.timeoutMs ?? timeoutMs, maxBuffer: PROCESS_MAX_BUFFER, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          const detail = stderr.trim() || error.message;
          reject(new ProcessError([file, ...args].join(" "), detail));
        },
      );
      if (options.input !== undefined) {
        // A program that exits without reading its stdin closes the pipe; its exit code reports that.
        child.stdin?.on("error", () => {});
        child.stdin?.end(options.input);
      }
    });
}

export const runProcess: Runner = processRunner();
