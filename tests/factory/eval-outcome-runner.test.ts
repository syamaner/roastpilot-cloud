import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runMeasuredImplementOutcome, SpawnSyncGateExecutor } from "../../scripts/factory/eval/outcome-runner.mts";
import type { GateStep } from "../../scripts/factory/eval/outcome-runner-logic.mts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(), rm: vi.fn(), writeFile: vi.fn(),
}));

function spawned(
  overrides: Partial<ReturnType<typeof spawnSync>> = {},
): ReturnType<typeof spawnSync> {
  const stdout = Buffer.from("stdout");
  const stderr = Buffer.from("stderr");
  return {
    output: [null, stdout, stderr], pid: 123, signal: null, status: 0,
    stdout, stderr, ...overrides,
  } as ReturnType<typeof spawnSync>;
}

const STEP: GateStep = {
  executable: "npm",
  args: ["run", "typecheck"],
  cwd: "/tree",
  env: { PATH: "/safe/bin", HOME: "/safe/home", CI: "1", LC_ALL: "C" },
  timeoutMs: 600_000,
};

describe("outcome runner process shell", () => {
  it("T113 enforces the hardened spawn contract and maps every process-level arm", async () => {
    const executor = new SpawnSyncGateExecutor();
    vi.mocked(spawnSync).mockReturnValueOnce(spawned());
    await expect(executor.run(STEP)).resolves.toEqual({
      spawned: true, exitCode: 0, stdout: "stdout", stderr: "stderr",
    });
    expect(spawnSync).toHaveBeenLastCalledWith("npm", ["run", "typecheck"], {
      cwd: "/tree",
      encoding: "buffer",
      env: { PATH: "/safe/bin", HOME: "/safe/home", CI: "1", LC_ALL: "C" },
      killSignal: "SIGKILL",
      maxBuffer: 16_777_216,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
      windowsHide: true,
    });

    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ status: 9 }));
    await expect(executor.run(STEP)).resolves.toMatchObject({ spawned: true, exitCode: 9 });
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ signal: "SIGKILL", status: null }));
    await expect(executor.run(STEP)).resolves.toMatchObject({ spawned: false, exitCode: null });
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ error: new Error("timeout"), status: null }));
    await expect(executor.run(STEP)).resolves.toMatchObject({ spawned: false, exitCode: null });
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ stdout: Buffer.from([0xff]) as unknown as ReturnType<typeof spawnSync>["stdout"] }));
    await expect(executor.run(STEP)).resolves.toEqual({
      spawned: false, exitCode: null, stdout: "", stderr: "process execution failed",
    });
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ stdout: "not-bytes" as unknown as ReturnType<typeof spawnSync>["stdout"] }));
    await expect(executor.run(STEP)).resolves.toMatchObject({ spawned: false });

    const request = {
      caseId: "issue-014-shell",
      inputs: {
        issueNumber: 14,
        snapshot: {
          issueNumber: 14, title: "Fixture", body: "Fixture", labels: [], state: "OPEN" as const,
          snapshotAt: "2026-08-16T08:57:42Z",
          sourceUrl: "https://github.com/syamaner/roastpilot-cloud/issues/14",
        },
        decisionContextText: null,
        baseSha: "0123456789abcdef0123456789abcdef01234567",
      },
      patchText: "patch",
      sourceRepoRoot: "/source",
    };
    vi.mocked(mkdtemp).mockResolvedValue("/tmp/mock-outcome");
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rm).mockResolvedValue();
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ status: 1 }));
    await expect(runMeasuredImplementOutcome(request)).resolves.toMatchObject({
      setup: { status: "non-pass", reason: "missing historical base" },
    });
    expect(mkdtemp).toHaveBeenCalledWith(expect.stringContaining("roastpilot-outcome-"));
    expect(rm).toHaveBeenCalledWith("/tmp/mock-outcome", { force: true, recursive: true });

    await expect(runMeasuredImplementOutcome({
      get caseId() { throw new Error("hostile request"); },
    } as unknown as typeof request)).resolves.toMatchObject({
      caseId: "unknown", setup: { status: "non-pass" },
    });

    vi.mocked(mkdtemp).mockResolvedValueOnce("/tmp/mock-cleanup-failure");
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup failed"));
    vi.mocked(spawnSync).mockReturnValueOnce(spawned({ status: 1 }));
    await expect(runMeasuredImplementOutcome(request)).resolves.toMatchObject({
      setup: { status: "non-pass", reason: "environment setup failed" },
    });

    const source = readFileSync(new URL("../../scripts/factory/eval/outcome-runner.mts", import.meta.url), "utf8");
    expect(source).toContain("shell: false");
    expect(source).not.toMatch(/env:\s*process\.env/);
  });
});
