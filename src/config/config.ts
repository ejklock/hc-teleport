import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  v: z.literal(1),
  allowed: z.array(z.string().min(1)),
});

/** The machines allowed to receive a session: names as `hc machine ls` prints them, and `local` for the core's own machine. */
export type Config = z.infer<typeof configSchema>;

export type LoadedConfig =
  | { kind: "ok"; config: Config }
  | { kind: "missing" }
  | { kind: "unreadable"; detail: string };

/** The file system calls the config needs; tests pass their own. */
export type ConfigFs = {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
};

export const nodeConfigFs: ConfigFs = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, text) => writeFile(path, text),
  rename,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  rm: (path) => rm(path, { force: true }),
};

/** `$XDG_CONFIG_HOME` when it is an absolute path (the XDG rule), else `$HOME/.config`. */
export function configPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "hc-teleport", "config.json");
}

export async function loadConfig(path: string, fs: ConfigFs = nodeConfigFs): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await fs.readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "unreadable", detail: "the file is not JSON" };
  }
  const parsed = configSchema.safeParse(json);
  return parsed.success ? { kind: "ok", config: parsed.data } : { kind: "unreadable", detail: parsed.error.message };
}

/** Writes through a temporary file in the same folder and a rename, so a reader never sees half a file. */
export async function saveConfig(path: string, config: Config, fs: ConfigFs = nodeConfigFs): Promise<void> {
  await fs.mkdir(dirname(path));
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config)}\n`);
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary).catch(() => undefined);
    throw error;
  }
}
