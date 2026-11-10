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

export type DestinationRefusalReason =
  | "dest_executable_missing"
  | "dest_profile_missing"
  | "dest_agent_older"
  | "dest_agent_version_unknown";

export type DestinationRefusal = { reason: DestinationRefusalReason; detail: string };

/** Runs a program on the destination machine, with no shell; a non-zero exit is a result. */
export type RemoteRun = {
  machine: string;
  run(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
};

export type DestinationRequest = {
  /** The program the destination will run to resume the session. */
  executable: string;
  /** The destination user's home directory. */
  home: string;
  /** What the source ran, as that agent prints it. */
  sourceVersion?: string;
};

export type DestinationResult =
  | { ok: true; configDir: string; version: string }
  | { ok: false; refusal: DestinationRefusal };

/** What the core needs from a coding agent; each agent enters through one implementation. */
export interface AgentAdapter {
  /** Whether the terminal is running this agent. */
  recognizes(terminal: HcTerminal): boolean;
  /** The session behind a recognized terminal and where its transcript lives, or why it cannot be found. */
  findSession(terminal: HcTerminal): Promise<SessionResult>;
  /** The command that resumes the session, derived from the argv the terminal was started with. */
  buildResumeArgv(source: readonly string[], sessionId: string): ResumeArgvResult;
  /**
   * Whether the destination can resume the session: the executable runs there, its
   * profile directory exists and its version is not older than the source's. Read-only.
   */
  checkDestination(request: DestinationRequest, remote: RemoteRun): Promise<DestinationResult>;
}
