import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const PHASES = ["waiting", "moving", "moved", "refused", "rolled_back", "rollback_failed", "source_running", "source_not_stopped", "timeout"] as const;
const RUNNING: ReadonlySet<string> = new Set(["waiting", "moving"]);

const outcomeSchema = z.object({
  reason: z.string().optional(),
  detail: z.string().optional(),
  destination: z.string().optional(),
  resumedAt: z.string().optional(),
});

const stateSchema = z.object({
  v: z.literal(1),
  session: z.string().min(1),
  source: z.string().min(1),
  machine: z.string().min(1),
  phase: z.enum(PHASES),
  runner: z.string().min(1).optional(),
  waitSeconds: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
  startedAt: z.number().int(),
  outcome: outcomeSchema.optional(),
  sendError: z.string().optional(),
});

/** One detached move as its runner reports it. The runner terminal's hc name, not this file, is what keeps a second move of the session out. */
export type DetachedState = z.infer<typeof stateSchema>;
export type Phase = DetachedState["phase"];
export type StoredOutcome = z.infer<typeof outcomeSchema>;

export type ReadState = { kind: "ok"; state: DetachedState } | { kind: "unreadable"; detail: string; missing?: true };

/** True once the move has ended. */
export function isFinal(phase: Phase): boolean {
  return !RUNNING.has(phase);
}

/** `$XDG_STATE_HOME` when it is an absolute path (the XDG rule), else `$HOME/.local/state`. */
export function stateDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const xdg = env["XDG_STATE_HOME"];
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), "hc-teleport");
}

export function statePath(env: Readonly<Record<string, string | undefined>>, home: string, session: string): string {
  return join(stateDir(env, home), `${session}.json`);
}

export async function readState(path: string): Promise<ReadState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { kind: "unreadable", detail: error instanceof Error ? error.message : String(error), ...(isMissing(error) ? { missing: true as const } : {}) };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "unreadable", detail: "the file is not JSON" };
  }
  const parsed = stateSchema.safeParse(json);
  return parsed.success ? { kind: "ok", state: parsed.data } : { kind: "unreadable", detail: parsed.error.message };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Replaces the file through a temporary file and a rename, then parses it back so a bad write is never taken for a good one. */
export async function writeState(path: string, state: DetachedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(stateSchema.parse(state))}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const back = await readState(path);
  if (back.kind !== "ok") throw new Error(`${path} was written but reads back as unusable: ${back.detail}`);
}

/** Removes the state file of a move that never started. */
export async function discardState(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Every state file in the folder, in name order; a missing folder holds none. */
export async function listStates(dir: string): Promise<{ path: string; read: ReadState }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const files = names.filter((name) => name.endsWith(".json")).sort();
  return Promise.all(files.map(async (name) => ({ path: join(dir, name), read: await readState(join(dir, name)) })));
}
