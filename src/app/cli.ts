#!/usr/bin/env node
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Hc, HcError } from "../platform/hc.ts";
import { moveSession, type MoveOutcome } from "../move/index.ts";
import { ProcessError, processRunner } from "../platform/process.ts";
import { planSession, type SessionPlan } from "../session/index.ts";

const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3, rolledBack: 4 } as const;

const USAGE = "usage: hc-teleport <terminal> <machine> [--dry-run] [--timeout <seconds>] [--json]\n  <terminal> is tN on the Mac or <machine>/tN on an hc machine; <machine> is an hc machine, or local for the Mac";

const DEFAULT_TIMEOUT_S = 120;
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 600;

function shellQuote(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}

function renderPlan(plan: SessionPlan): string {
  const version = plan.session.version === undefined ? "" : ` (Claude Code ${plan.session.version})`;
  return [
    `terminal    ${plan.terminal}`,
    `source      ${plan.source ?? "local"}`,
    `machine     ${plan.machine}`,
    `cwd         ${plan.cwd}`,
    `session     ${plan.session.id}${version}`,
    `config dir  ${plan.session.configDir}`,
    `transcript  ${plan.transcript.file}`,
    `subagents   ${plan.transcript.dir ?? "none"}`,
    `resume      ${plan.resume.argv.map(shellQuote).join(" ")}`,
  ].join("\n");
}

function jsonPlan(plan: SessionPlan): unknown {
  return {
    terminal: plan.terminal,
    // A session on the Mac prints as it always has; only another source is named.
    ...(plan.source === undefined || plan.source === "local" ? {} : { source: plan.source }),
    machine: plan.machine,
    cwd: plan.cwd,
    session: plan.session,
    transcript: { file: plan.transcript.file, dir: plan.transcript.dir ?? null },
    resume: plan.resume,
  };
}

function usageError(message: string): number {
  process.stderr.write(`hc-teleport: ${message}\n${USAGE}\n`);
  return EXIT.usage;
}

type Reason = { reason: string; detail: string };

function refuse(refusal: Reason, json: boolean): number {
  if (json) process.stdout.write(`${JSON.stringify({ refused: refusal })}\n`);
  process.stderr.write(`hc-teleport: refused (${refusal.reason}): ${refusal.detail}\n`);
  return EXIT.refused;
}

function fail(error: Reason & Record<string, unknown>, json: boolean, code: number): number {
  if (json) process.stdout.write(`${JSON.stringify({ error })}\n`);
  process.stderr.write(`hc-teleport: ${error.reason}: ${error.detail}\n`);
  return code;
}

function parseTimeout(text: string | undefined): number | undefined {
  if (text === undefined) return DEFAULT_TIMEOUT_S;
  if (!/^\d+$/.test(text)) return undefined;
  const seconds = Number(text);
  return seconds >= MIN_TIMEOUT_S && seconds <= MAX_TIMEOUT_S ? seconds : undefined;
}

function report(outcome: MoveOutcome, json: boolean): number {
  switch (outcome.status) {
    case "moved": {
      const { plan, destination, parked } = outcome;
      process.stdout.write(
        json
          ? `${JSON.stringify({ moved: { terminal: plan.terminal, machine: plan.machine, session: plan.session.id, destination, parked } })}\n`
          : `moved ${plan.terminal} to ${destination} (session ${plan.session.id}); source terminal stopped\n`,
      );
      process.stderr.write(
        parked.parked
          ? `hc-teleport: source checkout parked under refs/hc-teleport/${plan.session.id}/\n`
          : `hc-teleport: source checkout not parked: ${parked.reason}\n`,
      );
      return EXIT.ok;
    }
    case "refused":
      return refuse(outcome.refusal, json);
    case "rolled_back": {
      const rolledBack = { reason: outcome.reason, detail: outcome.detail };
      if (json) process.stdout.write(`${JSON.stringify({ rolledBack })}\n`);
      process.stderr.write(`hc-teleport: rolled back (${rolledBack.reason}): ${rolledBack.detail}; the source was not touched\n`);
      return EXIT.rolledBack;
    }
    case "rollback_failed":
      return fail(
        { reason: "rollback_failed", detail: `${outcome.cause}; left on the destination: ${outcome.left.join("; ")}`, cause: outcome.cause, left: outcome.left },
        json,
        EXIT.failed,
      );
    case "source_running":
      return fail(
        {
          reason: "source_running",
          detail: `the session runs on ${outcome.destination} but the source terminal could not be stopped and still runs: ${outcome.detail}`,
          destination: outcome.destination,
        },
        json,
        EXIT.failed,
      );
  }
}

async function main(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { "dry-run": { type: "boolean" }, json: { type: "boolean" }, timeout: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const [terminal, machine, ...extra] = parsed.positionals;
  if (terminal === undefined || machine === undefined || extra.length > 0) {
    return usageError("expected exactly <terminal> and <machine>");
  }
  const timeoutSeconds = parseTimeout(parsed.values.timeout);
  if (timeoutSeconds === undefined) {
    return usageError(`--timeout takes a whole number of seconds from ${MIN_TIMEOUT_S} to ${MAX_TIMEOUT_S}`);
  }
  const json = parsed.values.json === true;

  try {
    return parsed.values["dry-run"] === true
      ? await dryRun(terminal, machine, json)
      : await move({ terminal, machine, timeoutSeconds }, json);
  } catch (error) {
    return failure(error, json);
  }
}

async function move(request: { terminal: string; machine: string; timeoutSeconds: number }, json: boolean): Promise<number> {
  if (request.terminal.includes("/")) return refuseRemoteSource(request, json);
  return report(await moveSession(request, { hc: new Hc(), run: processRunner(), home: homedir() }), json);
}

class RemoteSource extends Error {}

/**
 * A terminal address with a `/` is malformed or names an hc machine. The plan's own address parse tells them
 * apart without asking hc: a malformed address refuses before hc is read, and a well-formed one reaches hc,
 * which here fails at once. Only the other direction can be planned, not yet run.
 */
async function refuseRemoteSource(request: { terminal: string; machine: string }, json: boolean): Promise<number> {
  const neverAsked = new Hc(() => Promise.reject(new RemoteSource()));
  try {
    const planned = await planSession(request, { hc: neverAsked, home: homedir() });
    if (!planned.ok) return refuse(planned.refusal, json);
  } catch (error) {
    if (!(error instanceof RemoteSource)) throw error;
  }
  return refuse({ reason: "way_back_not_ready", detail: `${request.terminal} does not run on the Mac; only --dry-run plans a move to the Mac` }, json);
}

async function dryRun(terminal: string, machine: string, json: boolean): Promise<number> {
  const result = await planSession({ terminal, machine }, { hc: new Hc(), home: homedir() });
  if (!result.ok) return refuse(result.refusal, json);
  process.stdout.write(json ? `${JSON.stringify(jsonPlan(result.plan))}\n` : `${renderPlan(result.plan)}\n`);
  return EXIT.ok;
}

function failure(error: unknown, json: boolean): number {
  if (error instanceof HcError) return fail({ reason: "hc_failed", detail: error.message }, json, EXIT.failed);
  // A local program such as git failing before anything was written, for a session folder that is in no work tree.
  if (error instanceof ProcessError) return fail({ reason: "command_failed", detail: error.message }, json, EXIT.failed);
  return fail({ reason: "unexpected_error", detail: error instanceof Error ? error.message : String(error) }, json, EXIT.failed);
}

process.exitCode = await main(process.argv.slice(2));
