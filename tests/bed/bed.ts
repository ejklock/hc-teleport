import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * A two-machine bed of throwaway containers: `source` plays the Mac and
 * `dest` plays dev-home, each running a real `hc`, with `dest` added to
 * `source` as an hc machine over SSH.
 */

export const BED_PROJECT_ROOT = "/Volumes/Developer/www/test-org";
/** Where the repository's working tree is mounted read-only on `source`. */
export const REPO_MOUNT = "/opt/hc-teleport";
/** How long a hook may wait for `Bed.start`; a cold start builds hc from source, every later start reuses the image. */
export const BED_START_TIMEOUT_MS = 900_000;
/** Everything `Bed.start` may spend, teardown after a failure excluded; kept below the hook timeout by more than the teardown bound. */
export const BED_START_BUDGET_MS = 720_000;

const BED_DIR = import.meta.dirname;
const REPO_ROOT = join(BED_DIR, "..", "..");
const DEFAULT_COMPOSE_FILE = join(BED_DIR, "compose.yaml");

const BUILD_TIMEOUT_MS = 840_000;
const UP_TIMEOUT_MS = 180_000;
const DOWN_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 120_000;
const CONNECT_ATTEMPTS = 60;
const SUBNET_ATTEMPTS = 5;
/** What `up --wait` leaves of its step time for compose to report its own timeout before the kill. */
const WAIT_MARGIN_MS = 5_000;

const LIST_COMMAND = ["hc", "machine", "ls", "--json", "(on source)"];

const SIDES = {
  source: { user: "mac", home: "/Users/mac" },
  dest: { user: "box", home: "/home/box" },
} as const;

export type Side = keyof typeof SIDES;
export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd?: string; stdin?: string; timeoutMs?: number };
export type StartOptions = { composeFile?: string; budgetMs?: number };

const machinesSchema = z.object({
  machines: z.array(z.object({ name: z.string(), state: z.string() })),
});

// The bed names its own subnet: a busy host can run out of the daemon's
// default address pools, and then no network can be created at all.
function randomSubnet(): string {
  const second = 128 + Math.floor(Math.random() * 127);
  const third = Math.floor(Math.random() * 256);
  return `10.${second}.${third}.0/24`;
}

const PS_ARGS = ["ps", "--all", "--format", "json"];
const SERVICE_NAMES = ["source", "dest"] as const;

const serviceSchema = z.object({
  Service: z.string(),
  State: z.string().optional(),
  Health: z.string().optional(),
});

