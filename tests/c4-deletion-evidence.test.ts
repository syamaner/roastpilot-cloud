import { expect, it } from "vitest";

import { verifyDeletionEvidence } from "../scripts/c4/deletion-evidence.mts";
import { cache, cached, cloudCommit, encode, failure, fixture, planCommit, ref, response, server } from "./c4-deletion-fixture";

type Fixture = ReturnType<typeof fixture>;
const complete = { verdict: "evidence_structurally_complete" };
const reject = (reason: string) => ({ verdict: "evidence_rejected", reason });
const unfinished = { verdict: "evidence_incomplete", reason: "scenario_unsatisfied" };
const missing = { verdict: "evidence_incomplete", reason: "missing_scenario" };
const verify = (value: unknown) => verifyDeletionEvidence(encode(value), cloudCommit, planCommit);
const edit = (mutate: (input: Fixture) => void) => {
  const input = fixture();
  mutate(input);
  return verify(input);
};

it("T01 canonical order", () => {
  const { version, evidence, ...rest } = fixture();
  expect(verify({ version, evidence, ...rest })).toEqual(reject("not_canonical"));
});

it("T02 cloud release binding", () => {
  expect(verifyDeletionEvidence(encode(fixture()), "c".repeat(40), planCommit)).toEqual(reject("binding_mismatch"));
});

it("T03 plan release binding", () => {
  expect(verifyDeletionEvidence(encode(fixture()), cloudCommit, "c".repeat(40))).toEqual(reject("binding_mismatch"));
});

it("T04 duplicate identity", () => {
  expect(edit(({ records: [first, second] }) => {
    second.identity_ref = first.identity_ref;
    for (const attempt of second.attempts) attempt.identity_ref = first.identity_ref;
  })).toEqual(reject("contradiction"));
});

it("T05 duplicate scenario", () => {
  expect(edit(({ records }) => {
    records.push({
      scenario: "first_attempt_complete", identity_ref: ref(50), slug_ref: ref(51),
      attempts: [
        server(ref(50), "deleted", ref(52), 7, "removed"),
        cache(ref(50), ref(51), 53, "complete"),
      ],
    });
  })).toEqual(reject("contradiction"));
});

it("T06 duplicate slug", () => {
  expect(edit(({ records: [first, second] }) => {
    second.slug_ref = first.slug_ref;
    cached(second.attempts[2]).response_slug_ref = first.slug_ref;
  })).toEqual(reject("contradiction"));
});

it("T07 attempt identity", () => {
  expect(edit(({ records }) => { records[1].attempts[1].identity_ref = ref(99); })).toEqual(reject("identity_mismatch"));
});

it("T08 legacy sequence", () => {
  expect(edit(({ records }) => { response(records[0].attempts[0]).deletion_write_seq = null; })).toEqual(reject("unsupported_legacy_sequence"));
});

it("T09 replay sequence", () => {
  expect(edit(({ records }) => { response(records[1].attempts[1]).deletion_write_seq = 11; })).toEqual(reject("contradiction"));
});

it("T10 replay roast", () => {
  expect(edit(({ records }) => { response(records[1].attempts[1]).cloud_roast_ref = ref(99); })).toEqual(reject("contradiction"));
});

it("T11 replay result", () => {
  expect(edit(({ records }) => { response(records[1].attempts[1]).deletion = "tombstoned_without_row"; })).toEqual(reject("contradiction"));
});

it("T12 cache nonce reuse", () => {
  expect(edit(({ records }) => {
    cached(records[3].attempts[2]).request_nonce_ref = cached(records[0].attempts[1]).request_nonce_ref;
  })).toEqual(reject("nonce_reuse"));
});

it("T13 cache nonce echo", () => {
  expect(edit(({ records }) => { cached(records[0].attempts[1]).response_nonce_ref = ref(99); })).toEqual(reject("contradiction"));
});

it("T14 cache slug echo", () => {
  expect(edit(({ records }) => { cached(records[0].attempts[1]).response_slug_ref = ref(99); })).toEqual(reject("contradiction"));
});

it("T15 cache no store", () => {
  expect(edit(({ records }) => { cached(records[0].attempts[1]).no_store = false; })).toEqual(reject("contradiction"));
});

it("T16 cache ordering", () => {
  expect(edit(({ records }) => {
    const record = records[3];
    const early = cache(record.identity_ref, record.slug_ref, 99, "complete");
    early.client = { e3: false, e7: false, e6: "pending" };
    record.attempts.unshift(early);
  })).toEqual(reject("contradiction"));
});

