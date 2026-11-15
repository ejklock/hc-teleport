import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type OpencodeCommand = { template: string; description: string };
type OpencodeConfig = {
  command?: Record<string, OpencodeCommand>;
  skills?: { paths?: string[] };
};

const skillsDir = fileURLToPath(new URL("./skills", import.meta.url));
const promptFile = fileURLToPath(new URL("./prompts/hc-teleport.md", import.meta.url));

const promptParts = (): OpencodeCommand => {
  const text = readFileSync(promptFile, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const description = /^description: (.+)$/m.exec(match?.[1] ?? "")?.[1];
  if (match?.[2] === undefined || description === undefined) throw new Error(`malformed prompt: ${promptFile}`);
  return { template: match[2], description };
};

// OpenCode 1.19 registers a skills directory and a custom command only by
// mutating the merged config in the `config` hook. A user's own `hc-teleport`
// command wins over the default, and the skills directory is listed once
// however often the hook runs.
export const server = (): Promise<{ config: (config: OpencodeConfig) => Promise<void> }> =>
  Promise.resolve({
    config: (config: OpencodeConfig): Promise<void> => {
      config.command = { "hc-teleport": promptParts(), ...config.command };
      const paths = config.skills?.paths ?? [];
      config.skills = { ...config.skills, paths: paths.includes(skillsDir) ? paths : [...paths, skillsDir] };
      return Promise.resolve();
    },
  });
