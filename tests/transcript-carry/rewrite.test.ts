import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { rewriteHome } from "../../src/transcript-carry/rewrite.ts";

const FROM = "/Users/mac";
const TO = "/home/box";

describe("rewriteHome", () => {
  it.each([
    ["a path under the home", "cat /Users/mac/x", "cat /home/box/x", 0],
    ["the home at the end of a JSON string", '{"cwd":"/Users/mac"}', '{"cwd":"/home/box"}', 0],
    ["the home followed by a space", "cd /Users/mac && ls", "cd /home/box && ls", 0],
    ["the home inside an escaped JSON string", String.raw`{"a":"\"/Users/mac\" x"}`, String.raw`{"a":"\"/home/box\" x"}`, 0],
    ["a look-alike home", "/Users/macbook/x", "/Users/macbook/x", 0],
    ["a home that is the tail of another path", "/opt/Users/mac/x", "/opt/Users/mac/x", 0],
    ["a line that is not JSON", "not json at /Users/mac/y\nsecond", "not json at /home/box/y\nsecond", 0],
    ["CRLF and a missing final newline", "a /Users/mac/x\r\nb /Users/mac", "a /home/box/x\r\nb /home/box", 0],
    ["a place that already holds the destination home", "/home/box/y and /Users/mac/z", "/home/box/y and /home/box/z", 1],
    ["a destination look-alike", "/home/boxer/y", "/home/boxer/y", 0],
  ])("rewrites the home: %s", (_title, input, expected, existing) => {
    expect(rewriteHome(input, FROM, TO)).toEqual({ text: expected, existing });
  });

  it("rewrites the home: the same home on both sides changes nothing", () => {
    expect(rewriteHome("/Users/mac/x", FROM, FROM).text).toBe("/Users/mac/x");
  });

  it.each(["", "Users/mac", "mac"])("rewrites the home: refuses the source home %j", (from) => {
    expect(() => rewriteHome("x", from, TO)).toThrow(/home/);
  });

  it.each(["/", "/Users/mac/"])("rewrites the home: refuses the home %j as a root or with a trailing slash", (home) => {
    expect(() => rewriteHome("x", home, TO)).toThrow(/home/);
    expect(() => rewriteHome("x", FROM, home)).toThrow(/home/);
  });

  it("rewrites the home: refuses a destination home that is not absolute", () => {
    expect(() => rewriteHome("x", FROM, "box")).toThrow(/home/);
  });
});

const fragment = fc.oneof(
  fc.string({ unit: "grapheme" }),
  fc.constantFrom(FROM, `${FROM}/x`, `"${FROM}"`, `${FROM}book`, `/opt${FROM}`, `${FROM}\r\n`, `${FROM}/日本`),
);

describe("rewriteHome round trip", () => {
  it("round-trips any text that holds no destination home", () => {
    fc.assert(
      fc.property(fc.array(fragment).filter((parts) => !parts.join("").includes(TO)), (parts) => {
        const text = parts.join("");
        const there = rewriteHome(text, FROM, TO);
        expect(there.existing).toBe(0);
        expect(rewriteHome(there.text, TO, FROM).text).toBe(text);
      }),
      { numRuns: 500 },
    );
  });
});