it("T17 stage still failed", () => {
  expect(edit(({ records }) => { response(records[1].attempts[1]).stage_removal = "failed"; })).toEqual(unfinished);
});

it("T18 stage failure exercised", () => {
  expect(edit(({ records }) => { response(records[1].attempts[0]).stage_removal = "removed"; })).toEqual(unfinished);
});

it("T19 lost commit replay", () => {
  expect(edit(({ records }) => { response(records[2].attempts[1]).deletion = "deleted"; })).toEqual(reject("contradiction"));
});

it("T20 missing pending", () => {
  expect(edit(({ records }) => { records[3].attempts.splice(1, 1); })).toEqual(unfinished);
});

it("T21 missing refusal", () => {
  expect(edit(({ records }) => { records[3].attempts.splice(2, 1); })).toEqual(unfinished);
});

it("T22 missing transport loss", () => {
  expect(edit(({ records }) => { records[3].attempts.splice(3, 1); })).toEqual(unfinished);
});

it("T23 missing malformed success", () => {
  expect(edit(({ records }) => { records[3].attempts.splice(4, 1); })).toEqual(unfinished);
});

it("T24 client monotonicity", () => {
  expect(edit(({ records }) => { records[1].attempts[2].client = { e3: false, e7: true, e6: "pending" }; })).toEqual(reject("client_state"));
});

it("T25 client display", () => {
  expect(edit(({ records }) => { records[0].attempts[1].client.e6 = "pending"; })).toEqual(reject("client_state"));
});

it("accepts the four independent synthetic recordings", () => {
  expect(verify(fixture())).toEqual(complete);
});

it("accepts premature pending or refused attempts with no acknowledgement credit", () => {
  for (const outcome of ["pending", "refused"] as const) {
    expect(edit(({ records }) => {
      const record = records[3];
      const early = cache(record.identity_ref, record.slug_ref, 99, outcome);
      early.client = { e3: false, e7: false, e6: "pending" };
      record.attempts.unshift(early);
    })).toEqual(complete);
  }
});

it("accepts alternate refusal status, all pending reasons and malformed server acknowledgement recovery", () => {
  for (const reason of ["view_present", "view_invalid", "view_unavailable", "invalidation_failed"]) {
    expect(edit(({ records }) => {
      failure(records[2].attempts[0]).failure_class = "malformed_response";
      cached(records[3].attempts[1]).reason = reason;
      cached(records[3].attempts[2]).status = 415;
    })).toEqual(complete);
  }
});

it("treats unknown commit followed by fresh delete as consistent but unfinished", () => {
  expect(edit(({ records }) => {
    failure(records[2].attempts[0]).commit_observation = "unknown";
    response(records[2].attempts[1]).deletion = "deleted";
  })).toEqual(unfinished);
});

it("checks a reported known commit followed by fresh deletion outside the lost-ack scenario", () => {
  expect(edit(({ records }) => {
    const failed = failure(records[2].attempts[0]);
    records[0].attempts.unshift({ ...failed, identity_ref: records[0].identity_ref });
  })).toEqual(reject("contradiction"));
});

it("distinguishes no server observation, empty records and missing suite coverage", () => {
  expect(edit(({ records }) => {
    const { identity_ref, slug_ref } = records[0];
    const early = cache(identity_ref, slug_ref, 99, "pending");
    early.client = { e3: false, e7: false, e6: "pending" };
    records[0].attempts = [early];
  })).toEqual(unfinished);
  expect(edit(({ records }) => { records[0].attempts = []; })).toEqual(unfinished);
  expect(edit(({ records }) => { records.pop(); })).toEqual(missing);
  expect(edit(({ records }) => { records.length = 0; })).toEqual(missing);
  expect(edit(({ records }) => {
    for (const attempt of records[1].attempts.slice(0, 2)) response(attempt).cloud_roast_ref = ref(22);
    response(records[1].attempts[0]).deletion = "deleted";
  })).toEqual(missing);
});

it("checks contradictions even when another observation is missing or the record has no response", () => {
  for (const issue of ["echo", "state", "reuse"] as const) {
    expect(edit(({ records }) => {
      records[1].attempts = [];
      const record = records[3];
      const pending = cache(record.identity_ref, record.slug_ref, issue === "reuse" ? 31 : 99, "pending");
      pending.client = { e3: issue === "state", e7: false, e6: "pending" };
      if (issue === "echo") pending.response_nonce_ref = ref(98);
      record.attempts = [pending];
    })).toEqual(reject({ echo: "contradiction", state: "client_state", reuse: "nonce_reuse" }[issue]));
  }
});

