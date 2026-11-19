import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { runTransitionEvidenceCli } from "../scripts/c4/transition-evidence-cli.mts";
import { binding, canonicalFixture, encode, fixture, record } from "./c4-transition-fixture";

const entry = "scripts/c4/transition-evidence-cli.mts";
const usage = "usage: transition-evidence-cli --expected-cloud-commit <40-hex> --expected-plan-commit <40-hex> --expected-scope <64-hex> --expected-fleet <64-hex> <evidence-file>\n";
const complete = '{"verdict":"evidence_structurally_complete"}\n';
const unreadable = '{"verdict":"evidence_rejected","reason":"unreadable"}\n';
const args = (file: string) => [
  "--expected-cloud-commit", binding.cloud, "--expected-plan-commit", binding.plan,
  "--expected-scope", binding.scope, "--expected-fleet", binding.fleet, file,
];

function runNode(script: string, flags: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", script, ...flags], {
    encoding: "utf8",
    env: { NODE_ENV: "test" },
    cwd: process.cwd(),
    timeout: 5000,
  });
}

it("checks direct and symlink execution with exact fixed streams and exits", () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-transition-cli-"));
  try {
    const alias = join(directory, "entry.mts");
    const file = join(directory, "synthetic.json");
    symlinkSync(join(process.cwd(), entry), alias);
    writeFileSync(file, canonicalFixture(fixture()));
    for (const [script, parameters, status, stdout, stderr] of [
      [entry, args(file), 0, complete, ""],
      [alias, args(file), 0, complete, ""],
      [entry, args(join(directory, "synthetic-unreadable.json")), 1, unreadable, ""],
      [alias, [], 2, "", usage],
    ] as const) {
      const result = runNode(script, parameters);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status, stdout, stderr });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reads a real selected file with the exported entry and default reader", () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-transition-read-"));
  try {
    const file = join(directory, "synthetic.json");
    writeFileSync(file, canonicalFixture(fixture()));
    expect(runTransitionEvidenceCli(args(file))).toEqual({ exit: 0, stdout: complete, stderr: "" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("returns fixed reason lines for incomplete and rejected evidence", () => {
  const input = fixture();
  record(input, "inventory_authority").outcome = "unknown";
  const read = vi.fn(() => canonicalFixture(input));
  expect(runTransitionEvidenceCli(args("synthetic.json"), read)).toEqual({
    exit: 1, stdout: '{"verdict":"evidence_incomplete","reason":"unverified_evidence"}\n', stderr: "",
  });
  expect(read.mock.calls).toEqual([["synthetic.json"]]);
  expect(runTransitionEvidenceCli(args("synthetic.json"), () => encode({ input: "synthetic-private" }))).toEqual({
    exit: 1, stdout: '{"verdict":"evidence_rejected","reason":"schema"}\n', stderr: "",
  });
});

it("rejects invalid argv before any read or echo", () => {
  const read = vi.fn(() => canonicalFixture(fixture()));
  for (const invalid of [
    [], args(""), [...args("synthetic-private"), "extra"],
    ...[
      [0, "--unexpected"], [1, binding.cloud.toUpperCase()], [2, "--unexpected"], [3, "b".repeat(39)],
      [4, "--unexpected"], [5, binding.scope.slice(1)], [6, "--unexpected"], [7, "A".repeat(64)],
    ].map(([index, value]) => args("synthetic-private").map((argument, position) => position === index ? String(value) : argument)),
  ]) expect(runTransitionEvidenceCli(invalid, read)).toEqual({ exit: 2, stdout: "", stderr: usage });
  expect(read).not.toHaveBeenCalled();
});

it("turns reader failure into a fixed unreadable result without repeating the read", () => {
  const read = vi.fn(() => { throw new Error("synthetic-private"); });
  expect(runTransitionEvidenceCli(args("synthetic.json"), read)).toEqual({ exit: 1, stdout: unreadable, stderr: "" });
  expect(read.mock.calls).toEqual([["synthetic.json"]]);
});

it("imports silently with an absent or unresolvable process entry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-transition-import-"));
  const originalArgv = process.argv;
  const originalExit = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    for (const argv of [[process.execPath], [process.execPath, join(directory, "absent.mts")]]) {
      vi.resetModules();
      process.argv = argv;
      await import("../scripts/c4/transition-evidence-cli.mts");
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(originalExit);
    }
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExit;
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("dispatches through the instrumented direct entry and writes the exact verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-transition-dispatch-"));
  const originalArgv = process.argv;
  const originalExit = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const file = join(directory, "synthetic.json");
    writeFileSync(file, canonicalFixture(fixture()));
    vi.resetModules();
    process.argv = [process.execPath, join(process.cwd(), entry), ...args(file)];
    await import("../scripts/c4/transition-evidence-cli.mts");
    expect(stdout.mock.calls).toEqual([[complete]]);
    expect(stderr.mock.calls).toEqual([[""]]);
    expect(process.exitCode).toBe(0);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExit;
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
