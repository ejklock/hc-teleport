import { z } from "zod";
import { ProcessError, runProcess, type RunOptions, type Runner } from "./process.ts";

const processSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  pid: z.number().int(),
});

const terminalSchema = z.object({
  address: z.string(),
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  state: z.string(),
  exit_code: z
    .number()
    .nullish()
    .transform((code) => code ?? undefined),
  status: z
    .object({ state: z.string() })
    .nullish()
    .transform((status) => status ?? undefined),
  foreground: processSchema.optional(),
});

const machineSchema = z
  .object({
    name: z.string(),
    state: z.string(),
    target: z.string().optional(),
    via: z.boolean().optional(),
  })
  .transform(({ via, ...machine }) => ({
    ...machine,
    // A machine reached through another hc reports a command in `target`, never a host.
    ...(via === false && machine.target !== undefined ? { sshTarget: machine.target } : {}),
  }));

const machinesSchema = z.object({ machines: z.array(machineSchema) });

const execSchema = z.object({
  code: z.number().int().nullable(),
  signal: z.number().int().nullish(),
  stdout: z.base64(),
  stderr: z.base64(),
  timed_out: z.boolean(),
  truncated: z.boolean(),
});

const fileReadSchema = z.object({
  text: z.string(),
  last: z.number().int(),
  lines: z.number().int(),
});
const fileWriteSchema = z.object({ bytes: z.number().int() });

const runSchema = z.object({ address: z.string().min(1) });

const waitSchema = z.object({
  ended: z.boolean(),
  reason: z.string(),
  status: z.string().nullish().transform((status) => status ?? undefined),
  exit_code: z.number().int().nullish().transform((code) => code ?? undefined),
  signal: z.number().int().nullish().transform((signal) => signal ?? undefined),
});

const DEFAULT_EXEC_TIMEOUT_S = 60;
const MAX_EXEC_TIMEOUT_S = 600;
const MAX_WAIT_TIMEOUT_S = 600;
/** Room for hc to end the program and report, so the runner never cuts hc off first. */
const RUNNER_MARGIN_MS = 5_000;

/** Where a remote call runs; without `on` it runs on the machine hc runs on. */
export type HcPlace = { on?: string; cwd?: string };

export type HcExecOptions = HcPlace & {
  /** Seconds hc lets the program run: a whole number from 1 to 600. */
  timeout?: number;
  /** Values appear in error messages and in `ps`, so a secret never goes here. */
  env?: Readonly<Record<string, string>>;
  stdin?: string;
};

/** A program's outcome; a non-zero `code` is a result, not a failure. */
export type HcExecResult = { code: number; stdout: string; stderr: string };

export type HcRunOptions = HcPlace & {
  /** Have hc put a shell in place of a lost program, never re-running the command. */
  keep?: boolean;
  /** Unique among live terminals: 1 to 32 of a-z, 0-9, `-` and `_`. */
  name?: string;
};

export type HcWaitOptions = {
  /** Seconds hc waits before it checks in: a whole number from 1 to 600. */
  timeout: number;
};

/** Why a wait ended; the terminal keeps running on `timeout`, `stopped`, `blocked` and `error`. */
export type HcWaitOutcome =
  | { kind: "stopped"; status: "idle" | "done" }
  | { kind: "blocked" }
  | { kind: "error" }
  | { kind: "exited"; code?: number; signal?: number }
  | { kind: "timeout" }
  /** hc ended the wait without the terminal having stopped: a message reached the waiting terminal, or the program cleared its status. */
  | { kind: "interrupted"; reason: "message" | "status_cleared" };

export type HcTerminal = z.infer<typeof terminalSchema>;
export type HcMachine = z.infer<typeof machinesSchema>["machines"][number];

export class HcError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "HcError";
  }
}

/** Typed access to the `hc` CLI; every reply is parsed before it leaves. */
export class Hc {
  readonly #run: Runner;

  constructor(run: Runner = runProcess) {
    this.#run = run;
  }

  terminal(address: string): Promise<HcTerminal> {
    return this.#query(["get", address, "--json"], terminalSchema);
  }

  async machines(): Promise<readonly HcMachine[]> {
    const reply = await this.#query(["machine", "ls", "--json"], machinesSchema);
    return reply.machines;
  }

