import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../docs/runbooks/${file}`, import.meta.url), "utf8");
const transition = read("c9-transition-qualification.md");
const rotation = read("key-rotation.md");
const deploy = read("prod-deploy-runbook.md");
const cachedNull = "An ISR-era deployment may return a cached null for a previously requested valid slug. A request reaching the uncached reader makes a fresh server read.";

it("keeps fleet and per-call qualification independent and requires external operator evidence", () => {
  const lines = transition.split("\n");
  for (const required of [
    "Structural completeness checks the supplied offline relationships. The operator must verify the underlying evidence and current binding before relying on it.",
    "Per-call cache acknowledgement and fleet transition evidence are both required and have independent meanings.",
    "Agreement between listings and absence of a listed URL do not prove producer drain, inventory completeness or non-servability.",
    "Keep qualification pending whenever a required observation or the current fleet binding cannot be independently verified.",
    "G1–G6 remain operator-only and unperformed, and cloud sync stays off.",
  ]) expect(lines).toContain(required);
  expect(transition).toContain("Do not take expected values from the evidence file.");
  expect(transition).toContain("separate observation of a successful demonstration");
  expect(transition).toContain("Keep credentials, request headers, raw roast records and identifying raw data out of verifier input and public evidence.");
  expect(transition).toContain("Provider-stored bytes, already in-flight uncached responses, edge limits and third-party copies can remain.");
  expect(transition).toContain("Physical erasure and timing need separate evidence.");
});

it("keeps the retired action descriptive and preserves fail-closed rotation controls", () => {
  expect(rotation).toContain("The `dev-snowflake-agent-verify.yml` dispatch is a live operator action using both the agent and seed credentials.");
  expect(rotation).toContain("The gated workflow runs the live agent and seed principal guards first. Its first write verifier then refuses, and the shell stops before the presigned URL and telemetry commands.");
  expect(rotation).toContain("A principal guard outcome alone supplies no write acceptance.");
  expect(rotation).toContain("The retired workflow is not the rotation verification procedure.");
  expect(rotation).toContain("If a qualified procedure or suitable evidence is unavailable, keep verification pending.");
  expect(rotation).toContain("and the independently verified consumer binding under that procedure.");
  expect(rotation).toContain("If confirmation or the probe fails, do not unset the old key.");
  expect(rotation).toContain("Compromise or emergency exception, revoke first:");
  expect(rotation).toContain([
    "`upsert_roast_verify_live.py` is retired by C9-C2 and refuses; no replacement",
    "live write instrument exists until C9-C4. Do not provision or invoke a seed",
    "credential to bypass this refusal. Key rotation remains operator-only and",
    "requires the separately qualified C9-C4 instrument before write acceptance.",
  ].join("\n"));
  expect(rotation).not.toMatch(/re-dispatch|a fresh gated\s+workflow dispatch|dispatch the gated DEV CI probe|The sanctioned `ROASTPILOT_AGENT_CI` verification path/);
});

it("limits cached-null guidance to ISR-era deployments and points at the fleet evidence procedure", () => {
  expect(rotation.split(cachedNull)).toHaveLength(3);
  expect(deploy.split(cachedNull)).toHaveLength(2);
  for (const book of [rotation, deploy]) {
    expect(book).not.toMatch(/cached null for five\s+minutes|A previously requested valid slug can return a cached null/);
  }
  expect(rotation).toContain("The resulting 404 must perform a fresh Snowflake query.");
  expect(rotation).toContain("fresh-slug 404 performs that deployment's Snowflake query");
  expect(deploy).toContain("Using a fresh, route-valid slug ensures that the 404 performs the");
  expect(deploy).toContain([
    "An ISR-era deployment is not an eligible rollback target.",
    "The qualification procedure belongs to C9-C4 and operator gates G5/G6. This runbook selects no retirement mechanism.",
    "Record and verify the fleet transition evidence using [the C9-C4 qualification procedure](c9-transition-qualification.md) before relying on it in G5 or G6.",
  ].join("\n"));
});

it("pins the separately qualified consumer verification and the old-slot requirement", () => {
  expect(rotation).toContain("Rotate this principal by updating the Environment secret as a GitHub operator.");
  expect(rotation).toContain("Verification for this consumer requires a separately qualified operator procedure. Keep the old slot until that verification succeeds.");
  expect(rotation).toContain("Do not copy the secret into a\nrepository file.");
  expect(rotation).toContain("`dev-snowflake-agent` GitHub Environment and follow the separately qualified verification procedure described under Verify.");
  expect(rotation).toContain("Before relying on an authentication probe, confirm that the exact consumer\n   target was updated");
  expect(rotation).toContain("the correct GitHub Environment secret and the independently verified consumer binding under that procedure.");
  expect(rotation).toContain("| Update the `dev-snowflake-agent` Environment secret and verify under a separately qualified procedure | GitHub operator and authorised operator |");
});

it("keeps the transition runbook free of the listed claims of completed live qualification", () => {
  const contradictory = /\b(?:G[56]\s+(?:(?:has\s+been|is)\s+qualified|(?:has\s+been|is)\s+complete(?:d)?)|cloud\s+sync\s+(?:is|stays)\s+(?:on|active|enabled))\b/i;
  expect(transition).not.toMatch(contradictory);
  for (const line of [
    "G5 has been qualified.", "G6 has been qualified.", "G5 is qualified.", "G6 is complete.",
    "Cloud sync is on.", "Cloud sync is active.", "Cloud sync is enabled.",
  ]) expect(transition + "\n" + line + "\n").toMatch(contradictory);
});

it("confines every cached-null phrase to the exact qualified statements", () => {
  const unqualified = /\bcached\s+null\b/i;
  for (const [book, qualifiedCount] of [[rotation, 2], [deploy, 1]] as const) {
    const parts = book.split(cachedNull);
    expect(parts).toHaveLength(qualifiedCount + 1);
    expect(parts.join("")).not.toMatch(unqualified);
    expect(parts.join("") + "\nThe request must query Snowflake rather than return a cached null.\n").toMatch(unqualified);
  }
});
