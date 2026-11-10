import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { HcTerminal } from "../platform/hc.ts";
import { runProcess, type Runner } from "../platform/process.ts";
import type {
  AdapterRefusalReason,
  AgentAdapter,
  AgentSession,
  ResumeArgvResult,
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
