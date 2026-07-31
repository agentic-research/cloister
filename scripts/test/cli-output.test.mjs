import test from "node:test";
import assert from "node:assert/strict";

import { parseGlobalOptions } from "../../cli/lib/global-options.mjs";
import { createOutputContext } from "../../cli/lib/output.mjs";

const ANSI = /\x1b\[/;

function stream({ tty = false, depth = 8 } = {}) {
  let body = "";
  return {
    isTTY: tty,
    getColorDepth: () => depth,
    write(chunk) { body += String(chunk); return true; },
    body: () => body,
  };
}

test("global color options are removed anywhere before the pass-through separator", () => {
  assert.deepEqual(parseGlobalOptions(["--color", "never", "skills", "list"]), {
    argv: ["skills", "list"], colorMode: "never", explicitColor: true,
  });
  assert.deepEqual(parseGlobalOptions(["skills", "--color", "always", "list"]), {
    argv: ["skills", "list"], colorMode: "always", explicitColor: true,
  });
  assert.deepEqual(parseGlobalOptions(["skills", "list", "--no-color"]), {
    argv: ["skills", "list"], colorMode: "never", explicitColor: true,
  });
});

test("global parsing leaves harness arguments after -- byte-for-byte alone", () => {
  assert.deepEqual(
    parseGlobalOptions(["run", "--repo", "/tmp/repo", "--", "--color", "always"]),
    {
      argv: ["run", "--repo", "/tmp/repo", "--", "--color", "always"],
      colorMode: "auto",
      explicitColor: false,
    },
  );
});

test("invalid or missing --color values name the accepted set", () => {
  for (const argv of [["--color"], ["skills", "--color", "sometimes", "list"]]) {
    assert.throws(
      () => parseGlobalOptions(argv),
      /--color requires one of: auto, always, never/,
    );
  }
});

test("output color follows TTY, NO_COLOR, FORCE_COLOR, explicit flags, and JSON", () => {
  const cases = [
    { name: "TTY auto", tty: true, env: {}, colorMode: "auto", json: false, ansi: true },
    { name: "pipe auto", tty: false, env: {}, colorMode: "auto", json: false, ansi: false },
    { name: "NO_COLOR", tty: true, env: { NO_COLOR: "1" }, colorMode: "auto", json: false, ansi: false },
    { name: "FORCE_COLOR pipe", tty: false, env: { FORCE_COLOR: "1" }, colorMode: "auto", json: false, ansi: true },
    { name: "always beats NO_COLOR", tty: false, env: { NO_COLOR: "1" }, colorMode: "always", json: false, ansi: true },
    { name: "never beats FORCE_COLOR", tty: true, env: { FORCE_COLOR: "3" }, colorMode: "never", json: false, ansi: false },
    { name: "JSON is plain", tty: true, env: { FORCE_COLOR: "3" }, colorMode: "always", json: true, ansi: false },
  ];

  for (const c of cases) {
    const stdout = stream({ tty: c.tty, depth: 24 });
    const stderr = stream({ tty: c.tty, depth: 24 });
    const output = createOutputContext({ stdout, stderr, env: c.env, colorMode: c.colorMode, json: c.json });
    output.log(output.style.green("ready"));
    assert.equal(ANSI.test(stdout.body()), c.ansi, c.name);
    assert.equal(output.colorEnabled, c.ansi, c.name);
  }
});
