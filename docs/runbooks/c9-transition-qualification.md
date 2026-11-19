# C9-C4 fleet transition qualification

Structural completeness checks the supplied offline relationships. The operator must verify the underlying evidence and current binding before relying on it.

Per-call cache acknowledgement and fleet transition evidence are both required and have independent meanings.

Use this procedure for the D228/D229 transition to uncached public pages and previews. The [per-call deletion procedure](c9-qualification.md) separately proves the required deletion, cache acknowledgement and fresh absence observations for one operation. A fleet transition record cannot supply that proof. Fleet qualification covers the relevant deployments, aliases, producers and rollback candidates.

G1–G6 remain operator-only and unperformed, and cloud sync stays off.

## Capture and corroborate

1. Obtain the current Cloud and Plan commits, scope and fleet references from independent operator records. Determine which aliases, direct deployment URLs, legacy producers and promotion or rollback candidates can affect the in-scope data. Retain the asset-to-subject mapping with the inventory. Record distinct subjects for current aliases and every directly serving legacy deployment URL, even if they refer to the same underlying deployment or an alias name has been reused. Keep the historic serving surface and its current replacement distinguishable. Retain every prior legacy target in the inventory as ineligible.
2. Capture distinct chronological start and end identities for the protected observation interval. Compare the actual subject assignments, bindings, configuration and candidate state as well as membership. Independently substantiate inventory authority, completeness and fleet stability. Only corroborated evidence qualifies an observation as verified.
3. For each legacy alias and URL, verify that the pretransition page, preview and associated data can no longer be served, using evidence for both route families. Removal can support the result. A source marker, elapsed time, access restriction or bare URL/list absence alone is unsupported. Verify termination or drain of each legacy producer for the relevant scope separately.
4. For each current uncached alias, URL and eligible target, and for the alternate recovery target, corroborate the build, intended data binding, actual serving behaviour and absence of applicable service-controlled stale caching for each route family. The page source uses dynamic rendering and the preview directly sets no-store. Verify actual serving behaviour before relying on either route family. The page source alone does not establish a literal page response header.
5. Confirm that every out-of-scope subject cannot serve or produce the in-scope data and is excluded from production rollback or promotion. A preview label alone is unsupported. Record rollback policy with the exact approved current uncached targets. Exclude every ISR-era target.
6. Retain a recovery procedure and separate observation of a successful demonstration for one distinct alternate subject and its release. An existing uncached target or a demonstrated rebuild from a qualified release can qualify, including a rebuild of the running revision with a separately demonstrated procedure. A pointer to the running deployment alone is insufficient. Qualification does not require a promotion, live deployment or already-running alternate instance.

Agreement between listings and absence of a listed URL do not prove producer drain, inventory completeness or non-servability.

Keep source listings and the protected identity mapping with the original source, record and authorisation in protected storage. Use opaque references in the verifier file. They remain correlatable and do not establish provenance or anonymity. Keep credentials, request headers, raw roast records and identifying raw data out of verifier input and public evidence. Use only authorised protected handling.

Qualification covers the corroborated serving surface. Provider-stored bytes, already in-flight uncached responses, edge limits and third-party copies can remain. Physical erasure and timing need separate evidence.

Keep qualification pending whenever a required observation or the current fleet binding cannot be independently verified.

Recapture after deployment, rollback, promotion, alias or configuration changes, or if the external binding cannot be verified. The offline verifier checks relationships in supplied records. The operator establishes chronology, source independence, external completeness, truth, operator identity, provider behaviour and current binding.

## Evidence v1

Use UTF-8 compact JSON with one final LF and the exact key orders below. A reference is 64 lowercase hexadecimal characters and a commit is 40 lowercase hexadecimal characters. Arrays of subjects and observations sort by ascending ASCII ID. Member references sort by ascending ASCII value. Report each member, subject ID, observation ID and observation kind/subject pair only once. Start and end differ. A subject ID differs from the scope reference. A source differs from its own observation ID.

