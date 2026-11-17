import { expect, it } from "vitest";

import { verifyDeletionEvidence } from "../scripts/c4/deletion-evidence.mts";
import { verifyTransitionEvidence } from "../scripts/c4/transition-evidence.mts";
import { encode as encodeDeletion, fixture as deletionFixture } from "./c4-deletion-fixture";
import { addSubject, binding, canonicalFixture, encode, fixture, ids, record, ref, removeSubject, type Fixture } from "./c4-transition-fixture";

const complete = { verdict: "evidence_structurally_complete" };
const rejected = (reason: string) => ({ verdict: "evidence_rejected", reason });
const incomplete = (reason: string) => ({ verdict: "evidence_incomplete", reason });
const verify = (input: Fixture) => verifyTransitionEvidence(canonicalFixture(input), binding);
const edit = (mutate: (input: Fixture) => void) => {
  const input = fixture();
  mutate(input);
  return verify(input);
};

function dropObservation(input: Fixture, item: Fixture["observations"][number]): void {
  input.observations = input.observations.filter((observation) => observation !== item);
}

function subject(input: Fixture, id: string) {
  const match = input.subjects.find((item) => item.id === id);
  if (!match) throw new Error("Missing synthetic subject");
  return match;
}

it("T01 rejects the specified witness", () => {
  const text = " " + new TextDecoder().decode(canonicalFixture(fixture()));
  expect(verifyTransitionEvidence(new TextEncoder().encode(text), binding)).toEqual(rejected("not_canonical"));
});

it("T02 rejects the specified witness", () => {
  expect(verifyTransitionEvidence(canonicalFixture(fixture()), { ...binding, cloud: "d".repeat(40) })).toEqual(rejected("binding_mismatch"));
});

it("T03 rejects the specified witness", () => {
  expect(verifyTransitionEvidence(canonicalFixture(fixture()), { ...binding, plan: "d".repeat(40) })).toEqual(rejected("binding_mismatch"));
});

it("T04 rejects the specified witness", () => {
  expect(verifyTransitionEvidence(canonicalFixture(fixture()), { ...binding, scope: ref(901) })).toEqual(rejected("binding_mismatch"));
});

it("T05 rejects the specified witness", () => {
  expect(verifyTransitionEvidence(canonicalFixture(fixture()), { ...binding, fleet: ref(902) })).toEqual(rejected("binding_mismatch"));
});

it("T06 rejects the specified witness", () => {
  expect(edit((input) => {
    input.end = input.start;
    for (const item of input.observations) item.end = input.start;
  })).toEqual(rejected("identity"));
});

it("T07 rejects the specified witness", () => {
  expect(edit((input) => { input.subjects.push({ ...subject(input, ids.legacyUrl) }); })).toEqual(rejected("identity"));
});

it("T08 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "inventory_start").id = record(input, "inventory_authority").id; })).toEqual(rejected("identity"));
});

it("T09 rejects the specified witness", () => {
  expect(edit((input) => {
    input.observations.push({ ...record(input, "page_nonservable", ids.legacyUrl), id: ref(903), source: ref(904) });
  })).toEqual(rejected("identity"));
});

it("T10 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "inventory_start").members.push(ids.legacyUrl); })).toEqual(rejected("identity"));
});

it("T11 rejects the specified witness", () => {
  expect(edit((input) => {
    addSubject(input, { id: input.scope, kind: "target", classification: "unknown", release: null });
  })).toEqual(rejected("identity"));
});

it("T12 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "inventory_authority").fleet = ref(905); })).toEqual(rejected("observation_binding"));
});

it("T13 rejects the specified witness", () => {
  expect(edit((input) => {
    const authority = record(input, "inventory_authority");
    authority.source = authority.id;
  })).toEqual(rejected("observation_binding"));
});

it("T14 rejects the specified witness", () => {
  expect(edit((input) => {
    Object.assign(subject(input, ids.legacyProducer), { classification: "current_uncached", release: binding.cloud });
    dropObservation(input, record(input, "producer_drained", ids.legacyProducer));
  })).toEqual(rejected("subject_form"));
});

it("T15 rejects the specified witness", () => {
  expect(edit((input) => { subject(input, ids.currentAlias).release = "d".repeat(40); })).toEqual(rejected("subject_form"));
});

