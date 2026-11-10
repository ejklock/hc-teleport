import { describe } from "vitest";
import { MachineError, type Entry, type EntryKind, type ExecResult, type Machine, type MachineExecOptions } from "../../src/platform/machine.ts";
import { machineContract } from "../platform/machine-contract.ts";
import { Bed, BED_START_TIMEOUT_MS, REPO_MOUNT } from "./bed.ts";

const DEST_HOME = "/home/box";

/** Runs one `HcMachine` method for dest on source, through the real hc, and prints its outcome as JSON. */
const DRIVER = `
import { readFileSync } from "node:fs";
import { HcMachine, MachineError } from "${REPO_MOUNT}/src/platform/machine.ts";
const { method, args } = JSON.parse(readFileSync(0, "utf8"));
const machine = new HcMachine("dest");
try {
  const value = await machine[method](...args);
  process.stdout.write(JSON.stringify({ ok: value ?? null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ failed: String(error?.message ?? error), code: error instanceof MachineError ? error.code : undefined }));
}
`;

/** The `Machine` for dest as source sees it: every call runs in a process on source that uses the real `HcMachine`. */
class DriverMachine implements Machine {
  readonly name = "dest";
  readonly #bed: Bed;

  constructor(bed: Bed) {
    this.#bed = bed;
  }

  async #call(method: string, ...args: unknown[]): Promise<unknown> {
    const ran = await this.#bed.run("source", ["node", "--input-type=module", "-e", DRIVER], {
      stdin: JSON.stringify({ method, args }),
      timeoutMs: 110_000,
    });
    if (ran.stderr !== "") throw new Error(`the driver wrote to stderr: ${ran.stderr}`);
    const outcome = JSON.parse(ran.stdout) as { ok?: unknown; failed?: string; code?: ConstructorParameters<typeof MachineError>[1] };
    if (outcome.failed === undefined) return outcome.ok;
    if (outcome.code === undefined) throw new Error(outcome.failed);
    throw Object.assign(new MachineError(this.name, outcome.code, ""), { message: outcome.failed });
  }

  exec(argv: readonly string[], options: MachineExecOptions = {}): Promise<ExecResult> {
    return this.#call("exec", argv, options) as Promise<ExecResult>;
  }

  home(): Promise<string> {
    return this.#call("home") as Promise<string>;
  }

  readFile(path: string): Promise<string> {
    return this.#call("readFile", path) as Promise<string>;
  }

  async writeFile(path: string, text: string): Promise<void> {
    await this.#call("writeFile", path, text);
  }

  realpath(path: string): Promise<string> {
    return this.#call("realpath", path) as Promise<string>;
  }

  entries(dir: string): Promise<readonly Entry[]> {
    return this.#call("entries", dir) as Promise<readonly Entry[]>;
  }

  async kind(path: string): Promise<EntryKind | undefined> {
    return ((await this.#call("kind", path)) as EntryKind | null) ?? undefined;
  }

  makeTempDir(): Promise<string> {
    return this.#call("makeTempDir") as Promise<string>;
  }

  async remove(path: string): Promise<void> {
    await this.#call("remove", path);
  }
}

describe("HcMachine against dest through the real hc", () => {
  let bed: Bed | undefined;

  machineContract({
    start: async () => {
      bed = await Bed.start();
      return new DriverMachine(bed);
    },
    stop: async () => {
      await bed?.stop();
    },
    tempRoot: "/tmp",
    home: DEST_HOME,
    startTimeoutMs: BED_START_TIMEOUT_MS,
  });
});
