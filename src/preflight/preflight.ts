import { HcError, type Hc, type HcExecResult } from "../platform/hc.ts";
import type { AgentAdapter, DestinationRefusalReason } from "../session/agent-adapter.ts";
import type { SessionPlan } from "../session/index.ts";

const SPAWN_FAILED = '"kind":"spawn_failed"';

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

/**
 * Checks, without writing, that the machine can resume the planned session:
 * the repository is there, then whatever the agent's adapter needs. Stops at
 * the first refusal. Throws `HcError` when `hc` itself fails.
 */
export async function preflight(
  request: { plan: SessionPlan; machine: string },
  deps: { hc: Pick<Hc, "exec">; adapter: AgentAdapter },
): Promise<PreflightResult> {
  const { plan, machine } = request;
  const run = async (argv: readonly string[]): Promise<HcExecResult> => {
    try {
      return await deps.hc.exec(argv, { on: machine });
    } catch (error) {
      // hc reports a program that cannot start as its own failure, not as an exit code.
      if (error instanceof HcError && error.message.includes(SPAWN_FAILED)) {
        return { code: 127, stdout: "", stderr: error.message };
      }
      throw error;
    }
  };

  // -C rather than --cwd: a path that does not exist is then a git failure, not an hc one.
  const top = await run(["git", "-C", plan.cwd, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    const why = top.stderr.trim();
    return refused("dest_repo_missing", `${plan.cwd} is not a git work tree on ${machine}${why === "" ? "" : `: ${why}`}`);
  }
  const toplevel = top.stdout.trim();
  if (toplevel !== plan.cwd) {
    return refused("dest_repo_missing", `${plan.cwd} on ${machine} is inside the work tree ${toplevel}, not its top level`);
  }

  const home = homeOf(await run(["printenv", "HOME"]), machine);
  const checked = await deps.adapter.checkDestination(
    {
      executable: plan.resume.argv[0] ?? "",
      home,
      ...(plan.session.version === undefined ? {} : { sourceVersion: plan.session.version }),
    },
    { machine, run },
  );
  if (!checked.ok) return checked;
  return { ok: true, destination: { home, configDir: checked.configDir, version: checked.version } };
}
