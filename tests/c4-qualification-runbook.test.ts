import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const runbook = readFileSync(new URL("../docs/runbooks/c9-qualification.md", import.meta.url), "utf8");

it("states the three standalone recording and authority limits", () => {
  const lines = runbook.split("\n");
  expect(lines).toContain("The verifier reports structural completeness of operator-recorded evidence only.");
  expect(lines).toContain("Evidence references are protected and do not anonymise the underlying values.");
  expect(lines).toContain("G1–G6 remain operator-only and unperformed, and the cloud-sync feature stays off.");
});

it("documents the exact invocation, projections, reference frames and outcome boundary", () => {
  for (const text of [
    "node --experimental-strip-types scripts/c4/deletion-evidence-cli.mts --expected-cloud-commit <cloud-commit> --expected-plan-commit <plan-commit> <evidence-file>",
    "evidence, version, cloud_commit, plan_commit, target_class, records",
    "scenario, identity_ref, slug_ref, attempts",
    "kind, identity_ref, deletion, cloud_roast_ref, deletion_write_seq, stage_removal, cache_invalidation, client",
    "kind, identity_ref, failure_class, commit_observation, client",
    "kind, identity_ref, request_nonce_ref, outcome, status, api_version, response_slug_ref, response_nonce_ref, content_type, no_store, reason, evidence, client",
    "view, current_render, invalidation_calls, legacy_cache",
    "e3, e7, e6",
    "roastpilot/c9-c4/identity/v1",
    "roastpilot/c9-c4/slug/v1",
    "roastpilot/c9-c4/roast/v1",
    "roastpilot/c9-c4/nonce/v1",
    "one LF between segments and no final LF",
    "backup manifest's protected evidence controls",
    "first_attempt_complete",
    "recovered_stage_failure",
    "recovered_lost_server_ack",
    "recovered_cache_failure",
    "scenario_unsatisfied",
    "missing_scenario",
    "qualification stays pending",
    "D223 allows private stage bytes to persist indefinitely.",
    "D229 allows provider bytes to remain and a previously in-flight uncached response to finish.",
    "Edge and third-party copies remain residuals.",
    "A deployment, rollback or configuration change requires fresh operator evidence.",
  ]) {
    expect(runbook).toContain(text);
  }
});

it("pins the retry interval, evidence protection and structural verdict boundary", () => {
  for (const text of [
    "strictly after the first valid same-identity server result and strictly before the first valid cache completion",
    "Observations outside that interval still undergo identity, shape, nonce and client-state checks.",
    "Use a fresh nonce each time and finish with exact cache completion.",
    "Interpret exit and verdict together:",
    "Exit 0, `evidence_structurally_complete`",
    "Exit 1, `evidence_incomplete`",
    "Exit 1, `evidence_rejected`",
    "Exit 2: invalid invocation, with empty stdout and a fixed usage line on stderr.",
    "Keep the file in the approved encrypted store with access restricted to authorised operators.",
    "Do not publish or log references, raw identifiers, request or response bytes, credentials or paths.",
    "The records represent separate deletion operations under the same coordinator.",
    "The permanent minimal tombstone retains deletion identity and sequence.",
    "Physical erasure and actual provider retention are outside this proof.",
  ]) {
    expect(runbook).toContain(text);
  }
});
