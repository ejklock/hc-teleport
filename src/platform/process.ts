import { execFile } from "node:child_process";

export const PROCESS_TIMEOUT_MS = 15_000;
export const PROCESS_MAX_BUFFER = 16 * 1024 * 1024;

export type Runner = (file: string, args: readonly string[]) => Promise<string>;

export class ProcessError extends Error {
  readonly command: string;

  constructor(command: string, detail: string) {
    super(`${command}: ${detail}`);
    this.name = "ProcessError";
    this.command = command;
  }
}

/** Runs a program without a shell and resolves with its stdout; any failure, a timeout included, rejects. */
export function processRunner(timeoutMs: number = PROCESS_TIMEOUT_MS): Runner {
  return (file, args) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, maxBuffer: PROCESS_MAX_BUFFER, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          const detail = stderr.trim() || error.message;
          reject(new ProcessError([file, ...args].join(" "), detail));
        },
      );
    });
}

export const runProcess: Runner = processRunner();
