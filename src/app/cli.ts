#!/usr/bin/env node
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Hc, HcError } from "../platform/hc.ts";
import { planSession, type SessionPlan, type SessionRefusal } from "../session/index.ts";

const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

const USAGE = "usage: hc-teleport <terminal> <machine> --dry-run [--json]";

function shellQuote(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}

function renderPlan(plan: SessionPlan): string {
  const version = plan.session.version === undefined ? "" : ` (Claude Code ${plan.session.version})`;
  return [
    `terminal    ${plan.terminal}`,
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

function refuse(refusal: SessionRefusal, json: boolean): number {
  if (json) process.stdout.write(`${JSON.stringify({ refused: refusal })}\n`);
  process.stderr.write(`hc-teleport: refused (${refusal.reason}): ${refusal.detail}\n`);
  return EXIT.refused;
}

async function main(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { "dry-run": { type: "boolean" }, json: { type: "boolean" } },
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
  if (parsed.values["dry-run"] !== true) return usageError("only --dry-run is supported");
  const json = parsed.values.json === true;

  try {
    const result = await planSession(
      { terminal, machine },
      { hc: new Hc(), home: homedir() },
    );
    if (!result.ok) return refuse(result.refusal, json);
    process.stdout.write(json ? `${JSON.stringify(jsonPlan(result.plan))}\n` : `${renderPlan(result.plan)}\n`);
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof HcError)) throw error;
    if (json) process.stdout.write(`${JSON.stringify({ error: { reason: "hc_failed", detail: error.message } })}\n`);
    process.stderr.write(`hc-teleport: hc_failed: ${error.message}\n`);
    return EXIT.failed;
  }
}

process.exitCode = await main(process.argv.slice(2));
