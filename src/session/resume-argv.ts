import type { AdapterRefusal, ResumeArgvResult } from "./agent-adapter.ts";

const KEPT_WITH_VALUE: ReadonlySet<string> = new Set([
  "--model",
  "--permission-mode",
  "--effort",
  "--fallback-model",
  "--agent",
  "--name",
  "-n",
]);

const KEPT_WITHOUT_VALUE: ReadonlySet<string> = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--brief",
  "--chrome",
  "--no-chrome",
  "--verbose",
]);

const DROPPED_WITHOUT_VALUE: ReadonlySet<string> = new Set(["-c", "--continue", "--fork-session"]);
const DROPPED_WITH_VALUE: ReadonlySet<string> = new Set(["--session-id"]);
const DROPPED_WITH_OPTIONAL_VALUE: ReadonlySet<string> = new Set(["-r", "--resume"]);

function refuse(reason: AdapterRefusal["reason"], detail: string): ResumeArgvResult {
  return { ok: false, refusal: { reason, detail } };
}

function splitFlag(token: string): { name: string; hasInlineValue: boolean } {
  const equals = token.startsWith("--") ? token.indexOf("=") : -1;
  return equals === -1
    ? { name: token, hasInlineValue: false }
    : { name: token.slice(0, equals), hasInlineValue: true };
}

/**
 * The executable of the source, its allowed flags in their order, then
 * `--resume <sessionId>`. Session selectors and positionals are dropped
 * because the resume replaces them; any other flag refuses, since a flag
 * whose arity is unknown cannot be carried safely.
 */
export function buildResumeArgv(source: readonly string[], sessionId: string): ResumeArgvResult {
  const [executable = "", ...rest] = source;
  const kept: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? "";
    if (token === "--") break;
    if (!token.startsWith("-")) continue;

    const { name, hasInlineValue } = splitFlag(token);
    const next = rest[i + 1];
    if (KEPT_WITH_VALUE.has(name)) {
      if (hasInlineValue) {
        kept.push(token);
      } else if (next === undefined) {
        return refuse("flag_missing_value", name);
      } else {
        kept.push(token, next);
        i += 1;
      }
    } else if (KEPT_WITHOUT_VALUE.has(name) && !hasInlineValue) {
      kept.push(token);
    } else if (DROPPED_WITHOUT_VALUE.has(name) && !hasInlineValue) {
      continue;
    } else if (DROPPED_WITH_VALUE.has(name)) {
      if (!hasInlineValue) {
        if (next === undefined) return refuse("flag_missing_value", name);
        i += 1;
      }
    } else if (DROPPED_WITH_OPTIONAL_VALUE.has(name)) {
      if (!hasInlineValue && next !== undefined && !next.startsWith("-")) i += 1;
    } else {
      return refuse("flag_not_allowed", name);
    }
  }
  return { ok: true, argv: [executable, ...kept, "--resume", sessionId] };
}