it("refuses first-response and failed-server contradictions", () => {
  for (const deletion of ["deleted", "tombstoned_without_row", "already_tombstoned"] as const) {
    expect(edit(({ records }) => {
      const first = response(records[0].attempts[0]);
      first.deletion = deletion;
      if (deletion === "deleted") first.cloud_roast_ref = null;
    })).toEqual(reject("contradiction"));
  }
  expect(edit(({ records }) => { failure(records[2].attempts[0]).failure_class = "sql_error"; })).toEqual(reject("contradiction"));
});

it("rejects fabricated E3 or E7 transitions and a later E7 reversal", () => {
  expect(edit(({ records }) => { records[2].attempts[0].client.e3 = true; })).toEqual(reject("client_state"));
  expect(edit(({ records }) => {
    records[3].attempts[1].client = { e3: true, e7: true, e6: "deleted" };
  })).toEqual(reject("client_state"));
  expect(edit(({ records }) => {
    const record = records[3];
    record.attempts.push(cache(record.identity_ref, record.slug_ref, 99, "transport_lost"));
  })).toEqual(reject("client_state"));
});

it("rejects unsupported response projections and checks each evidence constant", () => {
  for (const [attemptIndex, field, value] of [
    [1, "status", 200], [1, "reason", null], [1, "no_store", false],
    [1, "api_version", 2], [1, "content_type", "application/json; charset=utf-8"],
    [2, "status", 429], [2, "api_version", 1], [3, "status", 200],
    [4, "status", 202], [4, "response_nonce_ref", ref(99)],
    [5, "status", 202], [5, "reason", "view_present"], [5, "evidence", null],
  ] as const) {
    expect(edit(({ records }) => { Object.assign(records[3].attempts[attemptIndex], { [field]: value }); })).toEqual(reject("contradiction"));
  }
  for (const field of ["view", "current_render", "invalidation_calls", "legacy_cache"]) {
    expect(edit(({ records }) => {
      Object.assign(cached(records[0].attempts[1]).evidence!, { [field]: "fabricated" });
    })).toEqual(reject("schema"));
  }
  expect(edit(({ records }) => { cached(records[3].attempts[1]).reason = "unknown"; })).toEqual(reject("schema"));
});

it("rejects nested order changes, duplicate keys, escapes and whitespace", () => {
  const input = fixture();
  const { e3, e7, e6 } = input.records[0].attempts[0].client;
  input.records[0].attempts[0].client = { e6, e7, e3 };
  expect(verify(input)).toEqual(reject("not_canonical"));

  const original = JSON.stringify(fixture()) + "\n";
  for (const invalid of [
    original.replace('"version":1', '"version":1,"version":1'),
    original.replace('"synthetic_dev"', '"\\u0073ynthetic_dev"'),
    original.replace('"version":1', '"version": 1'),
    original.slice(0, -1),
  ]) {
    expect(verifyDeletionEvidence(new TextEncoder().encode(invalid), cloudCommit, planCommit)).toEqual(reject("not_canonical"));
  }
});

it("rejects malformed bytes, BOM, extra keys and unsupported types", () => {
  expect(verifyDeletionEvidence(Uint8Array.of(0xff), cloudCommit, planCommit)).toEqual(reject("schema"));
  expect(verifyDeletionEvidence(new Uint8Array([0xef, 0xbb, 0xbf, ...encode(fixture())]), cloudCommit, planCommit)).toEqual(reject("schema"));
  expect(verify({ ...fixture(), extra: "private-data" })).toEqual(reject("schema"));
  expect(verify({ ...fixture(), records: "array required" })).toEqual(reject("schema"));
  expect(edit(({ records }) => {
    response(records[0].attempts[0]).deletion_write_seq = Number.MAX_SAFE_INTEGER + 1;
  })).toEqual(reject("schema"));
  expect(edit(({ records }) => { Object.assign(records[0].attempts[0].client, { e3: 1 }); })).toEqual(reject("schema"));
});

it("applies input and release rejection before scenario evaluation", () => {
  const input = fixture();
  input.records[0].attempts = [];
  expect(verifyDeletionEvidence(encode(input), "c".repeat(40), planCommit)).toEqual(reject("binding_mismatch"));
  const { version, evidence, ...rest } = input;
  expect(verifyDeletionEvidence(encode({ version, evidence, ...rest }), "c".repeat(40), planCommit)).toEqual(reject("not_canonical"));
});
