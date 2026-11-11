# C9-C4 synthetic DEV deletion and retry evidence

The verifier reports structural completeness of operator-recorded evidence only.

Evidence references are protected and do not anonymise the underlying values.

G1–G6 remain operator-only and unperformed, and the cloud-sync feature stays off.

This procedure records observations from a separately authorised synthetic DEV run. It gives no authority or instructions to produce faults or operate on a deployment. The verifier does not establish that an observation occurred, identify a running deployment or establish a complete deployment inventory. A deployment, rollback or configuration change requires fresh operator evidence.

## Protect and bind the recording

Use the [backup manifest's protected evidence controls](backup-export.md) for the recording and underlying observations. Keep the file in the approved encrypted store with access restricted to authorised operators. Keep the independently verified full lowercase Cloud and Plan commits with the recording. Supply those expected commits from the approved run binding when verifying.

Before projecting any response, verify the actual observed identifiers, request and response bytes, and applicable headers. Keep the original observations in the protected store. Do not publish or log references, raw identifiers, request or response bytes, credentials or paths.

For every reference, compute SHA-256 over UTF-8 bytes of the following segments with one LF between segments and no final LF. Use the 64 lowercase hex digest.

| Reference | Segments in order |
|---|---|
| Identity | `roastpilot/c9-c4/identity/v1`, run ID, public slug |
| Slug | `roastpilot/c9-c4/slug/v1`, public slug |
| Roast | `roastpilot/c9-c4/roast/v1`, Cloud roast ID |
| Nonce | `roastpilot/c9-c4/nonce/v1`, exact request or response nonce |

## Record canonical version 1

Write one compact UTF-8 JSON object followed by one LF. Use the exact key order below at every level and preserve the observed order of records and attempts. Omit neither required keys nor nullable projection fields. Do not add keys, whitespace, a BOM or redundant escapes.

| Object | Keys in order |
|---|---|
| Suite | `evidence, version, cloud_commit, plan_commit, target_class, records` |
| Record | `scenario, identity_ref, slug_ref, attempts` |
| Server response | `kind, identity_ref, deletion, cloud_roast_ref, deletion_write_seq, stage_removal, cache_invalidation, client` |
| Server failure | `kind, identity_ref, failure_class, commit_observation, client` |
| Cache attempt | `kind, identity_ref, request_nonce_ref, outcome, status, api_version, response_slug_ref, response_nonce_ref, content_type, no_store, reason, evidence, client` |
| Complete cache evidence | `view, current_render, invalidation_calls, legacy_cache` |
| Client | `e3, e7, e6` |

Set suite evidence to `roastpilot/c9-c4/deletion-retry`, version to 1 and target class to `synthetic_dev`. Use a distinct scenario, identity and slug for each record. Bind all attempts to that record's identity. Use a fresh request nonce for each cache attempt across the entire suite.

- Record `server_response` with deletion `deleted`, `tombstoned_without_row` or `already_tombstoned`. Record a nonnegative safe integer deletion sequence and stage removal `removed` or `failed`. Server cache invalidation is `pending`. A fresh deletion with a row requires its roast reference. A fresh tombstone without a row requires null. Replays retain the roast reference and deletion sequence and report `already_tombstoned`. A legacy null sequence cannot qualify.
- Record `server_failure` with failure class `transport_lost`, `malformed_response` or `sql_error`. Commit observation is `unknown` unless a retained same-operation commit observation supports `same_identity_commit_observed` after transport loss or a malformed response. The recorded label does not establish the observation's truth. An initial already-tombstoned result needs that preceding observation. An observed same-operation commit followed by a fresh deletion is contradictory.
- Record `cache_attempt` as `complete` or `pending` only after verifying exact current response JSON body bytes, API version 1, same slug, echoed request nonce, exact content type `application/json` and no-store. Use 200 with null reason and the closed evidence for complete. Use 202 with null evidence and reason `view_present`, `view_invalid`, `view_unavailable` or `invalidation_failed` for pending.
- The complete cache evidence values, in order, are `absent_uncached_before_and_after`, `uncached`, `requested` and `transition_qualified_non_servability`. Completion follows a valid same-identity server result.
- For `refused`, record status 400, 401, 404, 405, 415 or 503. For `malformed_200`, record 200. For `transport_lost`, record null. In all three cases use null for the other response projection fields, even if the raw failed response contains a valid field. Report unsupported statuses or shapes separately without manufacturing a supported observation.

Record the durable client state after each attempt. E3 and E7 begin false and never revert. E3 first becomes true only on a valid server response. E7 first becomes true only on exact cache completion. E6 is `deleted` exactly when both are true, otherwise it is `pending`. Premature pending and refused attempts earn no acknowledgement. Failed responses and stage results earn no cache acknowledgement.

## Required observations

A finished record ends with exact cache completion and both durable acknowledgements. Its latest server result reports stage removal `removed`, a point-in-time observation separate from the durable acknowledgements. The finished suite covers all four scenarios and all three server response classes.

| Scenario | Observations |
|---|---|
| `first_attempt_complete` | One first delete result followed by one exact cache completion. |
| `recovered_stage_failure` | Failed stage removal on the first server result. Later same-identity, same-sequence already-tombstoned result reports removal. No server failure is used to qualify this case. |
| `recovered_lost_server_ack` | First server attempt loses or malforms the acknowledgement and has retained same-operation commit evidence. Recovery reports already tombstoned, followed by exact cache completion. A fresh delete after pre-commit transport failure is insufficient. |
| `recovered_cache_failure` | Pending, refused, transport lost and malformed 200 before final exact completion for the same identity, using a fresh nonce each time. |

D223 allows private stage bytes to persist indefinitely. D229 allows provider bytes to remain and a previously in-flight uncached response to finish. Edge and third-party copies remain residuals.

## Verify offline

From the repository root with Node 22, use:

```text
node --experimental-strip-types scripts/c4/deletion-evidence-cli.mts --expected-cloud-commit <cloud-commit> --expected-plan-commit <plan-commit> <evidence-file>
```

The CLI emits one compact JSON verdict followed by LF. Interpret exit and verdict together:

- Exit 0, `evidence_structurally_complete`: the recording meets this structural contract. Retain the observations and keep operator qualification separate.
- Exit 1, `evidence_incomplete`: qualification stays pending. `scenario_unsatisfied` identifies an unfinished record and `missing_scenario` identifies missing suite coverage.
- Exit 1, `evidence_rejected`: qualification stays pending. The fixed reason is `unreadable`, `schema`, `not_canonical`, `binding_mismatch`, `identity_mismatch`, `unsupported_legacy_sequence`, `contradiction`, `nonce_reuse` or `client_state`. Resolve against the protected original observations and independently verified commit binding.
- Exit 2: invalid invocation, with empty stdout and a fixed usage line on stderr.
