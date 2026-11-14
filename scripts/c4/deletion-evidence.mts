import { z } from "zod";

const commit = z.string().regex(/^[a-f0-9]{40}$/);
const reference = z.string().regex(/^[a-f0-9]{64}$/);
const scenario = z.enum([
  "first_attempt_complete",
  "recovered_stage_failure",
  "recovered_lost_server_ack",
  "recovered_cache_failure",
]);
const client = z.strictObject({
  e3: z.boolean(),
  e7: z.boolean(),
  e6: z.enum(["pending", "deleted"]),
});
const evidence = z.strictObject({
  view: z.literal("absent_uncached_before_and_after"),
  current_render: z.literal("uncached"),
  invalidation_calls: z.literal("requested"),
  legacy_cache: z.literal("transition_qualified_non_servability"),
});
const serverResponse = z.strictObject({
  kind: z.literal("server_response"),
  identity_ref: reference,
  deletion: z.enum(["deleted", "tombstoned_without_row", "already_tombstoned"]),
  cloud_roast_ref: reference.nullable(),
  deletion_write_seq: z.int().nonnegative().nullable(),
  stage_removal: z.enum(["removed", "failed"]),
  cache_invalidation: z.literal("pending"),
  client,
});
const serverFailure = z.strictObject({
  kind: z.literal("server_failure"),
  identity_ref: reference,
  failure_class: z.enum(["transport_lost", "malformed_response", "sql_error"]),
  commit_observation: z.enum(["same_identity_commit_observed", "unknown"]),
  client,
});
const cacheAttempt = z.strictObject({
  kind: z.literal("cache_attempt"),
  identity_ref: reference,
  request_nonce_ref: reference,
  outcome: z.enum(["complete", "pending", "refused", "transport_lost", "malformed_200"]),
  status: z.int().nullable(),
  api_version: z.int().nullable(),
  response_slug_ref: reference.nullable(),
  response_nonce_ref: reference.nullable(),
  content_type: z.string().nullable(),
  no_store: z.boolean().nullable(),
  reason: z.enum(["view_present", "view_invalid", "view_unavailable", "invalidation_failed"]).nullable(),
  evidence: evidence.nullable(),
  client,
});
const record = z.strictObject({
  scenario,
  identity_ref: reference,
  slug_ref: reference,
  attempts: z.array(z.discriminatedUnion("kind", [serverResponse, serverFailure, cacheAttempt])),
});
const suite = z.strictObject({
  evidence: z.literal("roastpilot/c9-c4/deletion-retry"),
  version: z.literal(1),
  cloud_commit: commit,
  plan_commit: commit,
  target_class: z.literal("synthetic_dev"),
  records: z.array(record),
});

type Suite = z.infer<typeof suite>;
type Record = z.infer<typeof record>;
type Attempt = Record["attempts"][number];
type ServerResponse = z.infer<typeof serverResponse>;
type CacheAttempt = z.infer<typeof cacheAttempt>;
type Rejection =
  | "unreadable" | "schema" | "not_canonical" | "binding_mismatch"
  | "identity_mismatch" | "unsupported_legacy_sequence" | "contradiction"
  | "nonce_reuse" | "client_state";
type Incomplete = "scenario_unsatisfied" | "missing_scenario";

export type Verdict =
  | { verdict: "evidence_structurally_complete" }
  | { verdict: "evidence_rejected"; reason: Rejection }
  | { verdict: "evidence_incomplete"; reason: Incomplete };

export function isCommit(value: string): boolean {
  return commit.safeParse(value).success;
}

function rejected(reason: Rejection): Verdict {
  return { verdict: "evidence_rejected", reason };
}

function incomplete(reason: Incomplete): Verdict {
  return { verdict: "evidence_incomplete", reason };
}

