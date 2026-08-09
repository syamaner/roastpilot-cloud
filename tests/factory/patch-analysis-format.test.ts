import { describe, expect, it } from "vitest";

import {
  MAX_PATCH_BYTES as leafMaxPatchBytes,
  parseAuthoritativePatchAnalysis as leafParseAnalysis,
  parseNameStatusZ as leafParseNameStatusZ,
  parseNumstatZ as leafParseNumstatZ,
} from "../../scripts/factory/patch-analysis-format.mts";
import {
  MAX_PATCH_BYTES as publisherMaxPatchBytes,
  parseAuthoritativePatchAnalysis as publisherParseAnalysis,
  parseNameStatusZ as publisherParseNameStatusZ,
  parseNumstatZ as publisherParseNumstatZ,
} from "../../scripts/factory/publish-implement-patch.mts";

describe("patch-analysis-format legacy publisher exports", () => {
  it("T-U1.1: preserves every moved runtime export by identity", () => {
    expect(publisherMaxPatchBytes).toBe(leafMaxPatchBytes);
    expect(publisherParseAnalysis).toBe(leafParseAnalysis);
    expect(publisherParseNameStatusZ).toBe(leafParseNameStatusZ);
    expect(publisherParseNumstatZ).toBe(leafParseNumstatZ);
  });
});