/** `compose ps --format json` prints one object per line, or one array in older releases. */
function parseServices(
  text: string,
  command: string,
): z.infer<typeof serviceSchema>[] {
  const rows = text.trim().startsWith("[")
    ? parseJson(text, command)
    : text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => parseJson(line, command));
  const parsed = z.array(serviceSchema).safeParse(rows);
  if (!parsed.success)
    throw new BedError(
      command,
      `the reply has an unexpected shape: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}

function parseJson(text: string, command: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new BedError(command, `the reply is not JSON: ${text.slice(0, 200)}`);
  }
}

export class BedError extends Error {
  constructor(command: string, detail: string) {
    super(`${command}: ${detail}`);
    this.name = "BedError";
  }
}

type Exec = { env?: Record<string, string>; input?: string; timeoutMs: number };

/** Resolves with the exit code and both streams; a timeout or a program that cannot start rejects. */
function exec(
  file: string,
  args: readonly string[],
  options: Exec,
): Promise<RunResult> {
  const command = [file, ...args].join(" ");
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        // SIGTERM is ignored while compose waits on a container.
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
        } else if (typeof error.code === "number" && !error.killed) {
          resolve({ code: error.code, stdout, stderr });
        } else {
          const why = error.killed
            ? `timed out after ${options.timeoutMs} ms`
            : error.message;
          reject(new BedError(command, `${why}\n${stderr.trim()}`.trim()));
        }
      },
    );
    child.stdin?.end(options.input ?? "");
  });
}

async function execOk(
  file: string,
  args: readonly string[],
  options: Exec,
): Promise<RunResult> {
  const result = await exec(file, args, options);
  if (result.code !== 0) {
    throw new BedError(
      [file, ...args].join(" "),
      `exit ${result.code}\n${result.stderr.trim()}`,
    );
  }
  return result;
}

async function requireDocker(): Promise<void> {
  try {
    await execOk("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: QUICK_TIMEOUT_MS,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BedError("the bed needs a running Docker daemon", detail);
  }
}

export class Bed {
  readonly project: string;
  readonly keyDir: string;
  private readonly composeFile: string;
  private readonly budgetMs: number;
  private readonly deadline: number;
  private stopped = false;
  private subnet = randomSubnet();

  private constructor(
    project: string,
    keyDir: string,
    composeFile: string,
    budgetMs: number,
    deadline: number,
  ) {
    this.project = project;
    this.keyDir = keyDir;
    this.composeFile = composeFile;
    this.budgetMs = budgetMs;
    this.deadline = deadline;
  }

  /** Builds if needed, starts both machines and returns once `source` sees `dest` connected. */
  static async start(options: StartOptions = {}): Promise<Bed> {
    const budgetMs = options.budgetMs ?? BED_START_BUDGET_MS;
    const deadline = Date.now() + budgetMs;
    await requireDocker();
    const keyDir = await realpath(
      await mkdtemp(join(tmpdir(), "hc-teleport-bed-")),
    );
    const project = `hcbed-${keyDir.split("-").pop()?.toLowerCase() ?? "run"}`;
    const bed = new Bed(
      project,
      keyDir,
      options.composeFile ?? DEFAULT_COMPOSE_FILE,
      budgetMs,
      deadline,
    );
    try {
      const keygen = [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "hc-teleport-bed",
        "-f",
        join(keyDir, "id_ed25519"),
      ];
      await execOk("ssh-keygen", keygen, {
        timeoutMs: bed.limit(QUICK_TIMEOUT_MS, ["ssh-keygen", ...keygen]),
      });
      await bed.step(["build", "source"], BUILD_TIMEOUT_MS);
      await bed.up();
      await bed.connect();
      await bed.allowDestinations(["dest", "local"]);
    } catch (error) {
      const teardown = await bed.tearDownAfterFailure();
      if (teardown.length === 0) throw error;
      const detail = teardown
        .map((failure) =>
          failure instanceof Error ? failure.message : String(failure),
        )
        .join("; ");
      throw new AggregateError(
        [error, ...teardown],
        `${error instanceof Error ? error.message : String(error)}\n(the teardown failed too: ${detail})`,
      );
    }
    return bed;
  }

  /** Lists what is still left of a bed's containers, networks and volumes. */
  static async residue(project: string): Promise<string[]> {
    const filter = `label=com.docker.compose.project=${project}`;
    const kinds = [
      ["ps", "--all", "--filter", filter, "--format", "container {{.Names}}"],
      ["network", "ls", "--filter", filter, "--format", "network {{.Name}}"],
      ["volume", "ls", "--filter", filter, "--format", "volume {{.Name}}"],
    ];
    const lines: string[] = [];
    for (const args of kinds) {
      const listed = await execOk("docker", args, {
        timeoutMs: QUICK_TIMEOUT_MS,
      });
      lines.push(...listed.stdout.split("\n").filter((line) => line !== ""));
    }
    return lines;
  }

  /** Runs a command in a container as its non-root user; a nonzero exit is a result, not an error. */
  run(
    side: Side,
    argv: readonly string[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    const { user, home } = SIDES[side];
    return exec(
      "docker",
      [
        ...this.composeArgs(),
        "exec",
        "-T",
        "-u",
        user,
        "-e",
        `HOME=${home}`,
        "-w",
        options.cwd ?? home,
        side,
        ...argv,
      ],
      {
        timeoutMs: options.timeoutMs ?? RUN_TIMEOUT_MS,
        ...(options.stdin === undefined ? {} : { input: options.stdin }),
        env: this.env(),
      },
    );
  }

  /** Removes containers, network, volumes and the key pair; a second call after success does nothing, one after a failed teardown tries again. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.compose(
        ["down", "--volumes", "--remove-orphans", "--timeout", "5"],
        DOWN_TIMEOUT_MS,
      );
      this.stopped = true;
    } finally {
      await rm(this.keyDir, { recursive: true, force: true });
    }
  }

  /** Stops, then looks for residue whether or not the stop threw; returns what failed. */
  private async tearDownAfterFailure(): Promise<unknown[]> {
    const failures: unknown[] = [];
    try {
      await this.stop();
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await this.sweep();
    } catch (failure) {
      failures.push(failure);
    }
    return failures;
  }

  /** A deadline can stop `up` while Docker still creates containers, after `down` listed what to remove: tears down once more when anything is left. */
  private async sweep(): Promise<void> {
    if ((await Bed.residue(this.project)).length === 0) return;
    this.stopped = false;
    await this.stop();
  }

  /**
   * Retries with another subnet while the one picked collides with a network
   * the host already has. Compose sometimes exits 0 when its wait timeout runs
   * out, so success also needs both services reporting healthy.
   */
  private async up(): Promise<void> {
    const up = ["up", "--detach", "--wait"];
    for (let attempt = 1; ; attempt += 1) {
      try {
        const timeoutMs = this.limit(UP_TIMEOUT_MS, [
          "docker",
          ...this.composeArgs(),
          ...up,
        ]);
        // Compose gives up waiting on its own, so it exits instead of being killed mid-creation.
        // The floor is 1: compose reads 0 as no limit, and the kill bounds the step anyway.
        const waitSeconds = Math.max(
          1,
          Math.floor((timeoutMs - WAIT_MARGIN_MS) / 1000),
        );
        await this.compose(
          [...up, "--wait-timeout", String(waitSeconds)],
          timeoutMs,
        );
        break;
      } catch (error) {
        const collided =
          error instanceof Error && /overlap/i.test(error.message);
        if (!collided || attempt === SUBNET_ATTEMPTS) throw error;
        await this.step(
          ["down", "--volumes", "--remove-orphans", "--timeout", "5"],
          DOWN_TIMEOUT_MS,
        );
        this.subnet = randomSubnet();
      }
    }
    await this.requireHealthy(up);
  }

  /** Fails naming the `up` step when a service is not healthy, whatever compose's exit code said. */
  private async requireHealthy(up: readonly string[]): Promise<void> {
    const command = ["docker", ...this.composeArgs(), ...up];
    const listed = await this.step(PS_ARGS, QUICK_TIMEOUT_MS);
    const services = parseServices(
      listed.stdout,
      ["docker", ...this.composeArgs(), ...PS_ARGS].join(" "),
    );
    const unhealthy = SERVICE_NAMES.flatMap((name) => {
      const found = services.find((service) => service.Service === name);
      return found?.Health === "healthy"
        ? []
        : [
            `${name} is not healthy (${found?.Health || found?.State || "absent"})`,
          ];
    });
    if (unhealthy.length > 0)
      throw new BedError(command.join(" "), unhealthy.join("; "));
  }

  /** Writes the config the CLI on the source side reads before it moves a session. */
  private async allowDestinations(allowed: readonly string[]): Promise<void> {
    const write = await this.run(
      "source",
      [
        "sh",
        "-c",
        'mkdir -p "$HOME/.config/hc-teleport" && cat > "$HOME/.config/hc-teleport/config.json"',
      ],
      { stdin: JSON.stringify({ v: 1, allowed }) },
    );
    if (write.code !== 0)
      throw new BedError("write the hc-teleport config", write.stderr);
  }

  private async connect(): Promise<void> {
    const add = [
      ...this.composeArgs(),
      "exec",
      "-T",
      "-u",
      SIDES.source.user,
      "-e",
      `HOME=${SIDES.source.home}`,
      "source",
      "hc",
      "machine",
      "add",
      "dest",
    ];
    await execOk("docker", add, {
      timeoutMs: this.limit(UP_TIMEOUT_MS, ["docker", ...add]),
      env: this.env(),
      input: "",
    });
    let last = "no reply";
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
      const timeoutMs = this.limit(QUICK_TIMEOUT_MS, LIST_COMMAND);
      const listed = await this.run(
        "source",
        ["hc", "machine", "ls", "--json"],
        { timeoutMs },
      );
      const parsed = machinesSchema.safeParse(
        listed.code === 0
          ? parseJson(listed.stdout, LIST_COMMAND.join(" "))
          : {},
      );
      const dest = parsed.success
        ? parsed.data.machines.find((machine) => machine.name === "dest")
        : undefined;
      if (dest?.state === "connected") return;
      last =
        dest === undefined
          ? listed.stderr.trim() || "dest is not listed"
          : `dest is ${dest.state}`;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new BedError(LIST_COMMAND.join(" "), `dest never connected: ${last}`);
  }

  /** A step's timeout: its own bound, or what is left of the start budget when that is less. */
  private limit(boundMs: number, command: readonly string[]): number {
    const left = this.deadline - Date.now();
    if (left <= 0)
      throw new BedError(
        command.join(" "),
        `start budget of ${this.budgetMs} ms ran out`,
      );
    return Math.min(boundMs, left);
  }

  private step(args: readonly string[], boundMs: number): Promise<RunResult> {
    return this.compose(
      args,
      this.limit(boundMs, ["docker", ...this.composeArgs(), ...args]),
    );
  }

  private composeArgs(): string[] {
    return ["compose", "-p", this.project, "-f", this.composeFile];
  }

  private env(): Record<string, string> {
    return {
      BED_KEY_DIR: this.keyDir,
      BED_REPO: REPO_ROOT,
      BED_SUBNET: this.subnet,
    };
  }

  private compose(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<RunResult> {
    return execOk("docker", [...this.composeArgs(), ...args], {
      timeoutMs,
      env: this.env(),
    });
  }
}