it("T16 rejects the specified witness", () => {
  expect(edit((input) => {
    addSubject(input, { id: ref(906), kind: "url", classification: "recovery", release: binding.cloud });
  })).toEqual(rejected("subject_form"));
});

it("T17 rejects the specified witness", () => {
  expect(edit((input) => { subject(input, ids.recovery).release = null; })).toEqual(rejected("subject_form"));
});

it("T18 rejects the specified witness", () => {
  expect(edit((input) => { subject(input, ids.legacyUrl).release = binding.cloud; })).toEqual(rejected("subject_form"));
});

it("T19 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "page_nonservable", ids.legacyUrl).subject = ids.legacyProducer; })).toEqual(rejected("coverage_mismatch"));
});

it("T20 rejects the specified witness", () => {
  expect(edit((input) => {
    const item = record(input, "inventory_completeness");
    item.members = item.members.filter((id) => id !== ids.secondLegacyUrl);
  })).toEqual(rejected("coverage_mismatch"));
});

it("T21 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "rollback_policy").members.push(ids.legacyUrl); })).toEqual(rejected("coverage_mismatch"));
});

it("T22 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "rollback_policy").members = []; })).toEqual(rejected("coverage_mismatch"));
});

it("T23 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "inventory_completeness").source = record(input, "inventory_start").source; })).toEqual(rejected("evidence_reuse"));
});

it("T24 rejects the specified witness", () => {
  expect(edit((input) => {
    record(input, "producer_drained", ids.legacyProducer).source = record(input, "page_nonservable", ids.legacyUrl).source;
  })).toEqual(rejected("evidence_reuse"));
});

it("T25 rejects the specified witness", () => {
  expect(edit((input) => {
    record(input, "recovery_demonstrated", ids.recovery).source = record(input, "recovery_procedure", ids.recovery).source;
  })).toEqual(rejected("evidence_reuse"));
});

it("T26 rejects the specified witness", () => {
  expect(edit((input) => {
    dropObservation(input, record(input, "preview_nonservable", ids.secondLegacyUrl));
  })).toEqual(incomplete("missing_evidence"));
});

it("T27 rejects the specified witness", () => {
  expect(edit((input) => { dropObservation(input, record(input, "producer_drained", ids.legacyProducer)); })).toEqual(incomplete("missing_evidence"));
});

it("T28 rejects the specified witness", () => {
  expect(edit((input) => {
    addSubject(input, { id: ref(907), kind: "target", classification: "unknown", release: null });
  })).toEqual(incomplete("missing_evidence"));
});

it("T29 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "producer_drained", ids.legacyProducer).outcome = "unsupported"; })).toEqual(incomplete("unverified_evidence"));
});

it("T30 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "page_nonservable", ids.legacyUrl).outcome = "unknown"; })).toEqual(incomplete("unverified_evidence"));
});

it("T31 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "scope_exclusion", ids.excluded).outcome = "failed"; })).toEqual(incomplete("unverified_evidence"));
});

it("T32 rejects the specified witness", () => {
  expect(edit((input) => { removeSubject(input, ids.currentAlias); })).toEqual(incomplete("missing_current_fleet"));
});

it("T33 rejects the specified witness", () => {
  expect(edit((input) => {
    removeSubject(input, ids.rollback);
    record(input, "rollback_policy").members = [];
  })).toEqual(incomplete("missing_current_fleet"));
});

it("T34 rejects the specified witness", () => {
  expect(edit((input) => { removeSubject(input, ids.recovery); })).toEqual(incomplete("recovery_unqualified"));
});

it("T35 rejects the specified witness", () => {
  expect(edit((input) => {
    dropObservation(input, record(input, "recovery_demonstrated", ids.recovery));
  })).toEqual(incomplete("missing_evidence"));
});

it("T36 rejects the specified witness", () => {
  expect(edit((input) => { record(input, "recovery_demonstrated", ids.recovery).outcome = "changed"; })).toEqual(incomplete("unverified_evidence"));
});