function canonicalAttempt(attempt: Attempt) {
  const client = { e3: attempt.client.e3, e7: attempt.client.e7, e6: attempt.client.e6 };
  switch (attempt.kind) {
    case "server_response":
      return {
        kind: attempt.kind,
        identity_ref: attempt.identity_ref,
        deletion: attempt.deletion,
        cloud_roast_ref: attempt.cloud_roast_ref,
        deletion_write_seq: attempt.deletion_write_seq,
        stage_removal: attempt.stage_removal,
        cache_invalidation: attempt.cache_invalidation,
        client,
      };
    case "server_failure":
      return {
        kind: attempt.kind,
        identity_ref: attempt.identity_ref,
        failure_class: attempt.failure_class,
        commit_observation: attempt.commit_observation,
        client,
      };
    case "cache_attempt": {
      const evidence = attempt.evidence;
      return {
        kind: attempt.kind,
        identity_ref: attempt.identity_ref,
        request_nonce_ref: attempt.request_nonce_ref,
        outcome: attempt.outcome,
        status: attempt.status,
        api_version: attempt.api_version,
        response_slug_ref: attempt.response_slug_ref,
        response_nonce_ref: attempt.response_nonce_ref,
        content_type: attempt.content_type,
        no_store: attempt.no_store,
        reason: attempt.reason,
        evidence: evidence === null ? null : {
          view: evidence.view,
          current_render: evidence.current_render,
          invalidation_calls: evidence.invalidation_calls,
          legacy_cache: evidence.legacy_cache,
        },
        client,
      };
    }
  }
}

function canonicalBytes(input: Suite): string {
  return JSON.stringify({
    evidence: input.evidence,
    version: input.version,
    cloud_commit: input.cloud_commit,
    plan_commit: input.plan_commit,
    target_class: input.target_class,
    records: input.records.map((item) => ({
      scenario: item.scenario,
      identity_ref: item.identity_ref,
      slug_ref: item.slug_ref,
      attempts: item.attempts.map(canonicalAttempt),
    })),
  }) + "\n";
}

const refusalStatuses = new Set([400, 401, 404, 405, 415, 503]);

function validCacheProjection(attempt: CacheAttempt, slug: string): boolean {
  if (attempt.outcome === "complete" || attempt.outcome === "pending") {
    if (attempt.api_version !== 1 || attempt.content_type !== "application/json") return false;
    if (attempt.response_slug_ref !== slug) return false;
    if (attempt.response_nonce_ref !== attempt.request_nonce_ref) return false;
    if (attempt.no_store !== true) return false;
    if (attempt.outcome === "complete") {
      return attempt.status === 200 && attempt.reason === null && attempt.evidence !== null;
    }
    return attempt.status === 202 && attempt.reason !== null && attempt.evidence === null;
  }
  const nullProjection = attempt.api_version === null && attempt.response_slug_ref === null
    && attempt.response_nonce_ref === null && attempt.content_type === null
    && attempt.no_store === null && attempt.reason === null && attempt.evidence === null;
  if (!nullProjection) return false;
  if (attempt.outcome === "refused") {
    return attempt.status !== null && refusalStatuses.has(attempt.status);
  }
  return attempt.status === (attempt.outcome === "malformed_200" ? 200 : null);
}

function checkObservations(item: Record, nonces: Set<string>): Rejection | undefined {
  let firstResponse: ServerResponse | undefined;
  let knownCommit = false;
  let e3 = false;
  let e7 = false;

  for (const attempt of item.attempts) {
    if (attempt.identity_ref !== item.identity_ref) return "identity_mismatch";
    if (attempt.kind === "server_failure" && attempt.commit_observation === "same_identity_commit_observed") {
      if (attempt.failure_class === "sql_error") return "contradiction";
      knownCommit = true;
    }
    if (attempt.kind === "server_response") {
      if (attempt.deletion_write_seq === null) return "unsupported_legacy_sequence";
      if (firstResponse) {
        if (attempt.deletion_write_seq !== firstResponse.deletion_write_seq) return "contradiction";
        if (attempt.cloud_roast_ref !== firstResponse.cloud_roast_ref) return "contradiction";
        if (attempt.deletion !== "already_tombstoned") return "contradiction";
      } else {
        if (knownCommit && attempt.deletion !== "already_tombstoned") return "contradiction";
        if (!knownCommit && attempt.deletion === "already_tombstoned") return "contradiction";
        if (attempt.deletion === "deleted" && attempt.cloud_roast_ref === null) return "contradiction";
        if (attempt.deletion === "tombstoned_without_row" && attempt.cloud_roast_ref !== null) return "contradiction";
        firstResponse = attempt;
      }
    }
    if (attempt.kind === "cache_attempt") {
      if (nonces.has(attempt.request_nonce_ref)) return "nonce_reuse";
      nonces.add(attempt.request_nonce_ref);
      if (!validCacheProjection(attempt, item.slug_ref)) return "contradiction";
      if (attempt.outcome === "complete" && !firstResponse) return "contradiction";
    }

    const next = attempt.client;
    if ((e3 && !next.e3) || (e7 && !next.e7)) return "client_state";
    if (!e3 && next.e3 && attempt.kind !== "server_response") return "client_state";
    if (!e7 && next.e7 && !(attempt.kind === "cache_attempt" && attempt.outcome === "complete")) {
      return "client_state";
    }
    if (next.e6 !== (next.e3 && next.e7 ? "deleted" : "pending")) return "client_state";
    ({ e3, e7 } = next);
  }
}

