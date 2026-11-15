#!/usr/bin/env node
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configPath, loadConfig, nodeConfigFs, type Config } from "../config/config.ts";
import { InputEnded, LOCAL, renderDoctor, runDoctor, runInit } from "./init.ts";
import { detachedMoves, runDetached, sourceAddress, startDetached, type MoveRow } from "../detach/detach.ts";
import { stateDir, statePath } from "../detach/state.ts";
import { Hc, HcError } from "../platform/hc.ts";
import { moveSession, type MoveOutcome } from "../move/index.ts";
import { shellQuote } from "../move/move.ts";
import { MachineError } from "../platform/machine.ts";
import { ProcessError, processRunner } from "../platform/process.ts";
import { planSession, type SessionPlan } from "../session/index.ts";

const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3, rolledBack: 4 } as const;

const USAGE = [
  "usage: hc-teleport <terminal> <machine> [--dry-run] [--timeout <seconds>] [--json]",
  "       hc-teleport <machine> --detach [--wait <seconds>] [--timeout <seconds>] [--json]",
  "       hc-teleport status [--json]",
  "       hc-teleport init",
  "       hc-teleport doctor [--json]",
  "  <terminal> is tN on the Mac or <machine>/tN on an hc machine; <machine> is an hc machine, or local for the Mac",
  "  --detach, from inside a session, starts a terminal that waits for the session to be idle, moves it and reports in status",
  "  init asks which machines may receive a session and stores the answer; doctor checks those machines",
].join("\n");

const DEFAULT_TIMEOUT_S = 120;
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 600;
const DEFAULT_WAIT_S = 300;
const MIN_WAIT_S = 1;
const MAX_WAIT_S = 3600;

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
    `relocate    ${String(plan.relocate)}`,
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
    relocate: plan.relocate,
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

function parseWait(text: string | undefined): number | undefined {
  if (text === undefined) return DEFAULT_WAIT_S;
  if (!/^\d+$/.test(text)) return undefined;
  const seconds = Number(text);
  return seconds >= MIN_WAIT_S && seconds <= MAX_WAIT_S ? seconds : undefined;
}