| Object | Ordered keys and values |
| --- | --- |
| Suite | `evidence` = `roastpilot/c9-c4/transition`, `version` = 1, `cloud_commit` (commit), `plan_commit` (commit), `scope`, `fleet`, `start`, `end` (references), `subjects` (Subject array), `observations` (Observation array) |
| Subject | `id` (reference), `kind` (`alias`, `url`, `producer`, `target`), `classification` (`current_uncached`, `legacy`, `out_of_scope`, `recovery`, `unknown`), `release` (commit or null) |
| Observation | `id` (reference), `kind` (table below), `subject`, `scope`, `fleet`, `start`, `end`, `source` (references), `outcome` (`verified`, `unknown`, `unsupported`, `failed`, `changed`), `members` (reference array) |

Recovery must be a target. A producer with known classification is legacy or out of scope. Current uncached and recovery subjects require a release. Legacy, out-of-scope and unknown subjects use null. Current uncached aliases and URLs use the bound Cloud release. Match each observation's scope, fleet and interval to the suite.

Record one observation for each row/subject combination. Each is verified for completeness. Members are empty unless the table specifies otherwise. Unknown subjects appear only in the inventory lists and completeness membership and leave qualification pending.

| Observation kind | Subject and membership |
| --- | --- |
| `inventory_authority` | Scope. Corroborate authority and scope. |
| `inventory_start`, `inventory_end`, `inventory_completeness` | Scope. Each member set is exactly all disclosed subject IDs. |
| `rollback_policy` | Scope. Members are exactly all current uncached targets. |
| `page_nonservable`, `preview_nonservable` | Each legacy alias and URL. |
| `page_uncached`, `preview_uncached` | Each current uncached alias, URL and target, plus the recovery target. |
| `producer_drained` | Each legacy producer. |
| `scope_exclusion` | Each out-of-scope subject. |
| `recovery_procedure`, `recovery_demonstrated` | The recovery target. |

Use distinct source references between inventory authority/completeness and either inventory list, between serving and drain claims, and between recovery procedure and demonstration for the alternate target. Distinct labels alone cannot establish source independence.

## Run the offline check

From the repository root, use the four expected bindings from independent current operator records. Do not take expected values from the evidence file.

```text
node --experimental-strip-types scripts/c4/transition-evidence-cli.mts --expected-cloud-commit <40-hex> --expected-plan-commit <40-hex> --expected-scope <64-hex> --expected-fleet <64-hex> <evidence-file>
```

The CLI reads one local file. Invalid arguments exit 2 with empty stdout and a single fixed usage line on stderr. Other outcomes print one compact JSON line on stdout with empty stderr, and never echo the file, references or errors. Exit 0 is `{"verdict":"evidence_structurally_complete"}`. Exit 1 is `evidence_rejected` or `evidence_incomplete` with one fixed reason, evaluated in the order below after a successful read.

| Verdict | Reason | Meaning |
| --- | --- | --- |
| Rejected | `unreadable` | Could not read the file. |
| Rejected | `schema` | Invalid UTF-8, BOM, JSON or strict grammar. |
| Rejected | `not_canonical` | Noncanonical spelling, duplicate JSON keys, whitespace or ordering. |
| Rejected | `binding_mismatch` | Expected Cloud, Plan, scope or fleet differs. |
| Rejected | `identity` | Same start and end, a duplicate identity, pair or member, or a subject ID equals scope. |
| Rejected | `observation_binding` | Wrong observation binding or self-referential source. |
| Rejected | `subject_form` | Illegal kind, classification or release. |
| Rejected | `coverage_mismatch` | Unexpected observation or unequal exact membership. |
| Rejected | `evidence_reuse` | The same source is reused between specified groups. |
| Incomplete | `missing_evidence` | Missing observation or unknown subject classification. |
| Incomplete | `unverified_evidence` | At least one observation is not verified. |
| Incomplete | `missing_current_fleet` | No current uncached production alias or eligible rollback candidate. |
| Incomplete | `recovery_unqualified` | Recovery target count differs from one. |
