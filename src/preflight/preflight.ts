import { HcError, type Hc, type HcExecResult } from "../platform/hc.ts";
import { ProcessError, type Runner } from "../platform/process.ts";
import type { AgentAdapter, DestinationRefusalReason, RemoteRun } from "../session/agent-adapter.ts";
import type { SessionPlan } from "../session/index.ts";

type Refusal = { reason: DestinationRefusalReason | "dest_repo_missing"; detail: string };

export type PreflightResult =
  | { ok: true; destination: { home: string; configDir: string; version: string } }
  | { ok: false; refusal: Refusal };

function refused(reason: Refusal["reason"], detail: string): PreflightResult {
  return { ok: false, refusal: { reason, detail } };
}

function homeOf(printed: HcExecResult, machine: string): string {
  const home = printed.stdout.trim();
  if (printed.code === 0 && home.startsWith("/")) return home;
  throw new HcError(
    `printenv HOME on ${machine} gave no absolute home directory: exit code ${printed.code}, output ${JSON.stringify(home)}`,
  );
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/** The program a command runs: past a leading `env` and its NAME=value words, which become the environment. */
function programOf(argv: readonly string[]): { executable: string | undefined; env: Record<string, string> } {
  const env: Record<string, string> = {};
  if (argv[0] !== "env") return { executable: argv[0], env };
  let index = 1;
  for (; index < argv.length; index += 1) {
    const assignment = ASSIGNMENT.exec(argv[index] ?? "");
    if (assignment === null) break;
    env[assignment[1] ?? ""] = assignment[2] ?? "";
  }
  return { executable: argv[index], env };
}

/** The top level holding the plan's cwd on the source: through hc for a source on an hc machine, else on this machine. */
async function topLevelOnSource(plan: SessionPlan, deps: { hc: Pick<Hc, "exec">; run: Runner }): Promise<string> {
  const args = ["-C", plan.cwd, "rev-parse", "--show-toplevel"];
  if (plan.source === undefined || plan.source === "local") return (await deps.run("git", args)).trim();
  const top = await deps.hc.exec(["git", ...args], { on: plan.source });
  if (top.code !== 0) {
    throw new ProcessError(`git ${args.join(" ")} on ${plan.source}`, `exit code ${top.code}: ${top.stderr.trim()}`);
  }
  return top.stdout.trim();
}

/**
 * Checks, without writing, that the machine can resume the planned session:
 * the repository is there (the same top level, at the same path, as the one
 * holding the session's cwd on the source), then whatever the agent's adapter
 * needs. `machine` is the destination; `local` is the Mac. Stops at the first
 * refusal. Throws `HcError` when `hc` itself fails, and `ProcessError` when
 * git fails reading the source's top level (the cwd is in no work tree there),
 * whether the source is this machine or an hc machine.
 */
export async function preflight(
  request: { plan: SessionPlan; machine: string },
  deps: { hc: Pick<Hc, "exec">; run: Runner; adapter: AgentAdapter },
): Promise<PreflightResult> {
  const { plan, machine } = request;
  // hc runs a program on the Mac when no machine is named, with the PATH `hc run` starts the session with; the Mac is never a machine name to it.
  const place = machine === "local" ? {} : { on: machine };
  const run = async (argv: readonly string[]): Promise<HcExecResult> => {
    try {
      return await deps.hc.exec(argv, place);
    } catch (error) {
      // hc reports a program that cannot start as its own failure, not as an exit code.
      if (error instanceof HcError && error.kind === "spawn_failed") {
        return { code: 127, stdout: "", stderr: error.message };
      }
      throw error;
    }
  };

  const sourceTop = await topLevelOnSource(plan, deps);

  // -C rather than --cwd: a path that does not exist is then a git failure, not an hc one.
  const top = await run(["git", "-C", plan.cwd, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    const why = top.stderr.trim();
    return refused("dest_repo_missing", `${plan.cwd} is not a git work tree on ${machine}${why === "" ? "" : `: ${why}`}`);
  }
  const toplevel = top.stdout.trim();
  if (toplevel !== sourceTop) {
    return refused("dest_repo_missing", `${plan.cwd} on ${machine} is inside the work tree ${toplevel}, not ${sourceTop}, the one it is in here`);
  }

  const home = homeOf(await run(["printenv", "HOME"]), machine);
  return checkAgent({ plan, home }, { machine, run }, deps.adapter);
}

async function checkAgent(
  request: { plan: SessionPlan; home: string },
  remote: RemoteRun,
  adapter: AgentAdapter,
): Promise<PreflightResult> {
  const { plan, home } = request;
  const command = programOf(plan.resume.argv);
  if (command.executable === undefined) {
    return refused("dest_executable_missing", `the resume command names no program to run on ${remote.machine}`);
  }
  const checked = await adapter.checkDestination(
    {
      executable: command.executable,
      env: command.env,
      home,
      ...(plan.session.version === undefined ? {} : { sourceVersion: plan.session.version }),
    },
    remote,
  );
  if (!checked.ok) return checked;
  return { ok: true, destination: { home, configDir: checked.configDir, version: checked.version } };
}