function reportMoved(outcome: Extract<MoveOutcome, { status: "moved" }>, json: boolean): number {
  if (outcome.relocated === true) return reportRelocated(outcome, json);
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

function reportRolledBack(outcome: Extract<MoveOutcome, { status: "rolled_back" }>, json: boolean): number {
  const rolledBack = { reason: outcome.reason, detail: outcome.detail, ...(outcome.resumedAt === undefined ? {} : { resumedAt: outcome.resumedAt }) };
  if (json) process.stdout.write(`${JSON.stringify({ rolledBack })}\n`);
  const where = outcome.resumedAt === undefined ? "the source was not touched" : `the session runs again on the source as ${outcome.resumedAt}`;
  process.stderr.write(`hc-teleport: rolled back (${rolledBack.reason}): ${rolledBack.detail}; ${where}\n`);
  return EXIT.rolledBack;
}

function report(outcome: MoveOutcome, json: boolean): number {
  switch (outcome.status) {
    case "moved":
      return reportMoved(outcome, json);
    case "refused":
      return refuse(outcome.refusal, json);
    case "rolled_back":
      return reportRolledBack(outcome, json);
    case "rollback_failed":
      return fail(
        { reason: "rollback_failed", detail: `${outcome.cause}; ${outcome.relocated ? "left" : "left on the destination"}: ${outcome.left.join("; ")}`, cause: outcome.cause, left: outcome.left },
        json,
        EXIT.failed,
      );
    case "source_not_stopped":
      return fail(
        { reason: "source_not_stopped", detail: `the source terminal could not be stopped and still runs; nothing was resumed elsewhere: ${outcome.detail}` },
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

function reportRelocated(outcome: Extract<MoveOutcome, { relocated: true }>, json: boolean): number {
  const { plan, destination, forget, forgetDetail } = outcome;
  process.stdout.write(
    json
      ? `${JSON.stringify({ moved: { terminal: plan.terminal, machine: plan.machine, session: plan.session.id, destination, relocated: true, forget } })}\n`
      : `moved ${plan.terminal} to ${destination} (session ${plan.session.id}); source terminal stopped\n`,
  );
  if (forget === "failed") {
    process.stderr.write(
      `hc-teleport: the herdr-wake record was not forgotten (${forgetDetail ?? "unknown"}): the session may be resumed twice after a reboot; run herdr-wake forget ${plan.terminal}\n`,
    );
  }
  return EXIT.ok;
}

async function main(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        timeout: { type: "string" },
        detach: { type: "boolean" },
        wait: { type: "string" },
        "run-detached": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const json = parsed.values.json === true;
  try {
    return await dispatch(parsed.positionals, {
      dryRun: parsed.values["dry-run"] === true,
      timeout: parsed.values.timeout,
      json,
      detach: parsed.values.detach === true,
      wait: parsed.values.wait,
      runDetached: parsed.values["run-detached"],
    });
  } catch (error) {
    return failure(error, json);
  }
}

type Flags = { dryRun: boolean; timeout: string | undefined; json: boolean; detach: boolean; wait: string | undefined; runDetached: string | undefined };

/** The commands of the detached mode (the runner, `status`, `--detach`); nothing when the arguments are for another command. */
function dispatchDetached(positionals: readonly string[], flags: Flags): Promise<number> | undefined {
  if (flags.runDetached !== undefined) {
    return positionals.length === 0 ? runner(flags.runDetached) : Promise.resolve(usageError("--run-detached takes no terminal or machine"));
  }
  if (flags.detach) return detachFrom(positionals, flags);
  if (positionals.length === 1 && positionals[0] === "status") return statusCommand(flags);
  return flags.wait === undefined ? undefined : Promise.resolve(usageError("--wait only goes with --detach"));
}

function statusCommand(flags: Flags): Promise<number> {
  const stray = flags.wait !== undefined ? "--wait" : flags.timeout !== undefined ? "--timeout" : flags.dryRun ? "--dry-run" : undefined;
  return stray === undefined ? status(flags.json) : Promise.resolve(usageError(`${stray} does not go with status`));
}

async function dispatch(
  positionals: readonly string[],
  flags: Flags,
): Promise<number> {
  const [terminal, machine, ...extra] = positionals;
  const detached = dispatchDetached(positionals, flags);
  if (detached !== undefined) return detached;
  if (terminal === "init" && machine === undefined) return init(flags.json);
  if (terminal === "doctor" && machine === undefined) return doctor(flags.json);
  if (terminal === undefined || machine === undefined || extra.length > 0) {
    return usageError("expected exactly <terminal> and <machine>");
  }
  const timeoutSeconds = parseTimeout(flags.timeout);
  if (timeoutSeconds === undefined) {
    return usageError(`--timeout takes a whole number of seconds from ${MIN_TIMEOUT_S} to ${MAX_TIMEOUT_S}`);
  }
  return teleport({ terminal, machine, timeoutSeconds, dryRun: flags.dryRun, json: flags.json });
}

async function detachFrom(
  positionals: readonly string[],
  flags: { dryRun: boolean; timeout: string | undefined; json: boolean; wait: string | undefined },
): Promise<number> {
  const [machine, ...extra] = positionals;
  if (machine === undefined || extra.length > 0) return usageError("--detach expects exactly <machine>: the session to move is the terminal this runs in");
  if (flags.dryRun) return usageError("--detach and --dry-run cannot go together");
  const timeoutSeconds = parseTimeout(flags.timeout);
  if (timeoutSeconds === undefined) {
    return usageError(`--timeout takes a whole number of seconds from ${String(MIN_TIMEOUT_S)} to ${String(MAX_TIMEOUT_S)}`);
  }
  const waitSeconds = parseWait(flags.wait);
  if (waitSeconds === undefined) return usageError(`--wait takes a whole number of seconds from ${String(MIN_WAIT_S)} to ${String(MAX_WAIT_S)}`);
  return await teleportDetached({ machine, timeoutSeconds, waitSeconds, json: flags.json });
}

type TeleportRequest = { terminal: string; machine: string; timeoutSeconds: number; dryRun: boolean; json: boolean };

async function teleport({ terminal, machine, timeoutSeconds, dryRun, json }: TeleportRequest): Promise<number> {
  const hc = new Hc();
  const gated = await gate(machine, hc);
  if (!gated.ok) return refuse(gated.refusal, json);
  const request = { terminal, machine: gated.machine };
  if (dryRun) return showPlan(request, hc, json);
  return report(await moveSession({ ...request, timeoutSeconds }, { hc, run: processRunner(), home: homedir() }), json);
}

/** From here on every hc call reaches the core: a terminal on an hc machine carries `HC_SESSION`, which would aim them at that machine. */
function reachCore(): void {
  delete process.env["HC_SESSION"];
}

async function teleportDetached({ machine, timeoutSeconds, waitSeconds, json }: { machine: string; timeoutSeconds: number; waitSeconds: number; json: boolean }): Promise<number> {
  const source = sourceAddress(process.env);
  if (!source.ok) {
    return fail({ reason: "not_in_a_terminal", detail: "HC_TERMINAL_ID is not set: --detach moves the session of the hc terminal it runs in" }, json, EXIT.usage);
  }
  reachCore();
  const hc = new Hc();
  const gated = await gate(machine, hc);
  if (!gated.ok) return refuse(gated.refusal, json);
  const started = await startDetached(
    { source: source.source, ...(source.hcSession === undefined ? {} : { hcSession: source.hcSession }), machine: gated.machine, waitSeconds, timeoutSeconds },
    {
      hc,
      // The session types this command, so it is working; the runner checks idleness again before it stops it.
      plan: async (terminal, destination) => {
        const planned = await planSession({ terminal, machine: destination }, { hc, home: homedir(), requireIdle: false });
        return planned.ok ? { ok: true, session: planned.plan.session.id } : planned;
      },
      path: (session) => statePath(process.env, homedir(), session),
      entry: [process.execPath, fileURLToPath(import.meta.url)],
      now: Date.now,
    },
  );
  if (started.status === "refused") return refuse(started.refusal, json);
  const { runner, state } = started;
  process.stdout.write(
    json
      ? `${JSON.stringify({ detached: { runner, source: started.source, machine: started.machine, state } })}\n`
      : `detached: ${runner} will move ${started.source} to ${started.machine} once it is idle; see hc-teleport status\n`,
  );
  return EXIT.ok;
}

/** The terminal `--detach` started: waits, moves and records, exiting 0 only for a session that moved. */
async function runner(stateFile: string): Promise<number> {
  const own = sourceAddress(process.env);
  reachCore();
  const hc = new Hc();
  const run = processRunner();
  const final = await runDetached(stateFile, {
    hc,
    ...(own.ok ? { runner: own.source } : {}),
    move: (request) => moveSession(request, { hc, run, home: homedir() }),
    now: Date.now,
  });
  const reason = final.outcome?.reason === undefined ? "" : ` (${final.outcome.reason}): ${final.outcome.detail ?? ""}`;
  process.stdout.write(`hc-teleport: ${final.phase}${reason}\n`);
  return final.phase === "moved" ? EXIT.ok : EXIT.failed;
}

function renderRow(row: MoveRow): string {
  const what = row.session === undefined ? row.file : `${row.session}  ${row.source ?? "?"} -> ${row.machine ?? "?"}`;
  const runnerNote = row.runner === undefined ? "" : `  runner ${row.runner}`;
  const lost = row.runner_lost === true ? "  runner_lost" : "";
  const why = row.reason === undefined ? (row.detail === undefined ? "" : `: ${row.detail}`) : `  ${row.reason}: ${row.detail ?? ""}`;
  return `${what}  ${row.phase}${lost}${runnerNote}${why}`;
}

async function status(json: boolean): Promise<number> {
  reachCore();
  const moves = await detachedMoves(stateDir(process.env, homedir()), new Hc());
  if (json) process.stdout.write(`${JSON.stringify({ moves })}\n`);
  else process.stdout.write(moves.length === 0 ? "no detached moves\n" : `${moves.map(renderRow).join("\n")}\n`);
  return EXIT.ok;
}

type Gated = { ok: true; machine: string } | { ok: false; refusal: Reason };
type ConfigGate = { ok: true; config: Config; path: string } | { ok: false; refusal: Reason };

async function requireConfig(): Promise<ConfigGate> {
  const path = configPath(process.env, homedir());
  const loaded = await loadConfig(path);
  switch (loaded.kind) {
    case "ok":
      return { ok: true, config: loaded.config, path };
    case "missing":
      return { ok: false, refusal: { reason: "not_initialized", detail: `there is no config at ${path}; run hc-teleport init to choose the machines that may receive a session` } };
    case "unreadable":
      return { ok: false, refusal: { reason: "config_unreadable", detail: `${path} cannot be used: ${loaded.detail}; fix it or run hc-teleport init to write it again` } };
  }
}

/** The machine the move goes to, once the config allows it; the core's own name means `local` unless hc lists a machine of that name. */
async function gate(machine: string, hc: Hc): Promise<Gated> {
  const required = await requireConfig();
  if (!required.ok) return required;
  const destination = await resolveDestination(machine, hc);
  if (required.config.allowed.includes(destination)) return { ok: true, machine: destination };
  return { ok: false, refusal: { reason: "machine_not_allowed", detail: `${machine} is not allowed to receive a session in ${required.path}; run hc-teleport init to allow it` } };
}

async function resolveDestination(machine: string, hc: Hc): Promise<string> {
  if (machine === LOCAL || machine !== (await hc.serverStatus())) return machine;
  return (await hc.machines()).some(({ name }) => name === machine) ? machine : LOCAL;
}

async function init(json: boolean): Promise<number> {
  if (!process.stdin.isTTY) {
    return refuse({ reason: "not_interactive", detail: "init asks questions and needs a terminal on stdin" }, json);
  }
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<never>((_resolve, reject) => lines.once("close", () => {
    reject(new InputEnded());
  }));
  closed.catch(() => undefined);
  try {
    await runInit({
      hc: new Hc(),
      ask: (question) => Promise.race([lines.question(question), closed]),
      out: (line) => process.stdout.write(`${line}\n`),
      path: configPath(process.env, homedir()),
      fs: nodeConfigFs,
    });
    return EXIT.ok;
  } finally {
    lines.close();
  }
}

async function doctor(json: boolean): Promise<number> {
  const required = await requireConfig();
  if (!required.ok) return refuse(required.refusal, json);
  const lines = await runDoctor({ hc: new Hc(), config: required.config });
  const { text, exit } = renderDoctor(lines);
  process.stdout.write(json ? `${JSON.stringify({ machines: lines })}\n` : `${text === "" ? "no machine is allowed to receive a session; run hc-teleport init" : text}\n`);
  return exit;
}

async function showPlan(request: { terminal: string; machine: string }, hc: Hc, json: boolean): Promise<number> {
  const result = await planSession(request, { hc, home: homedir() });
  if (!result.ok) return refuse(result.refusal, json);
  process.stdout.write(json ? `${JSON.stringify(jsonPlan(result.plan))}\n` : `${renderPlan(result.plan)}\n`);
  return EXIT.ok;
}

function failure(error: unknown, json: boolean): number {
  if (error instanceof InputEnded) return fail({ reason: "input_ended", detail: error.message }, json, EXIT.failed);
  if (error instanceof HcError || (error instanceof MachineError && error.code === "exec_failed")) return fail({ reason: "hc_failed", detail: error.message }, json, EXIT.failed);
  // A program a move runs failing before anything is recorded as written: the preflight's git on the source for a
  // session folder that is in no work tree; and, in the git carry, git or cp on the source (the Mac or an hc
  // machine), mktemp or rm only on an hc machine as the source, the Mac's `git push` as the source, its `git fetch`
  // as the destination, and the update-ref and ref cleanup that fetch runs on the source.
  if (error instanceof ProcessError) return fail({ reason: "command_failed", detail: error.message }, json, EXIT.failed);
  return fail({ reason: "unexpected_error", detail: error instanceof Error ? error.message : String(error) }, json, EXIT.failed);
}

process.exitCode = await main(process.argv.slice(2));