function completeRecord(item: Record): boolean {
  const last = item.attempts.at(-1);
  if (last?.kind !== "cache_attempt" || last.outcome !== "complete" || !last.client.e3 || !last.client.e7) {
    return false;
  }
  const responses = item.attempts.filter((attempt) => attempt.kind === "server_response");
  const first = responses[0];
  const latest = responses.at(-1);
  if (!first || !latest) return false;
  if (latest.stage_removal !== "removed") return false;

  switch (item.scenario) {
    case "first_attempt_complete":
      return item.attempts.length === 2 && first.deletion !== "already_tombstoned";
    case "recovered_stage_failure":
      if (first.stage_removal !== "failed") return false;
      return responses.length >= 2 && !item.attempts.some((attempt) => attempt.kind === "server_failure");
    case "recovered_lost_server_ack": {
      const initial = item.attempts.find((attempt) => attempt.kind !== "cache_attempt");
      return initial?.kind === "server_failure"
        && initial.commit_observation === "same_identity_commit_observed"
        && first.deletion === "already_tombstoned";
    }
    case "recovered_cache_failure": {
      const firstServerIndex = item.attempts.indexOf(first);
      const firstCompletionIndex = item.attempts.findIndex((attempt) =>
        attempt.kind === "cache_attempt" && attempt.outcome === "complete");
      const qualifyingAttempts = item.attempts.slice(firstServerIndex + 1, firstCompletionIndex);
      const outcomes = new Set(qualifyingAttempts.flatMap((attempt) =>
        attempt.kind === "cache_attempt" ? [attempt.outcome] : []));
      if (!outcomes.has("pending")) return false;
      if (!outcomes.has("refused")) return false;
      if (!outcomes.has("transport_lost")) return false;
      if (!outcomes.has("malformed_200")) return false;
      return true;
    }
  }
}

export function verifyDeletionEvidence(
  bytes: Uint8Array,
  expectedCloud: string,
  expectedPlan: string,
): Verdict {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return rejected("schema");
  }
  const parsed = suite.safeParse(value);
  if (!parsed.success) return rejected("schema");
  const input = parsed.data;
  if (text !== canonicalBytes(input)) return rejected("not_canonical");
  if (input.cloud_commit !== expectedCloud) return rejected("binding_mismatch");
  if (input.plan_commit !== expectedPlan) return rejected("binding_mismatch");

  const identities = new Set<string>();
  const scenarios = new Set<string>();
  const slugs = new Set<string>();
  const nonces = new Set<string>();
  const roastReferences = new Set<string>();
  const deletionSequences = new Set<ServerResponse["deletion_write_seq"]>();
  for (const item of input.records) {
    if (identities.has(item.identity_ref)) return rejected("contradiction");
    if (scenarios.has(item.scenario)) return rejected("contradiction");
    if (slugs.has(item.slug_ref)) return rejected("contradiction");
    identities.add(item.identity_ref);
    scenarios.add(item.scenario);
    slugs.add(item.slug_ref);
    const problem = checkObservations(item, nonces);
    if (problem) return rejected(problem);
    const firstResponse = item.attempts.find((attempt) => attempt.kind === "server_response");
    if (firstResponse) {
      const { cloud_roast_ref: roast, deletion_write_seq: sequence } = firstResponse;
      if (roast !== null && roastReferences.has(roast)) return rejected("contradiction");
      if (deletionSequences.has(sequence)) return rejected("contradiction");
      if (roast !== null) roastReferences.add(roast);
      deletionSequences.add(sequence);
    }
  }

  if (input.records.some((item) => !completeRecord(item))) return incomplete("scenario_unsatisfied");
  const deletions = new Set(input.records.flatMap((item) => item.attempts.flatMap((attempt) =>
    attempt.kind === "server_response" ? [attempt.deletion] : [])));
  if (scenarios.size !== scenario.options.length || deletions.size !== 3) return incomplete("missing_scenario");
  return { verdict: "evidence_structurally_complete" };
}