it("accepts a separately demonstrated recovery from the running release deterministically", () => {
  const first = canonicalFixture(fixture());
  const second = canonicalFixture(fixture());
  expect(first).toEqual(second);
  expect(verifyTransitionEvidence(first, binding)).toEqual(complete);
  expect(verifyTransitionEvidence(second, binding)).toEqual(complete);
});

it("rejects each incompatible evidence class", () => {
  expect(verifyTransitionEvidence(encodeDeletion(deletionFixture()), binding)).toEqual(rejected("schema"));
  expect(verifyDeletionEvidence(canonicalFixture(fixture()), binding.cloud, binding.plan)).toEqual(rejected("schema"));
});

it("rejects malformed UTF-8, a BOM, invalid JSON and invalid escapes as schema errors", () => {
  const text = new TextDecoder().decode(canonicalFixture(fixture()));
  const utf8 = new TextEncoder();
  for (const bytes of [
    new Uint8Array([0xc0, 0xaf]), utf8.encode("\uFEFF" + text), utf8.encode("{"),
    utf8.encode(text.replace("roastpilot", "\\qroastpilot")),
  ]) expect(verifyTransitionEvidence(bytes, binding)).toEqual(rejected("schema"));
});

it("rejects duplicate keys and valid but noncanonical JSON spellings", () => {
  const input = fixture();
  const text = new TextDecoder().decode(canonicalFixture(input));
  const utf8 = new TextEncoder();
  const { evidence, version, ...rest } = input;
  for (const bytes of [
    utf8.encode(text.replace('"version":1', '"version":1,"version":1')),
    utf8.encode(text.replace("roastpilot", "\\u0072oastpilot")),
    utf8.encode(text.trimEnd()),
    encode({ version, evidence, ...rest }),
    encode({ ...input, subjects: [...input.subjects].reverse() }),
    encode({ ...input, observations: [...input.observations].reverse() }),
  ]) expect(verifyTransitionEvidence(bytes, binding)).toEqual(rejected("not_canonical"));
});

it("rejects nested key and member reordering", () => {
  const input = fixture();
  const [first, ...remaining] = input.subjects;
  const { id, kind, classification, release } = first;
  expect(verifyTransitionEvidence(encode({
    ...input, subjects: [{ kind, id, classification, release }, ...remaining],
  }), binding)).toEqual(rejected("not_canonical"));
  const members = record(input, "inventory_end").members;
  members.reverse();
  expect(verifyTransitionEvidence(encode(input), binding)).toEqual(rejected("not_canonical"));
});

it("rejects unknown keys, incorrect types and values outside every closed enum", () => {
  const input = fixture();
  const subject = input.subjects[0];
  const observation = input.observations[0];
  for (const invalid of [
    { ...input, token: "synthetic-private" }, { ...input, version: "1" }, { ...input, evidence: 1 },
    { ...input, cloud_commit: 3 }, { ...input, plan_commit: "B".repeat(40) }, { ...input, scope: [] },
    { ...input, fleet: ref(42).slice(1) }, { ...input, start: null }, { ...input, end: ref(6) + "\n" },
    { ...input, subjects: {} }, { ...input, observations: null },
    ...[
      { extra: "synthetic-private" }, { id: 1 }, { kind: "deployment" }, { classification: "current" }, { release: false },
    ].map((fields) => ({ ...input, subjects: [{ ...subject, ...fields }] })),
    ...[
      { extra: "synthetic-private" }, { id: null }, { kind: "page" }, { subject: 2 }, { scope: 1 },
      { fleet: 3 }, { start: 4 }, { end: 5 }, { source: "" }, { outcome: "assumed" }, { members: null },
      { members: [42] },
    ].map((fields) => ({ ...input, observations: [{ ...observation, ...fields }] })),
  ]) expect(verifyTransitionEvidence(encode(invalid), binding)).toEqual(rejected("schema"));
});

it("rejects mismatched independent binding before observation uncertainty", () => {
  const input = fixture();
  record(input, "inventory_authority").outcome = "unknown";
  expect(verifyTransitionEvidence(canonicalFixture(input), { ...binding, fleet: ref(900) })).toEqual(rejected("binding_mismatch"));
});

it("checks memberships for uncertain claims and denies an unqualified rollback subject", () => {
  expect(edit((input) => {
    const policy = record(input, "rollback_policy");
    policy.members = [ids.recovery];
    policy.outcome = "unknown";
  })).toEqual(rejected("coverage_mismatch"));
});

