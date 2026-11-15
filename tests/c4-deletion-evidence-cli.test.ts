import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { runDeletionEvidenceCli } from "../scripts/c4/deletion-evidence-cli.mts";
import { cloudCommit, encode, fixture, planCommit } from "./c4-deletion-fixture";

const entry = "scripts/c4/deletion-evidence-cli.mts";
const args = (path: string) => ["--expected-cloud-commit", cloudCommit, "--expected-plan-commit", planCommit, path];
const usage = "usage: deletion-evidence-cli --expected-cloud-commit <40-hex> --expected-plan-commit <40-hex> <evidence-file>\n";

function runNode(script: string, flags: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", script, ...flags], {
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
      const result = runNode(entry, args(path));
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

it("executes the same entry contract through an absolute symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-synthetic-alias-"));
  try {
    const alias = join(directory, "entry.mts");
    const path = join(directory, "synthetic.json");
    symlinkSync(join(process.cwd(), entry), alias);
    writeFileSync(path, encode(fixture()));

    for (const [flags, status, stdout, stderr] of [
      [[], 2, "", usage],
      [args(path), 0, '{"verdict":"evidence_structurally_complete"}\n', ""],
    ] as const) {
      const result = runNode(alias, flags);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(status);
      expect(result.stdout).toBe(stdout);
      expect(result.stderr).toBe(stderr);
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

it("imports silently when the process entry is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-import-only-"));
  vi.resetModules();
  const originalArgv = process.argv;
  const originalExit = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    process.argv = [process.execPath, join(directory, "absent.mts")];
    await import("../scripts/c4/deletion-evidence-cli.mts");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExit);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExit;
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("T34 resolves both entry paths with preserve-symlinks-main", () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-preserved-entry-"));
  try {
    const cli = join(directory, "deletion-evidence-cli.mts");
    const alias = join(directory, "alias.mts");
    const missingEvidence = join(directory, "absent.json");
    copyFileSync(join(process.cwd(), entry), cli);
    copyFileSync(join(process.cwd(), "scripts/c4/deletion-evidence.mts"), join(directory, "deletion-evidence.mts"));
    symlinkSync(join(process.cwd(), "node_modules"), join(directory, "node_modules"), "dir");
    symlinkSync(cli, alias);

    const invocation = [
      "--experimental-strip-types", "--preserve-symlinks-main", alias, ...args(missingEvidence),
    ];
    const result = spawnSync(process.execPath, invocation, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { NODE_ENV: "test" },
      timeout: 5000,
    });
    console.info("T34 subprocess " + JSON.stringify({
      argv: [process.execPath, ...invocation],
      cwd: process.cwd(),
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }));
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: '{"verdict":"evidence_rejected","reason":"unreadable"}\n',
      stderr: "",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reads an accepted synthetic file with the default reader", () => {
  const directory = mkdtempSync(join(tmpdir(), "c4-default-reader-"));
  try {
    const path = join(directory, "synthetic.json");
    writeFileSync(path, encode(fixture()));

    expect(runDeletionEvidenceCli(args(path))).toEqual({
      exit: 0,
      stdout: '{"verdict":"evidence_structurally_complete"}\n',
      stderr: "",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("imports silently when argv has no process entry", async () => {
  vi.resetModules();
  const originalArgv = process.argv;
  const originalExit = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    process.argv = [process.execPath];
    await import("../scripts/c4/deletion-evidence-cli.mts");

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExit);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExit;
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
