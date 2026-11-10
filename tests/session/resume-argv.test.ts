import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildResumeArgv } from "../../src/session/resume-argv.ts";

const ID = "09e11b42-f5c1-4c38-99f1-dd1d8b00355c";

function argvOf(source: string[]): string[] {
  const result = buildResumeArgv(source, ID);
  if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`);
  return [...result.argv];
}

describe("resume argv", () => {
  it.each([
    ["a bare prompt is dropped", ["claude-klock", "a prompt"], ["claude-klock", "--resume", ID]],
    [
      "a flag with a value keeps its order and value",
      ["claude-klock", "--model", "opus", "p"],
      ["claude-klock", "--model", "opus", "--resume", ID],
    ],
    [
      "the equals form is kept as given",
      ["claude-klock", "--model=opus"],
      ["claude-klock", "--model=opus", "--resume", ID],
    ],
    [
      "an old resume selector with a value is dropped",
      ["claude-klock", "-r", "old-id", "--effort", "high"],
      ["claude-klock", "--effort", "high", "--resume", ID],
    ],
    [
      "a resume selector followed by a flag takes no value",
      ["claude-klock", "-r", "--model", "opus"],
      ["claude-klock", "--model", "opus", "--resume", ID],
    ],
    [
      "the equals form of a selector is dropped",
      ["claude", "--resume=old", "--continue", "--fork-session", "--session-id=x"],
      ["claude", "--resume", ID],
    ],
    [
      "a session id selector takes its value",
      ["claude", "--session-id", "abc", "--verbose"],
      ["claude", "--verbose", "--resume", ID],
    ],
    [
      "nothing after the double dash is kept",
      ["claude-klock", "--", "--model", "opus"],
      ["claude-klock", "--resume", ID],
    ],
    [
      "flags without a value and the short name flag are kept",
      ["claude-pa", "--dangerously-skip-permissions", "-n", "work", "--chrome", "--brief"],
      ["claude-pa", "--dangerously-skip-permissions", "-n", "work", "--chrome", "--brief", "--resume", ID],
    ],
    [
      "a value that starts with a dash belongs to its flag",
      ["claude", "--fallback-model", "-odd", "--agent", "a"],
      ["claude", "--fallback-model", "-odd", "--agent", "a", "--resume", ID],
    ],
  ])("%s", (_title, source, expected) => {
    expect(argvOf(source)).toEqual(expected);
  });

  it("refuses a flag that is not allowed and names it", () => {
    expect(buildResumeArgv(["claude-klock", "--mcp-config", "x.json"], ID)).toEqual({
      ok: false,
      refusal: { reason: "flag_not_allowed", detail: "--mcp-config" },
    });
    expect(buildResumeArgv(["claude-klock", "--add-dir", "/p"], ID)).toEqual({
      ok: false,
      refusal: { reason: "flag_not_allowed", detail: "--add-dir" },
    });
  });

  it("refuses an allowed flag that takes no value when one is attached", () => {
    expect(buildResumeArgv(["claude", "--verbose=1"], ID)).toEqual({
      ok: false,
      refusal: { reason: "flag_not_allowed", detail: "--verbose" },
    });
  });

  it("refuses a flag that needs a value and has none", () => {
    expect(buildResumeArgv(["claude-klock", "--model"], ID)).toEqual({
      ok: false,
      refusal: { reason: "flag_missing_value", detail: "--model" },
    });
  });

  it("refuses a session id selector that has no value", () => {
    expect(buildResumeArgv(["claude", "--session-id"], ID)).toEqual({
      ok: false,
      refusal: { reason: "flag_missing_value", detail: "--session-id" },
    });
  });

  it("refuses a disallowed flag even when it follows the allowed ones", () => {
    const result = buildResumeArgv(["claude", "--model", "opus", "--bare"], ID);
    expect(result).toEqual({ ok: false, refusal: { reason: "flag_not_allowed", detail: "--bare" } });
  });

  describe("properties", () => {
    const valued = ["--model", "--permission-mode", "--effort", "--fallback-model", "--agent", "--name", "-n"];
    const bare = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--brief", "--chrome", "--no-chrome", "--verbose"];
    const positionalWord = fc.stringMatching(/^p:[A-Za-z0-9._/ ]{0,10}$/);
    const valueWord = fc.stringMatching(/^v:[A-Za-z0-9._/ -]{0,10}$/);
    const group = fc.oneof(
      positionalWord.map((word) => ({ positional: word, tokens: [word] })),
      fc.constantFrom(...bare).map((flag) => ({ tokens: [flag] })),
      fc.tuple(fc.constantFrom(...valued), valueWord).map(([flag, value]) => ({ tokens: [flag, value] })),
      fc.constantFrom(["-r"], ["-c"], ["--continue"], ["--fork-session"], ["--resume"]).map((tokens) => ({ tokens })),
      valueWord.map((value) => ({ tokens: ["--session-id", value] })),
    );
    const sources = fc.array(group, { maxLength: 8 }).map((groups) => ({
      argv: ["claude-klock", ...groups.flatMap((g) => g.tokens)],
      positionals: groups.flatMap((g) => ("positional" in g ? [g.positional] : [])),
    }));

    it("ends with exactly one resume pair", () => {
      fc.assert(
        fc.property(sources, ({ argv }) => {
          const out = argvOf(argv);
          expect(out.slice(-2)).toEqual(["--resume", ID]);
          expect(out.filter((t) => t === "--resume")).toHaveLength(1);
        }),
      );
    });

    it("never carries a positional token of the input", () => {
      fc.assert(
        fc.property(sources, ({ argv, positionals }) => {
          const out = argvOf(argv);
          for (const p of positionals) expect(out).not.toContain(p);
        }),
      );
    });

    it("is idempotent", () => {
      fc.assert(
        fc.property(sources, ({ argv }) => {
          const once = argvOf(argv);
          expect(argvOf(once)).toEqual(once);
        }),
      );
    });
  });
});
