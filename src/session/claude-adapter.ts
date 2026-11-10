import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { HcTerminal } from "../platform/hc.ts";
import { runProcess, type Runner } from "../platform/process.ts";
import type {
  AdapterRefusalReason,
  AgentAdapter,
  AgentSession,
  DestinationRefusalReason,
  DestinationRequest,
  DestinationResult,
  RemoteRun,
  ResumeArgvResult,
  ResumeConfirmation,
  ResumeExpectation,
  SessionResult,
} from "./agent-adapter.ts";
import { buildResumeArgv } from "./resume-argv.ts";

// The pid registry is internal to Claude Code and undocumented; it is parsed
// strictly on the three fields the move relies on and nothing else.
const registrySchema = z.object({
  pid: z.number().int(),
  sessionId: z.uuid(),
  cwd: z.string(),
  version: z.string().optional(),
});

type Registry = z.infer<typeof registrySchema>;
type Refusal = Extract<SessionResult, { ok: false }>;
type DestinationRefusal = Extract<DestinationResult, { ok: false }>;
type Version = readonly [number, number, number];

function refuseDestination(reason: DestinationRefusalReason, detail: string): DestinationRefusal {
  return { ok: false, refusal: { reason, detail } };
}

// Claude Code prints "2.1.321 (Claude Code)"; only the leading three integers count.
function parseVersion(text: string): Version | undefined {
  const found = /^\s*(\d+)\.(\d+)\.(\d+)(?!\d)/.exec(text);
  return found === null ? undefined : [Number(found[1]), Number(found[2]), Number(found[3])];
}

function isOlder(version: Version, reference: Version): boolean {
  for (const [index, part] of version.entries()) {
    const other = reference[index] ?? 0;
    if (part !== other) return part < other;
  }
  return false;
}

