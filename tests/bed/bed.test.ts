import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Bed,
  BED_PROJECT_ROOT,
  BED_START_BUDGET_MS,
  BED_START_TIMEOUT_MS,
  BedError,
  REPO_MOUNT,
} from "./bed.ts";

const CLI = `${REPO_MOUNT}/src/app/cli.ts`;
const SESSION_WAIT_SECONDS = 15;
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const VERSION = /^\d+\.\d+\.\d+/;
const START_BUDGET_MS = 30_000;
/** What a failed start may spend on top of its budget to tear itself down. */
const TEARDOWN_ALLOWANCE_MS = 45_000;
/** Far above the elapsed bound, so a start that overruns fails an assertion rather than timing out the test. */
const DEADLINE_TEST_TIMEOUT_MS = 300_000;
const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function machinesOf(bed: Bed): Promise<unknown> {
  const listed = await bed.run("source", ["hc", "machine", "ls", "--json"]);
  return JSON.parse(listed.stdout);
}

const foregroundSchema = z.object({
  foreground: z.object({ pid: z.number() }).optional(),
});

/** hc reports the foreground process of a terminal a moment after the terminal starts. */
async function foregroundOf(
  bed: Bed,
  address: string,
): Promise<{ pid: number }> {
  for (let attempt = 0; attempt < SESSION_WAIT_SECONDS * 2; attempt += 1) {
    const got = await bed.run("source", ["hc", "get", address, "--json"]);
    const parsed = foregroundSchema.parse(JSON.parse(got.stdout));
    if (parsed.foreground !== undefined) return parsed.foreground;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`hc never reported a foreground process for ${address}`);
}

/** A start that resolves anyway is stopped before the test fails, so it never leaks containers, a network or a key directory. */
async function failureOf(start: Promise<Bed>): Promise<Error> {
  const outcome = await start.then(
    (bed) => ({ bed }),
    (error: unknown) => ({ error }),
  );
  if ("bed" in outcome) {
    await outcome.bed.stop();
    expect.fail("the start was expected to fail but resolved");
  }
  expect(outcome.error).toBeInstanceOf(Error);
  return outcome.error as Error;
}

/** The bed's project name, from the compose project or the key directory its failure message names. */
function projectOf(message: string): string {
  const named = /-p (hcbed-[a-z0-9]+) /.exec(message)?.[1];
  const keyed = /hc-teleport-bed-([A-Za-z0-9]+)\//.exec(message)?.[1];
  const project = named ?? (keyed && `hcbed-${keyed.toLowerCase()}`);
  if (project === undefined || project === "")
    expect.fail(`no bed project in: ${message}`);
  return project;
}

/** The key directories of one bed, whatever else runs in $TMPDIR; the directory suffix is the project suffix, case-insensitively. */
async function keyDirsOf(project: string): Promise<string[]> {
  return (await readdir(tmpdir())).filter(
    (name) =>
      name.toLowerCase() ===
      `hc-teleport-bed-${project.slice("hcbed-".length)}`,
  );
}

/** Builds the bed image outside any start budget, so a cold cache cannot eat it. */
async function buildImage(composeFile: string): Promise<void> {
  await run(
    "docker",
    ["compose", "-p", "hcbed-prebuild", "-f", composeFile, "build", "source"],
    {
      env: {
        ...process.env,
        BED_KEY_DIR: tmpdir(),
        BED_REPO: REPO_ROOT,
        BED_SUBNET: "10.200.0.0/24",
      },
    },
  );
}

/** Removes whatever a bed project still has, for a test that failed before its own teardown. */
async function removeLeftovers(project: string): Promise<void> {
  const filter = `label=com.docker.compose.project=${project}`;
  const ids = async (args: string[]) =>
    (await run("docker", args)).stdout.split("\n").filter((id) => id !== "");
  const containers = await ids(["ps", "-aq", "--filter", filter]);
  if (containers.length > 0) await run("docker", ["rm", "-f", ...containers]);
  const networks = await ids(["network", "ls", "-q", "--filter", filter]);
  if (networks.length > 0) await run("docker", ["network", "rm", ...networks]);
}