  /** Runs a program through `hc exec`, with no shell; output comes back as text. */
  async exec(argv: readonly string[], options: HcExecOptions = {}): Promise<HcExecResult> {
    const timeout = options.timeout ?? DEFAULT_EXEC_TIMEOUT_S;
    assertExecTimeout(timeout);
    const args = execArgs(argv, options);
    const label = `hc exec ${argv.join(" ")}${options.on === undefined ? "" : ` on ${options.on}`}`;
    const reply = await this.#query(args, execSchema, label, {
      timeoutMs: timeout * 1000 + RUNNER_MARGIN_MS,
      ...(options.stdin === undefined ? {} : { input: options.stdin }),
    });
    return execResult(reply, label, timeout);
  }

  /** The content of a text file, exactly as stored. */
  async readFile(path: string, options: HcPlace = {}): Promise<string> {
    const args = ["file", "read", "--json", ...placeArgs(options), "--", path];
    const label = fileLabel("read", path, options);
    const reply = await this.#query(args, fileReadSchema, label);
    // hc stops at its size cap without saying so; only the line counts show it.
    if (reply.last < reply.lines) {
      throw new HcError(`${label}: the text was truncated at line ${reply.last} of ${reply.lines}`);
    }
    return reply.text;
  }

  /** Replaces a text file with `text`, making missing folders; fails unless hc reports every byte written. */
  async writeFile(path: string, text: string, options: HcPlace = {}): Promise<void> {
    const args = ["file", "write", "--json", ...placeArgs(options), "--", path];
    const label = fileLabel("write", path, options);
    const reply = await this.#query(args, fileWriteSchema, label, { input: text });
    const sent = Buffer.byteLength(text, "utf8");
    if (reply.bytes !== sent) throw new HcError(`${label}: hc wrote ${reply.bytes} bytes of ${sent}`);
  }

  /**
   * Starts a program in a new terminal without waiting for it and resolves the terminal's address.
   * The terminal has no parent, so it outlives the terminal this process runs in.
   */
  async run(argv: readonly string[], options: HcRunOptions = {}): Promise<string> {
    const keep = options.keep === true ? ["--keep"] : [];
    const name = options.name === undefined ? [] : [`--name=${options.name}`];
    const args = ["run", "--json", "--bg", "--no-parent", ...placeArgs(options), ...keep, ...name, "--", ...argv];
    const label = `hc run ${argv.join(" ")}${options.on === undefined ? "" : ` on ${options.on}`}`;
    const reply = await this.#query(args, runSchema, label);
    return reply.address;
  }

  /** Waits until the terminal stops working, or until the timeout passes with it still working. */
  async wait(address: string, options: HcWaitOptions): Promise<HcWaitOutcome> {
    assertWaitTimeout(options.timeout);
    const args = ["wait", "--json", "--timeout", String(options.timeout), "--", address];
    const reply = await this.#query(args, waitSchema, `hc wait ${address}`, {
      timeoutMs: options.timeout * 1000 + RUNNER_MARGIN_MS,
    });
    return waitOutcome(reply, `hc wait ${address}`);
  }

  /** Ends the terminal's program and resolves the terminal as hc reports it afterwards. */
  kill(address: string): Promise<HcTerminal> {
    return this.#query(["kill", "--json", "--", address], terminalSchema, `hc kill ${address}`);
  }

  async #query<T extends z.ZodType>(
    args: readonly string[],
    schema: T,
    label?: string,
    options?: RunOptions,
  ): Promise<z.infer<T>> {
    let output: string;
    try {
      output = await this.#run("hc", args, options);
    } catch (error) {
      if (error instanceof ProcessError) throw new HcError(label === undefined ? error.message : `${label}: ${error.message}`);
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(output);
    } catch {
      throw new HcError(`hc ${args.join(" ")} printed output that is not JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new HcError(`hc ${args.join(" ")} printed an unexpected shape: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}

function assertExecTimeout(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_EXEC_TIMEOUT_S) {
    throw new HcError(`hc exec timeout must be a whole number of seconds from 1 to ${MAX_EXEC_TIMEOUT_S}, got ${timeout}`);
  }
}

function assertWaitTimeout(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_WAIT_TIMEOUT_S) {
    throw new HcError(`hc wait timeout must be a whole number of seconds from 1 to ${MAX_WAIT_TIMEOUT_S}, got ${timeout}`);
  }
}

const STATUS_OUTCOMES: ReadonlyMap<string, HcWaitOutcome> = new Map([
  ["idle", { kind: "stopped", status: "idle" }],
  ["done", { kind: "stopped", status: "done" }],
  ["blocked", { kind: "blocked" }],
  ["error", { kind: "error" }],
]);

function waitOutcome(reply: z.infer<typeof waitSchema>, label: string): HcWaitOutcome {
  const outcome = placeWait(reply);
  if (outcome === undefined) {
    throw new HcError(`${label}: hc ended the wait with reason ${reply.reason} and status ${reply.status ?? "none"}, which this wrapper cannot place`);
  }
  return outcome;
}

function placeWait(reply: z.infer<typeof waitSchema>): HcWaitOutcome | undefined {
  if (!reply.ended) {
    if (reply.reason === "timeout") return { kind: "timeout" };
    return reply.reason === "message" ? { kind: "interrupted", reason: "message" } : undefined;
  }
  if (reply.reason === "exit") {
    return {
      kind: "exited",
      ...(reply.exit_code === undefined ? {} : { code: reply.exit_code }),
      ...(reply.signal === undefined ? {} : { signal: reply.signal }),
    };
  }
  if (reply.reason !== "status") return undefined;
  return reply.status === undefined ? { kind: "interrupted", reason: "status_cleared" } : STATUS_OUTCOMES.get(reply.status);
}

function execArgs(argv: readonly string[], options: HcExecOptions): string[] {
  const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const timeout = options.timeout === undefined ? [] : ["--timeout", String(options.timeout)];
  const stdin = options.stdin === undefined ? [] : ["-i"];
  return ["exec", "--json", ...placeArgs(options), ...env, ...timeout, ...stdin, "--", ...argv];
}

function execResult(reply: z.infer<typeof execSchema>, label: string, timeout: number): HcExecResult {
  if (reply.timed_out) throw new HcError(`${label}: the program timed_out after ${timeout} s`);
  if (reply.truncated) throw new HcError(`${label}: the output was truncated`);
  if (reply.code === null) throw new HcError(`${label}: the program ended on ${reply.signal === null || reply.signal === undefined ? "a signal" : `signal ${reply.signal}`} with no exit code`);
  return { code: reply.code, stdout: decode(reply.stdout), stderr: decode(reply.stderr) };
}

function placeArgs(place: HcPlace): string[] {
  return [...(place.on === undefined ? [] : [`--on=${place.on}`]), ...(place.cwd === undefined ? [] : [`--cwd=${place.cwd}`])];
}

function fileLabel(verb: string, path: string, place: HcPlace): string {
  return `hc file ${verb} ${path}${place.on === undefined ? "" : ` on ${place.on}`}`;
}

function decode(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}
