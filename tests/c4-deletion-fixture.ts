export const cloudCommit = "a".repeat(40);
export const planCommit = "b".repeat(40);

type Client = { e3: boolean; e7: boolean; e6: "pending" | "deleted" };
type ServerResponse = {
  kind: "server_response";
  identity_ref: string;
  deletion: "deleted" | "tombstoned_without_row" | "already_tombstoned";
  cloud_roast_ref: string | null;
  deletion_write_seq: number | null;
  stage_removal: "removed" | "failed";
  cache_invalidation: "pending";
  client: Client;
};
type ServerFailure = {
  kind: "server_failure";
  identity_ref: string;
  failure_class: "transport_lost" | "malformed_response" | "sql_error";
  commit_observation: "same_identity_commit_observed" | "unknown";
  client: Client;
};
type CompleteEvidence = {
  view: string;
  current_render: string;
  invalidation_calls: string;
  legacy_cache: string;
};
type CacheAttempt = {
  kind: "cache_attempt";
  identity_ref: string;
  request_nonce_ref: string;
  outcome: "complete" | "pending" | "refused" | "transport_lost" | "malformed_200";
  status: number | null;
  api_version: number | null;
  response_slug_ref: string | null;
  response_nonce_ref: string | null;
  content_type: string | null;
  no_store: boolean | null;
  reason: string | null;
  evidence: CompleteEvidence | null;
  client: Client;
};
type Attempt = ServerResponse | ServerFailure | CacheAttempt;
type Record = {
  scenario: "first_attempt_complete" | "recovered_stage_failure" | "recovered_lost_server_ack" | "recovered_cache_failure";
  identity_ref: string;
  slug_ref: string;
  attempts: Attempt[];
};

export const ref = (value: number) => value.toString(16).padStart(64, "0");
const before = (): Client => ({ e3: false, e7: false, e6: "pending" });
const serverAck = (): Client => ({ e3: true, e7: false, e6: "pending" });
const both = (): Client => ({ e3: true, e7: true, e6: "deleted" });

export function server(
  identity: string, deletion: ServerResponse["deletion"], roast: string | null,
  sequence: number, stage: ServerResponse["stage_removal"],
): ServerResponse {
  return {
    kind: "server_response",
    identity_ref: identity,
    deletion,
    cloud_roast_ref: roast,
    deletion_write_seq: sequence,
    stage_removal: stage,
    cache_invalidation: "pending",
    client: serverAck(),
  };
}

function lost(identity: string): ServerFailure {
  return {
    kind: "server_failure",
    identity_ref: identity,
    failure_class: "transport_lost",
    commit_observation: "same_identity_commit_observed",
    client: before(),
  };
}

export function cache(
  identity: string, slug: string, nonce: number, outcome: CacheAttempt["outcome"],
): CacheAttempt {
  const nonceRef = ref(nonce);
  const acknowledged = outcome === "complete" || outcome === "pending";
  return {
    kind: "cache_attempt",
    identity_ref: identity,
    request_nonce_ref: nonceRef,
    outcome,
    status: { complete: 200, pending: 202, refused: 401, transport_lost: null, malformed_200: 200 }[outcome],
    api_version: acknowledged ? 1 : null,
    response_slug_ref: acknowledged ? slug : null,
    response_nonce_ref: acknowledged ? nonceRef : null,
    content_type: acknowledged ? "application/json" : null,
    no_store: acknowledged ? true : null,
    reason: outcome === "pending" ? "invalidation_failed" : null,
    evidence: outcome === "complete" ? {
      view: "absent_uncached_before_and_after",
      current_render: "uncached",
      invalidation_calls: "requested",
      legacy_cache: "transition_qualified_non_servability",
    } : null,
    client: outcome === "complete" ? both() : serverAck(),
  };
}

export function fixture() {
  const records: Record[] = [
    {
      scenario: "first_attempt_complete", identity_ref: ref(1), slug_ref: ref(11),
      attempts: [
        server(ref(1), "deleted", ref(21), 7, "removed"),
        cache(ref(1), ref(11), 31, "complete"),
      ],
    },
    {
      scenario: "recovered_stage_failure", identity_ref: ref(2), slug_ref: ref(12),
      attempts: [
        server(ref(2), "tombstoned_without_row", null, 8, "failed"),
        server(ref(2), "already_tombstoned", null, 8, "removed"),
        cache(ref(2), ref(12), 32, "complete"),
      ],
    },
    {
      scenario: "recovered_lost_server_ack", identity_ref: ref(3), slug_ref: ref(13),
      attempts: [
        lost(ref(3)),
        server(ref(3), "already_tombstoned", ref(23), 9, "removed"),
        cache(ref(3), ref(13), 33, "complete"),
      ],
    },
    {
      scenario: "recovered_cache_failure", identity_ref: ref(4), slug_ref: ref(14),
      attempts: [
        server(ref(4), "deleted", ref(24), 10, "removed"),
        cache(ref(4), ref(14), 34, "pending"),
        cache(ref(4), ref(14), 35, "refused"),
        cache(ref(4), ref(14), 36, "transport_lost"),
        cache(ref(4), ref(14), 37, "malformed_200"),
        cache(ref(4), ref(14), 38, "complete"),
      ],
    },
  ];
  return {
    evidence: "roastpilot/c9-c4/deletion-retry",
    version: 1,
    cloud_commit: cloudCommit,
    plan_commit: planCommit,
    target_class: "synthetic_dev",
    records,
  };
}

export function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value) + "\n");
}

export function response(attempt: Attempt): ServerResponse {
  if (attempt.kind !== "server_response") throw new Error("Expected synthetic server response");
  return attempt;
}

export function failure(attempt: Attempt): ServerFailure {
  if (attempt.kind !== "server_failure") throw new Error("Expected synthetic server failure");
  return attempt;
}

export function cached(attempt: Attempt): CacheAttempt {
  if (attempt.kind !== "cache_attempt") throw new Error("Expected synthetic cache attempt");
  return attempt;
}