/** A `docker` first on PATH that runs `body` (a sh script, with the real docker reachable as `docker`) in place of the real one. */
async function dockerShim(
  body: string,
): Promise<{ remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "hc-teleport-shim-"));
  const file = join(dir, "docker");
  await writeFile(file, `#!/bin/sh\nPATH="$BED_REAL_PATH"\n${body}\n`);
  await chmod(file, 0o755);
  const path = process.env["PATH"] ?? "";
  vi.stubEnv("BED_REAL_PATH", path);
  vi.stubEnv("PATH", `${dir}:${path}`);
  return {
    remove: async () => {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A copy of the compose file under $TMPDIR, its build context pointing at the real one, so nothing is written into the repository. */
async function composeCopy(
  edit: (text: string) => string,
): Promise<{ dir: string; composeFile: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "hc-teleport-compose-copy-"));
  const composeFile = join(dir, "compose.yaml");
  const text = await readFile(
    join(import.meta.dirname, "compose.yaml"),
    "utf8",
  );
  await writeFile(
    composeFile,
    edit(text.replace("build: .", `build: ${import.meta.dirname}`)),
  );
  return {
    dir,
    composeFile,
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("test bed", () => {
  it(
    "starts and stops the bed",
    async () => {
      const bed = await Bed.start();
      const { project, keyDir } = bed;
      try {
        const who = ["sh", "-c", 'echo "$(id -un) $HOME"'];
        expect((await bed.run("source", who)).stdout.trim()).toBe(
          "mac /Users/mac",
        );
        expect((await bed.run("dest", who)).stdout.trim()).toBe(
          "box /home/box",
        );
        for (const side of ["source", "dest"] as const) {
          expect(
            (await bed.run(side, ["test", "-d", BED_PROJECT_ROOT])).code,
          ).toBe(0);
        }
        const keys = await bed.run("dest", [
          "sh",
          "-c",
          "ls ~/.ssh | grep -c '^id_' || true",
        ]);
        expect(keys.stdout.trim()).toBe("0");
        expect(await machinesOf(bed)).toMatchObject({
          machines: [{ name: "dest", state: "connected" }],
        });
      } finally {
        await bed.stop();
      }
      expect(await Bed.residue(project)).toEqual([]);
      await expect(access(keyDir)).rejects.toThrow(/ENOENT/);
    },
    BED_START_TIMEOUT_MS * 2,
  );

  it(
    "starts and stops the bed: fails with the failing step and its stderr when the bed cannot start",
    async () => {
      const failure = await failureOf(
        Bed.start({ composeFile: "/nonexistent/compose.yaml" }),
      );
      expect(failure.message).toMatch(
        /^docker compose .*\/nonexistent\/compose\.yaml build source: /,
      );
      expect(failure.message).toMatch(/no such file|not found|does not exist/i);
      // The teardown fails too, on the same missing file; it rides along without taking the lead.
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors as Error[];
      expect(errors).toHaveLength(2);
      expect(errors[1]?.message).toMatch(
        /down --volumes --remove-orphans --timeout 5: /,
      );
    },
    BED_START_TIMEOUT_MS,
  );

  it(
    "starts and stops the bed: retries a teardown that failed and ignores a second stop once it worked",
    async () => {
      const scratch = await composeCopy((text) => text);
      const moved = `${scratch.composeFile}.moved`;
      try {
        const bed = await Bed.start({ composeFile: scratch.composeFile });
        await rename(scratch.composeFile, moved);
        await expect(bed.stop()).rejects.toThrow(
          /down --volumes --remove-orphans --timeout 5: /,
        );
        expect((await Bed.residue(bed.project)).length).toBeGreaterThan(0);
        await rename(moved, scratch.composeFile);
        await bed.stop();
        expect(await Bed.residue(bed.project)).toEqual([]);
        // A second stop runs no compose command: with the file gone it would reject.
        await rename(scratch.composeFile, moved);
        await bed.stop();
      } finally {
        await scratch.remove();
      }
    },
    BED_START_TIMEOUT_MS * 2,
  );

  it("starts and stops the bed: gives itself less time than the hook that waits for it", () => {
    expect(BED_START_BUDGET_MS).toBeLessThan(BED_START_TIMEOUT_MS);
  });

  it(
    "starts and stops the bed: fails naming the step that ran out of time",
    async () => {
      const failure = await failureOf(Bed.start({ budgetMs: 1 }));
      expect(failure.message).toMatch(
        /^ssh-keygen .*: start budget of 1 ms ran out/,
      );
      expect(await keyDirsOf(projectOf(failure.message))).toEqual([]);
    },
    BED_START_TIMEOUT_MS,
  );

  it(
    "starts and stops the bed: cuts a compose step that outlasts the budget and leaves nothing behind",
    async () => {
      // Healthchecks that fail inside a long start period keep `up --wait` blocked.
      const scratch = await composeCopy((text) =>
        text.replace(
          'test: ["CMD-SHELL", "test -s /run/sshd.pid"]',
          'test: ["CMD-SHELL", "false"]\n      start_period: 300s',
        ),
      );
      try {
        await buildImage(scratch.composeFile);
        const started = Date.now();
        const failure = await failureOf(
          Bed.start({
            composeFile: scratch.composeFile,
            budgetMs: START_BUDGET_MS,
          }),
        );
        const elapsed = Date.now() - started;
        const project = projectOf(failure.message);
        try {
          expect(elapsed).toBeLessThan(START_BUDGET_MS + TEARDOWN_ALLOWANCE_MS);
          // Compose stopped on its own wait timeout: it exited, or it exited 0 and the health check failed; the kill never fired.
          expect(failure.message).toMatch(
            /^docker compose -p hcbed-[a-z0-9]+ .* up --detach .*: (exit \d+|\w+ is not healthy)/,
          );
          expect(failure.message).not.toMatch(/timed out after/);
          expect(await Bed.residue(project)).toEqual([]);
          expect(await keyDirsOf(project)).toEqual([]);
        } finally {
          await removeLeftovers(project);
        }
      } finally {
        await scratch.remove();
      }
    },
    DEADLINE_TEST_TIMEOUT_MS,
  );

  it(
    "starts and stops the bed: kills a compose step that ignores SIGTERM when its time is up",
    async () => {
      const shim = await dockerShim(
        'case " $* " in\n*" up "*) trap \'\' TERM; exec sleep 100 ;;\nesac\nexec docker "$@"',
      );
      try {
        const started = Date.now();
        const failure = await failureOf(Bed.start({ budgetMs: 20_000 }));
        expect(Date.now() - started).toBeLessThan(
          20_000 + TEARDOWN_ALLOWANCE_MS,
        );
        expect(failure.message).toMatch(
          /^docker compose -p hcbed-[a-z0-9]+ .* up --detach .*: timed out after \d+ ms/,
        );
        expect(await keyDirsOf(projectOf(failure.message))).toEqual([]);
      } finally {
        await shim.remove();
      }
    },
    DEADLINE_TEST_TIMEOUT_MS,
  );

  it(
    "starts and stops the bed: fails naming up when compose exits 0 while a service is not healthy",
    async () => {
      const scratch = await composeCopy((text) =>
        text.replace(
          'test: ["CMD-SHELL", "test -s /run/sshd.pid"]',
          'test: ["CMD-SHELL", "false"]\n      start_period: 300s',
        ),
      );
      // `up` starts the containers without waiting and reports success, as compose does when its wait timeout runs out.
      const shim = await dockerShim(
        'case " $* " in\n*" up "*) docker compose -p "$3" -f "$5" up --detach > /dev/null 2>&1; exit 0 ;;\nesac\nexec docker "$@"',
      );
      let project: string | undefined;
      try {
        const failure = await failureOf(
          Bed.start({ composeFile: scratch.composeFile }),
        );
        project = projectOf(failure.message);
        expect(failure.message).toMatch(
          /^docker compose -p hcbed-[a-z0-9]+ .* up --detach .*: (source|dest) is not healthy \(starting\)/,
        );
        expect(await Bed.residue(project)).toEqual([]);
        expect(await keyDirsOf(project)).toEqual([]);
      } finally {
        await shim.remove();
        if (project !== undefined) await removeLeftovers(project);
        await scratch.remove();
      }
    },
    DEADLINE_TEST_TIMEOUT_MS,
  );

  it.each([
    { title: "valid JSON without a Service", reply: '{"State":"running"}' },
    { title: "not JSON", reply: "no containers here" },
  ])(
    "starts and stops the bed: fails naming the ps command when its reply is $title",
    async ({ reply }) => {
      const shim = await dockerShim(
        `case " $* " in\n*" ps --all --format json "*) echo '${reply}'; exit 0 ;;\nesac\nexec docker "$@"`,
      );
      let project: string | undefined;
      try {
        const failure = await failureOf(Bed.start());
        project = projectOf(failure.message);
        expect(failure).toBeInstanceOf(BedError);
        expect(failure.message).toMatch(
          /^docker compose -p hcbed-[a-z0-9]+ -f \S+ ps --all --format json: /,
        );
        expect(await Bed.residue(project)).toEqual([]);
        expect(await keyDirsOf(project)).toEqual([]);
      } finally {
        await shim.remove();
        if (project !== undefined) await removeLeftovers(project);
      }
    },
    DEADLINE_TEST_TIMEOUT_MS,
  );

  it.each([
    { firstTeardownFails: false, title: "worked" },
    { firstTeardownFails: true, title: "failed" },
  ])(
    "starts and stops the bed: removes what a start left behind after a first teardown that $title",
    async ({ firstTeardownFails }) => {
      // The first `down` leaves a labelled container behind, as a `down` racing
      // a container still being created would.
      const scratch = await composeCopy((text) =>
        text
          .replace(
            'test: ["CMD-SHELL", "test -s /run/sshd.pid"]',
            'test: ["CMD-SHELL", "false"]',
          )
          .replace("retries: 60", "retries: 1"),
      );
      const mark = join(scratch.dir, "planted");
      const shim = await dockerShim(
        [
          'docker "$@"; status=$?',
          'case " $* " in',
          '*" down "*)',
          `  if [ ! -e ${mark} ]; then`,
          `    : > ${mark}`,
          '    docker compose -p "$3" -f "$5" create dest > /dev/null 2>&1',
          firstTeardownFails ? "    status=1" : "    :",
          "  fi ;;",
          "esac",
          'exit "$status"',
        ].join("\n"),
      );
      let project: string | undefined;
      try {
        const failure = await failureOf(
          Bed.start({ composeFile: scratch.composeFile }),
        );
        project = projectOf(failure.message);
        expect(failure.message).toMatch(
          /^docker compose -p hcbed-[a-z0-9]+ .* up --detach .*: /,
        );
        if (firstTeardownFails) {
          expect(failure).toBeInstanceOf(AggregateError);
          const errors = (failure as AggregateError).errors as Error[];
          expect(errors).toHaveLength(2);
          expect(errors[0]?.message).toBe(
            failure.message.split("\n(the teardown failed too")[0],
          );
          expect(errors[1]?.message).toMatch(/ down --volumes .*: exit 1/);
        }
        expect(await Bed.residue(project)).toEqual([]);
      } finally {
        await shim.remove();
        if (project !== undefined) await removeLeftovers(project);
        await scratch.remove();
      }
    },
    DEADLINE_TEST_TIMEOUT_MS,
  );

  describe("on a running bed", () => {
    let bed: Bed;

    beforeAll(async () => {
      bed = await Bed.start();
    }, BED_START_TIMEOUT_MS);

    afterAll(async () => {
      await bed?.stop();
    });

    it("reaches dest over hc and ssh", async () => {
      for (const side of ["source", "dest"] as const) {
        expect((await bed.run(side, ["hc", "--version"])).stdout).toContain(
          "0.1.19",
        );
      }
      expect(await machinesOf(bed)).toMatchObject({
        machines: [{ name: "dest", state: "connected" }],
      });

      const arch = await bed.run("source", ["uname", "-m"]);
      const remoteArch = await bed.run("source", [
        "hc",
        "exec",
        "--on",
        "dest",
        "--",
        "uname",
        "-m",
      ]);
      expect(remoteArch.code).toBe(0);
      expect(remoteArch.stdout.trim()).toBe(arch.stdout.trim());

      const repo = `${BED_PROJECT_ROOT}/carry.git`;
      expect(
        (await bed.run("dest", ["git", "init", "--bare", "-q", repo])).code,
      ).toBe(0);
      const remote = `dest:${repo}`;
      expect((await bed.run("source", ["git", "ls-remote", remote])).code).toBe(
        0,
      );
      const commit =
        "git -c user.name=bed -c user.email=bed@example.test commit -q --allow-empty -m probe";
      const push = await bed.run(
        "source",
        [
          "sh",
          "-c",
          `git init -q -b main work && cd work && ${commit} && git push -q ${remote} HEAD:refs/heads/probe && git rev-parse HEAD`,
        ],
        { cwd: BED_PROJECT_ROOT },
      );
      expect(push.code).toBe(0);
      const there = await bed.run("dest", [
        "git",
        "--git-dir",
        repo,
        "rev-parse",
        "refs/heads/probe",
      ]);
      expect(there.stdout.trim()).toBe(push.stdout.trim());

      const back = await bed.run("dest", [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "mac@source",
        "true",
      ]);
      expect(back.code).not.toBe(0);
      expect(back.stderr).toMatch(/permission denied/i);
    });

    it("keeps the working tree read-only on source", async () => {
      const written = await bed.run("source", [
        "sh",
        "-c",
        `echo x > ${REPO_MOUNT}/.bed-write-probe`,
      ]);
      expect(written.code).not.toBe(0);
      await expect(access(join(REPO_ROOT, ".bed-write-probe"))).rejects.toThrow(
        /ENOENT/,
      );
    });

    it("runs the cli against the real hc", async () => {
      expect((await bed.run("source", ["node", CLI])).code).toBe(2);

      const version = await bed.run("source", ["claude", "--version"]);
      expect(version.code).toBe(0);
      expect(version.stdout).toMatch(VERSION);

      const started = await bed.run("source", [
        "hc",
        "run",
        "--bg",
        "--json",
        "--cwd",
        BED_PROJECT_ROOT,
        "--",
        "claude-klock",
      ]);
      expect(started.code).toBe(0);
      const { address } = JSON.parse(started.stdout) as { address: string };
      const foreground = await foregroundOf(bed, address);
      const sessionFile = `/Users/mac/.claude-klock/sessions/${foreground.pid}.json`;
      const registered = await bed.run("source", [
        "sh",
        "-c",
        `for _ in $(seq ${SESSION_WAIT_SECONDS * 2}); do test -s ${sessionFile} && exit 0; sleep 0.5; done; exit 1`,
      ]);
      expect(registered.code).toBe(0);
      const session = JSON.parse(
        (await bed.run("source", ["cat", sessionFile])).stdout,
      ) as Record<string, unknown>;
      expect(session).toMatchObject({
        pid: foreground.pid,
        cwd: BED_PROJECT_ROOT,
      });
      expect(session["sessionId"]).toMatch(UUID);
      expect(session["version"]).toMatch(VERSION);

      const plan = await bed.run("source", [
        "node",
        CLI,
        address,
        "dest",
        "--dry-run",
        "--json",
      ]);
      expect([0, 3]).toContain(plan.code);
      const reply = JSON.parse(plan.stdout) as Record<string, unknown>;
      expect("resume" in reply || "refused" in reply).toBe(true);
    });
  });
});
