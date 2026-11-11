import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { runDeletionEvidenceCli } from "../scripts/c4/deletion-evidence-cli.mts";
import { cloudCommit, encode, fixture, planCommit } from "./c4-deletion-fixture";

const entry = "scripts/c4/deletion-evidence-cli.mts";
const args = (path: string) => ["--expected-cloud-commit", cloudCommit, "--expected-plan-commit", planCommit, path];
const usage = "usage: deletion-evidence-cli --expected-cloud-commit <40-hex> --expected-plan-commit <40-hex> <evidence-file>\n";

function runNode(path: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", entry, ...args(path)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { NODE_ENV: "test" },
    timeout: 5000,
  });
}

it("executes the documented Node entry point for complete, incomplete and rejected files", () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-synthetic-"));
  try {
    const path = join(directory, "synthetic.json");
    const partial = fixture();
    partial.records = [];
    for (const [bytes, status, stdout] of [
      [encode(fixture()), 0, '{"verdict":"evidence_structurally_complete"}\n'],
      [encode(partial), 1, '{"verdict":"evidence_incomplete","reason":"missing_scenario"}\n'],
      [encode({ private: "must-not-echo" }), 1, '{"verdict":"evidence_rejected","reason":"schema"}\n'],
    ] as const) {
      writeFileSync(path, bytes);
      const result = runNode(path);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(status);
      expect(result.stdout).toBe(stdout);
      expect(result.stderr).toBe("");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reads exactly the selected file and emits a closed unreadable result without private data", () => {
  const read = vi.fn(() => { throw new Error("private path and data"); });
  expect(runDeletionEvidenceCli(args("synthetic-input.json"), read)).toEqual({
    exit: 1,
    stdout: '{"verdict":"evidence_rejected","reason":"unreadable"}\n',
    stderr: "",
  });
  expect(read.mock.calls).toEqual([["synthetic-input.json"]]);
});

it("rejects invalid argv before reading and emits only the usage line", () => {
  const read = vi.fn(() => encode(fixture()));
  for (const invalid of [
    [],
    ["--expected-plan-commit", planCommit, "--expected-cloud-commit", cloudCommit, "private"],
    ["--expected-cloud-commit", cloudCommit.toUpperCase(), "--expected-plan-commit", planCommit, "private"],
    ["--expected-cloud-commit", cloudCommit, "--expected-plan-commit", "b".repeat(39), "private"],
    [...args("private"), "extra"],
    args(""),
  ]) {
    expect(runDeletionEvidenceCli(invalid, read)).toEqual({ exit: 2, stdout: "", stderr: usage });
  }
  expect(read).not.toHaveBeenCalled();
});

it("covers the direct dispatch and exit assignment in the instrumented module", async () => {
  vi.resetModules();
  const originalArgv = process.argv;
  const originalExit = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    process.argv = [process.execPath, join(process.cwd(), entry)];
    await import("../scripts/c4/deletion-evidence-cli.mts");
    expect(stdout).toHaveBeenCalledWith("");
    expect(stderr).toHaveBeenCalledWith(usage);
    expect(process.exitCode).toBe(2);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExit;
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
