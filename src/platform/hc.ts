import { z } from "zod";
import { ProcessError, runProcess, type Runner } from "./process.ts";

const processSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  pid: z.number().int(),
});

const terminalSchema = z.object({
  address: z.string(),
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  state: z.string(),
  exit_code: z
    .number()
    .nullish()
    .transform((code) => code ?? undefined),
  status: z.object({ state: z.string() }).optional(),
  foreground: processSchema.optional(),
});

const machinesSchema = z.object({
  machines: z.array(z.object({ name: z.string(), state: z.string() })),
});

export type HcTerminal = z.infer<typeof terminalSchema>;
export type HcMachine = z.infer<typeof machinesSchema>["machines"][number];

export class HcError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "HcError";
  }
}

/** Typed access to the `hc` CLI; every reply is parsed before it leaves. */
export class Hc {
  readonly #run: Runner;

  constructor(run: Runner = runProcess) {
    this.#run = run;
  }

  terminal(address: string): Promise<HcTerminal> {
    return this.#query(["get", address, "--json"], terminalSchema);
  }

  async machines(): Promise<readonly HcMachine[]> {
    const reply = await this.#query(["machine", "ls", "--json"], machinesSchema);
    return reply.machines;
  }

  async #query<T extends z.ZodType>(args: readonly string[], schema: T): Promise<z.infer<T>> {
    let output: string;
    try {
      output = await this.#run("hc", args);
    } catch (error) {
      if (error instanceof ProcessError) throw new HcError(error.message);
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(output);
    } catch {
      throw new HcError(`hc ${args.join(" ")} printed output that is not JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new HcError(`hc ${args.join(" ")} printed an unexpected shape: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
