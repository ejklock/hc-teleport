import type { HcTerminal } from "../platform/hc.ts";

export type AgentSession = {
  id: string;
  configDir: string;
  version?: string;
  transcript: { file: string; dir?: string };
};

export type AdapterRefusalReason =
  | "not_claude"
  | "config_dir_unknown"
  | "no_session"
  | "session_registry_unreadable"
  | "session_registry_stale"
  | "flag_not_allowed"
  | "flag_missing_value";

export type AdapterRefusal = { reason: AdapterRefusalReason; detail: string };

export type SessionResult = { ok: true; session: AgentSession } | { ok: false; refusal: AdapterRefusal };

export type ResumeArgvResult = { ok: true; argv: readonly string[] } | { ok: false; refusal: AdapterRefusal };

/** What the core needs from a coding agent; each agent enters through one implementation. */
export interface AgentAdapter {
  /** Whether the terminal is running this agent. */
  recognizes(terminal: HcTerminal): boolean;
  /** The session behind a recognized terminal and where its transcript lives, or why it cannot be found. */
  findSession(terminal: HcTerminal): Promise<SessionResult>;
  /** The command that resumes the session, derived from the argv the terminal was started with. */
  buildResumeArgv(source: readonly string[], sessionId: string): ResumeArgvResult;
}