function parseRegistry(text: string, file: string): Registry | Refusal {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse("session_registry_unreadable", `${file} is not valid JSON`);
  }
  const parsed = registrySchema.safeParse(json);
  if (!parsed.success) {
    return refuse("session_registry_unreadable", `${file} has an unknown shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

function refuse(reason: AdapterRefusalReason, detail: string): Refusal {
  return { ok: false, refusal: { reason, detail } };
}

// Claude Code derives the project directory by replacing every character
// outside [A-Za-z0-9] with a dash, one per UTF-16 unit.
function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Claude Code behind an hc terminal: its session, the files that hold it and how to resume it. */
export class ClaudeAdapter implements AgentAdapter {
  readonly #home: string;
  readonly #run: Runner;

  constructor(home: string, run: Runner = runProcess) {
    this.#home = home;
    this.#run = run;
  }

  recognizes(terminal: HcTerminal): boolean {
    return terminal.foreground?.argv[0] === "claude";
  }

  buildResumeArgv(source: readonly string[], sessionId: string): ResumeArgvResult {
    return buildResumeArgv(source, sessionId);
  }

  async checkDestination(request: DestinationRequest, remote: RemoteRun): Promise<DestinationResult> {
    const { executable, home } = request;
    const printed = await remote.run([executable, "--version"]);
    if (printed.code !== 0) {
      const why = printed.stderr.trim() || `exit ${printed.code}`;
      return refuseDestination("dest_executable_missing", `${executable} does not run on ${remote.machine}: ${why}`);
    }
    const configDir = await this.#destinationConfigDir(executable, home, remote);
    if (typeof configDir !== "string") return configDir;

    const version = parseVersion(printed.stdout);
    if (version === undefined) {
      return refuseDestination(
        "dest_agent_version_unknown",
        `${executable} --version on ${remote.machine} printed no major.minor.patch: ${printed.stdout.trim()}`,
      );
    }
    const source = request.sourceVersion === undefined ? undefined : parseVersion(request.sourceVersion);
    if (source === undefined) {
      return refuseDestination(
        "dest_agent_version_unknown",
        `the source version is ${request.sourceVersion ?? "absent"}, not a major.minor.patch, so ${remote.machine} cannot be compared`,
      );
    }
    if (isOlder(version, source)) {
      return refuseDestination(
        "dest_agent_older",
        `${executable} on ${remote.machine} is ${version.join(".")}, older than the source's ${source.join(".")}`,
      );
    }
    return { ok: true, configDir, version: version.join(".") };
  }

  async confirmResumed(terminal: HcTerminal, expected: ResumeExpectation, remote: RemoteRun): Promise<ResumeConfirmation> {
    if (terminal.state !== "live") {
      const code = terminal.exit_code === undefined ? "" : ` with exit code ${terminal.exit_code}`;
      return refuse("terminal_not_running", `${terminal.address} on ${remote.machine} is ${terminal.state}${code}`);
    }
    const foreground = terminal.foreground;
    if (foreground === undefined || !this.recognizes(terminal)) {
      return refuse("not_claude", `the foreground process of ${terminal.address} on ${remote.machine} is not claude`);
    }
    const registry = await this.#readRemoteRegistry(expected.configDir, foreground.pid, remote);
    if ("ok" in registry) return registry;
    if (registry.pid !== foreground.pid || registry.cwd !== foreground.cwd || registry.cwd !== terminal.cwd) {
      return refuse(
        "session_registry_stale",
        `the registry entry of pid ${registry.pid} does not match the foreground process of ${terminal.address}`,
      );
    }
    if (registry.sessionId !== expected.sessionId) {
      return refuse(
        "session_mismatch",
        `${terminal.address} on ${remote.machine} runs session ${registry.sessionId}, expected ${expected.sessionId}`,
      );
    }
    return { ok: true };
  }

  async #readRemoteRegistry(configDir: string, pid: number, remote: RemoteRun): Promise<Registry | Refusal> {
    // Both commands take the path as an operand; an absolute path cannot read as an option.
    if (!isAbsolute(configDir)) return refuse("session_registry_unreadable", `the config dir ${configDir} is not an absolute path`);
    const file = join(configDir, "sessions", `${pid}.json`);
    const read = await remote.run(["cat", "--", file]);
    if (read.code !== 0) {
      // Only a failed read asks whether the file exists, so a file removed mid-check still reads as absent.
      const exists = await remote.run(["test", "-e", file]);
      if (exists.code !== 0) return refuse("no_session", `${file} does not exist on ${remote.machine}`);
      return refuse("session_registry_unreadable", `${file} cannot be read on ${remote.machine}`);
    }
    return parseRegistry(read.stdout, file);
  }

  async #destinationConfigDir(executable: string, home: string, remote: RemoteRun): Promise<string | DestinationRefusal> {
    let configDir = `${home}/.claude`;
    if (executable !== "claude") {
      const where = await remote.run([executable, "--where"]);
      const printed = where.stdout.trim();
      if (where.code !== 0 || !isAbsolute(printed)) {
        return refuseDestination("dest_profile_missing", `${executable} --where on ${remote.machine} did not print an absolute path`);
      }
      configDir = printed;
    }
    const exists = await remote.run(["test", "-d", configDir]);
    if (exists.code !== 0) return refuseDestination("dest_profile_missing", `${configDir} does not exist on ${remote.machine}`);
    return configDir;
  }

  async findSession(terminal: HcTerminal): Promise<SessionResult> {
    const foreground = terminal.foreground;
    if (foreground === undefined || !this.recognizes(terminal)) {
      return refuse("not_claude", `the foreground process of ${terminal.address} is not claude`);
    }
    const configDir = await this.#configDir(terminal.argv[0] ?? "");
    if (typeof configDir !== "string") return configDir;

    const registry = await this.#readRegistry(configDir, foreground.pid);
    if ("ok" in registry) return registry;
    if (registry.pid !== foreground.pid || registry.cwd !== foreground.cwd || registry.cwd !== terminal.cwd) {
      return refuse(
        "session_registry_stale",
        `the registry entry of pid ${registry.pid} does not match the terminal's foreground process`,
      );
    }
    return { ok: true, session: await this.#describe(configDir, registry) };
  }

  async #configDir(launcher: string): Promise<string | Refusal> {
    if (launcher === "claude") return join(this.#home, ".claude");
    let output: string;
    try {
      output = await this.#run(launcher, ["--where"]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return refuse("config_dir_unknown", detail);
    }
    const printed = output.trim();
    if (!isAbsolute(printed)) {
      return refuse("config_dir_unknown", `${launcher} --where did not print an absolute path`);
    }
    return printed;
  }

  async #readRegistry(configDir: string, pid: number): Promise<Registry | Refusal> {
    const file = join(configDir, "sessions", `${pid}.json`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return refuse("no_session", `${file} does not exist`);
      }
      return refuse("session_registry_unreadable", `${file} cannot be read`);
    }
    return parseRegistry(text, file);
  }

  async #describe(configDir: string, registry: Registry): Promise<AgentSession> {
    const projectDir = join(configDir, "projects", projectDirName(registry.cwd));
    const subagentDir = join(projectDir, registry.sessionId);
    return {
      id: registry.sessionId,
      configDir,
      ...(registry.version === undefined ? {} : { version: registry.version }),
      transcript: {
        file: join(projectDir, `${registry.sessionId}.jsonl`),
        ...((await isDirectory(subagentDir)) ? { dir: subagentDir } : {}),
      },
    };
  }
}
