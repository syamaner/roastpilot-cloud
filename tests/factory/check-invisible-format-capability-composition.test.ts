import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const capability = vi.hoisted(() => ({
  listTrackedPaths: vi.fn(),
}));

vi.mock("../../scripts/factory/node-process-capability.mts", () => capability);

import { scanRepository } from "../../scripts/factory/check-invisible-format-characters.mts";

let temporaryRoot: string | undefined;

afterEach(() => {
  vi.clearAllMocks();
  if (temporaryRoot !== undefined) {
    rmSync(temporaryRoot, { force: true, recursive: true });
    temporaryRoot = undefined;
  }
});

describe("scanRepository capability composition", () => {
  it("loads every entry from the adapter-returned canonical root", () => {
    temporaryRoot = mkdtempSync(
      join(tmpdir(), "invisible-format-capability-root-"),
    );
    const canonicalRoot = join(temporaryRoot, "canonical");
    const lexicalRoot = join(temporaryRoot, "retargetable-link");
    writeFileSync(
      join(temporaryRoot, "placeholder"),
      "keeps the parent present",
    );
    vi.mocked(capability.listTrackedPaths).mockReturnValue({
      repositoryRoot: canonicalRoot,
      rawTrackedPaths: Buffer.from("tracked.txt\0"),
    });
    mkdirSync(canonicalRoot);
    writeFileSync(join(canonicalRoot, "tracked.txt"), "clean\n");

    const result = scanRepository(lexicalRoot);

    expect(capability.listTrackedPaths).toHaveBeenCalledWith(lexicalRoot);
    expect(result).toEqual({
      findings: [],
      scannedEntries: 1,
      skippedNonFileEntries: 0,
      skippedAllowlistedEntries: 0,
    });
  });
});