it("rejects mismatches in the remaining observation bindings", () => {
  for (const key of ["scope", "start", "end"] as const) {
    expect(edit((input) => { record(input, "inventory_end")[key] = ref(900); })).toEqual(rejected("observation_binding"));
  }
});

it("checks unbound URL releases and unknown and excluded release forms", () => {
  expect(edit((input) => { subject(input, ids.currentUrl).release = "d".repeat(40); })).toEqual(rejected("subject_form"));
  expect(edit((input) => { subject(input, ids.excluded).release = binding.cloud; })).toEqual(rejected("subject_form"));
  expect(edit((input) => {
    addSubject(input, { id: ref(908), kind: "target", classification: "unknown", release: binding.cloud });
  })).toEqual(rejected("subject_form"));
});

it("permits otherwise valid source reuse outside the specified claim pairs", () => {
  expect(edit((input) => {
    record(input, "inventory_authority").source = record(input, "page_uncached", ids.currentAlias).source;
  })).toEqual(complete);
});

it("denies allowed kind and source references when attached to the wrong claim", () => {
  expect(edit((input) => {
    record(input, "inventory_authority").source = record(input, "inventory_end").source;
  })).toEqual(rejected("evidence_reuse"));
  expect(edit((input) => {
    record(input, "producer_drained", ids.legacyProducer).source = record(input, "preview_uncached", ids.recovery).source;
  })).toEqual(rejected("evidence_reuse"));
  expect(edit((input) => {
    const unknown = ref(909);
    addSubject(input, { id: unknown, kind: "target", classification: "unknown", release: null });
    const copy = { ...record(input, "scope_exclusion", ids.excluded), id: ref(910), subject: unknown, source: ref(911) };
    input.observations.push(copy);
  })).toEqual(rejected("coverage_mismatch"));
});

it("requires exactly one alternate even when both alternates have complete observations", () => {
  expect(edit((input) => {
    const alternate = ref(912);
    addSubject(input, { ...subject(input, ids.recovery), id: alternate });
    const records = input.observations.filter((item) => item.subject === ids.recovery);
    input.observations.push(...records.map((item, index) => ({
      ...item, id: ref(920 + index), subject: alternate, source: ref(930 + index),
    })));
  })).toEqual(incomplete("recovery_unqualified"));
});

it("retains a legacy target in inventory and excludes it from rollback policy", () => {
  const input = fixture();
  const legacyTarget = ref(941);
  addSubject(input, { id: legacyTarget, kind: "target", classification: "legacy", release: null });

  expect(verify(input)).toEqual(complete);
  record(input, "rollback_policy").members.push(legacyTarget);
  expect(verify(input)).toEqual(rejected("coverage_mismatch"));
});

it("rejects reuse of the producer drain source by each serving observation kind", () => {
  for (const [kind, endpoint] of [
    ["page_nonservable", ids.legacyUrl],
    ["preview_nonservable", ids.legacyUrl],
    ["page_uncached", ids.currentUrl],
    ["preview_uncached", ids.currentUrl],
  ] as const) {
    expect(edit((input) => {
      record(input, kind, endpoint).source = record(input, "producer_drained", ids.legacyProducer).source;
    }), kind).toEqual(rejected("evidence_reuse"));
  }
});

it("requires a scope-exclusion claim for an out-of-scope producer", () => {
  const input = fixture();
  const producer = ref(942);
  addSubject(input, { id: producer, kind: "producer", classification: "out_of_scope", release: null });
  expect(verify(input)).toEqual(incomplete("missing_evidence"));

  const claim = { ...record(input, "scope_exclusion", ids.excluded), id: ref(943), subject: producer, source: ref(944) };
  input.observations.push(claim);
  expect(verify(input)).toEqual(complete);

  claim.kind = "producer_drained";
  expect(verify(input)).toEqual(rejected("coverage_mismatch"));
});

it("keeps an unknown producer pending when the inventory discloses it", () => {
  expect(edit((input) => {
    addSubject(input, { id: ref(945), kind: "producer", classification: "unknown", release: null });
  })).toEqual(incomplete("missing_evidence"));
});
