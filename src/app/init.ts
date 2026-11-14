import { loadConfig, saveConfig, type Config, type ConfigFs } from "../config/config.ts";
import type { Hc } from "../platform/hc.ts";
import { HcError } from "../platform/hc.ts";

/** The name `local` takes in the config: the machine the core runs on. */
export const LOCAL = "local";

const DOCTOR_TIMEOUT_S = 15;

/** The prompt closed before every question was answered. */
export class InputEnded extends Error {
  constructor() {
    super("the input ended before every question was answered");
    this.name = "InputEnded";
  }
}

export type Ask = (question: string) => Promise<string>;

export type InitIo = {
  hc: Pick<Hc, "serverStatus" | "machines">;
  ask: Ask;
  out: (line: string) => void;
  path: string;
  fs: ConfigFs;
};

type Offer = { name: string; label: string };

/** Asks about the core and each hc machine, then stores the answers; nothing is written until the last one. */
export async function runInit(io: InitIo): Promise<Config> {
  const [coreName, machines, previous] = await Promise.all([io.hc.serverStatus(), io.hc.machines(), loadConfig(io.path, io.fs)]);
  const before = new Set(previous.kind === "ok" ? previous.config.allowed : []);
  const offers: Offer[] = [
    { name: LOCAL, label: `${coreName} (the machine the core runs on)` },
    ...machines.map(({ name }) => ({ name, label: name })),
  ];
  const allowed: string[] = [];
  for (const offer of offers) {
    if (await answer(io.ask, offer.label, before.has(offer.name))) allowed.push(offer.name);
  }
  const config: Config = { v: 1, allowed };
  await saveConfig(io.path, config, io.fs);
  io.out(`wrote ${io.path}`);
  io.out(allowed.length === 0 ? "no machine may receive a session" : `allowed: ${allowed.join(", ")}`);
  return config;
}

async function answer(ask: Ask, label: string, current: boolean): Promise<boolean> {
  const question = `Allow ${label} to receive a session? [${current ? "Y/n" : "y/N"}] `;
  for (;;) {
    const reply = (await ask(question)).trim().toLowerCase();
    if (reply === "") return current;
    if (reply === "y" || reply === "yes") return true;
    if (reply === "n" || reply === "no") return false;
  }
}

export type DoctorLine = { name: string; status: string; detail: string };

export type DoctorIo = {
  hc: Pick<Hc, "machines" | "exec">;
  config: Config;
};

/** One line per allowed machine: reachable through hc, and `claude --version` runs there. Reads only. */
export async function runDoctor(io: DoctorIo): Promise<DoctorLine[]> {
  const remote = io.config.allowed.some((name) => name !== LOCAL);
  const listed = remote ? new Set((await io.hc.machines()).map(({ name }) => name)) : new Set<string>();
  return Promise.all(io.config.allowed.map((name) => check(io.hc, name, name === LOCAL || listed.has(name))));
}

async function check(hc: DoctorIo["hc"], name: string, known: boolean): Promise<DoctorLine> {
  if (!known) return { name, status: "not in hc machine ls", detail: "" };
  try {
    const result = await hc.exec(["claude", "--version"], { timeout: DOCTOR_TIMEOUT_S, ...(name === LOCAL ? {} : { on: name }) });
    return result.code === 0
      ? { name, status: "ok", detail: result.stdout.trim() }
      : { name, status: "claude missing", detail: result.stderr.trim() || `exit ${String(result.code)}` };
  } catch (error) {
    if (error instanceof HcError && error.kind === "spawn_failed") return { name, status: "claude missing", detail: error.message };
    if (error instanceof HcError) return { name, status: "unreachable", detail: error.message };
    throw error;
  }
}

/** The lines as text and the exit code: 0 only when every machine is ok. */
export function renderDoctor(lines: readonly DoctorLine[]): { text: string; exit: 0 | 1 } {
  const text = lines.map(({ name, status, detail }) => [name, status, detail].filter((part) => part !== "").join("  ")).join("\n");
  return { text, exit: lines.every(({ status }) => status === "ok") ? 0 : 1 };
}
