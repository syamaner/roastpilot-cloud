# Snowflake key-pair provisioning and rotation

This runbook provisions and rotates the Snowflake key-pairs used by the web and
agent service users for C7-S2 (#546). It does not authorise a new production
principal or a warehouse change.

## Context and decisions

The web path uses the `PUBLIC_WEB` role. Production uses the
`ROASTPILOT_WEB_PROD` service user and Vercel's Production-scoped
`SNOWFLAKE_WEB_PRIVATE_KEY`; DEV and Preview use `ROASTPILOT_WEB` and the
Preview-scoped value. The application reads the full `SNOWFLAKE_WEB_*` set
documented in [Production deployment](prod-deploy-runbook.md).

The agent path uses the `ROASTPILOT_AGENT` role. Local configuration points
`SNOWFLAKE_PRIVATE_KEY_FILE` at the private-key file. The gated DEV CI verifier
uses byte-exact user `ROASTPILOT_AGENT_CI` and adapts its secret to that input.

User-level DDL is an operator action under `ACCOUNTADMIN` or delegated
`SECURITYADMIN`. It is not a schemachange migration, must not be put under
`snowflake/migrations/**`, and must not be run by CI. This also applies to
`ALTER USER ... DEFAULT_SECONDARY_ROLES = ()`; see `snowflake/README.md`.

Production provisioning is in [Production deployment](prod-deploy-runbook.md).
Warehouse and resource-monitor configuration is out of scope C7-S3 work; see
[Resource monitor and shared warehouse](resource-monitor.md).

## Current state and gating

| Environment | Service user | State and gate |
| --- | --- | --- |
| DEV / Preview web | `ROASTPILOT_WEB` | Exists today; rotate only its DEV / Preview credential. |
| Local agent | Configured `SNOWFLAKE_USER` | Principal authenticating with `SNOWFLAKE_PRIVATE_KEY_FILE` and holding `ROASTPILOT_AGENT`; exact live identity is required before rotation. |
| DEV CI agent | `ROASTPILOT_AGENT_CI` | Exists today; used by the human-gated agent verifier. |
| Production web | `ROASTPILOT_WEB_PROD` | Exists and is live; provisioned under C7-S1 (#545). |

Rehearse routine rotation against the existing DEV consumer before rotating
production. C7-S6 (#550) governs the separate trial-to-on-demand billing
cutover; it is not a gate on production service-user creation.

## Generate a key-pair

Generate an unencrypted PKCS8 key-pair in a secure operator environment, using
the production deployment runbook's command form:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out roastpilot_service_key.p8 -nocrypt
openssl rsa -in roastpilot_service_key.p8 -pubout -out roastpilot_service_key.pub
```

The value supplied as `RSA_PUBLIC_KEY` or `RSA_PUBLIC_KEY_2` is the public key's
single-line base64 body, without the PEM header, footer or newlines. Use
`<single-line public key body>` in reviewed material; never paste a complete
public-key body into the repository.

Do not put the private key in SQL, an issue, a pull request, chat or logs.
Upload from the operator terminal, confirm approved escrow, then remove the `.p8` file.

## Register the public key

First-time provisioning is the only place to register a key directly in
`RSA_PUBLIC_KEY`. For a new service user, use `CREATE USER ... RSA_PUBLIC_KEY`
as specified for `ROASTPILOT_WEB_PROD` in the production deployment runbook.
Alternatively, the following form is permitted only when `DESC USER` has
proved that both public-key slots on the user are empty:

```sql
USE ROLE ACCOUNTADMIN;
ALTER USER <user>
  SET RSA_PUBLIC_KEY = '<single-line public key body>';
```

Do not run that bare `SET RSA_PUBLIC_KEY` against an existing user with a
populated key slot. All current live service users are in that category; use
the zero-downtime rotation procedure below, which writes a proven-empty slot.
Before any `SET`, prove through the `[VERIFY-LIVE]` fingerprint properties from
`DESC USER` that its target slot is empty. Unknown or unreadable state fails
closed.

`SECURITYADMIN` may be used where live ownership and delegation permit it.
Confirm that authority first. Production provisioning uses
`CREATE USER ROASTPILOT_WEB_PROD` with
`TYPE = SERVICE`, `DEFAULT_ROLE = PUBLIC_WEB`,
`DEFAULT_SECONDARY_ROLES = ()`, `DEFAULT_WAREHOUSE = ROASTPILOT_WH`, and the
public key exactly as specified in the production deployment runbook. Rotation
of an existing user uses `ALTER USER ... SET` and `ALTER USER ... UNSET`, not
`CREATE USER`.

Any newly created or re-created service user must carry
`DEFAULT_SECONDARY_ROLES = ()`. Verify it live as `ACCOUNTADMIN`; do not infer
it from the creation statement:

```sql
USE ROLE ACCOUNTADMIN;
SHOW USERS LIKE '<user>';
```

`default_secondary_roles` is the connector column used by the verifier, but
its exact `SHOW USERS` spelling and returned shape are `[VERIFY-LIVE]`. It must
be verifiably empty. A blank, missing, unknown, or unrecognised value is not
verification; stop and do not proceed.

`LIKE` treats each `_` in a service-user name as a single-character wildcard.
Accept the result only when exactly one returned row has a `name` that exactly
matches the intended Snowflake user; only that row's `default_secondary_roles`
value may be checked. A wildcard lookalike, zero exact matches, or multiple
exact matches is not identity verification; stop and do not proceed.

For the key fingerprints, inspect the user without exposing either key:

```sql
USE ROLE ACCOUNTADMIN;
DESC USER <user>;
```

The exact fingerprint property names and result shape are `[VERIFY-LIVE]`.
Record fingerprints only, never a private key or a full public-key body.

## Where each private key lives

The web consumer reads `SNOWFLAKE_WEB_PRIVATE_KEY`. Store the production key at
Production scope and the DEV key at Preview scope. For first-time creation,
when the variable is absent, upload from the operator terminal with plain
`vercel env add`:

```bash
vercel env add SNOWFLAKE_WEB_PRIVATE_KEY production < roastpilot_service_key.p8
vercel env add SNOWFLAKE_WEB_PRIVATE_KEY preview < roastpilot_service_key.p8
```

During rotation the variable already exists. Overwrite only the intended scope
with `--force`:

```bash
vercel env add SNOWFLAKE_WEB_PRIVATE_KEY production --force < roastpilot_service_key.p8
vercel env add SNOWFLAKE_WEB_PRIVATE_KEY preview --force < roastpilot_service_key.p8
```

Run only the command for the intended environment. The associated
`SNOWFLAKE_WEB_USER` must name `ROASTPILOT_WEB_PROD` in Production and
`ROASTPILOT_WEB` in Preview. Set
`SNOWFLAKE_WEB_PRIVATE_KEY_PASSPHRASE` only for an encrypted key; the generated
`-nocrypt` key does not use it.

The local agent user is the exact value of the consumer's configured
`SNOWFLAKE_USER`. That principal authenticates with the file named by
`SNOWFLAKE_PRIVATE_KEY_FILE` and holds the `ROASTPILOT_AGENT` role. Before any
slot `SET` or `UNSET`, confirm the configured `SNOWFLAKE_USER` and apply the
exact-one-row `SHOW USERS LIKE '<user>'` name check above to that value. Do not
rotate a user merely because it holds `ROASTPILOT_AGENT`. Protect the key file
with operator-only permissions and set `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` only
when the file is encrypted.

The `ROASTPILOT_AGENT_CI` consumer is instead the `dev-snowflake-agent` GitHub
Environment secret `SNOWFLAKE_AGENT_PRIVATE_KEY`, with optional
`SNOWFLAKE_AGENT_PRIVATE_KEY_PASSPHRASE`. The gated
`dev-snowflake-agent-verify.yml` workflow converts that secret to its temporary
file input. Rotate this principal by updating the Environment secret as a
GitHub operator, then re-dispatch the gated workflow and prove new-key
authentication before unsetting the old slot. Do not copy the secret into a
repository file.

When installing an unencrypted `-nocrypt` replacement, explicitly delete the
matching passphrase setting as part of the rotation:
`SNOWFLAKE_WEB_PRIVATE_KEY_PASSPHRASE` for web,
`SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` for a local agent, or
`SNOWFLAKE_AGENT_PRIVATE_KEY_PASSPHRASE` in the `dev-snowflake-agent`
Environment. A stale non-empty passphrase makes unencrypted-key loading fail.
Alternatively, use an encrypted replacement and update its matching passphrase.

## Zero-downtime rotation

Use Snowflake's documented two-key mechanism for a routine rotation. Exact live
fingerprint column spellings remain `[VERIFY-LIVE]` as described above.

1. Generate a new key-pair and escrow the new private key.
2. Inspect the user and prove which public-key slot is empty. Always write the
   empty slot; never overwrite the in-use slot. For the first rotation, when
   slot 2 is proven empty, run:

   ```sql
   USE ROLE ACCOUNTADMIN;
   ALTER USER <user>
     SET RSA_PUBLIC_KEY_2 = '<single-line public key body>';
   ```

   Both keys are now valid simultaneously, so there is no authentication gap.
3. Roll the matching consumer to the new private key. For web, update
   `SNOWFLAKE_WEB_PRIVATE_KEY` at the correct Vercel scope with `--force`, then
   redeploy. An environment change does not propagate to an existing
   deployment. For a local agent, replace the file referenced by
   `SNOWFLAKE_PRIVATE_KEY_FILE` and restart the agent process. For
   `ROASTPILOT_AGENT_CI`, update `SNOWFLAKE_AGENT_PRIVATE_KEY` in the
   `dev-snowflake-agent` GitHub Environment and re-dispatch its gated workflow.
4. Before relying on an authentication probe, confirm that the exact consumer
   target was updated: the correct Vercel scope and a fresh deployment built
   with its new environment value, the configured local key-file path and a
   restarted agent, or the correct GitHub Environment secret and a fresh gated
   workflow dispatch. Then probe that target. Because both Snowflake keys are
   valid at this point, a bare authentication success without this target
   confirmation is not proof of new-key uptake. Whether the target has picked
   up the new key is `[VERIFY-LIVE]`; credential or identity uncertainty fails
   closed. If confirmation or the probe fails, do not unset the old key.
5. Only after the new-key probe succeeds and the applicable deployment guard
   is complete, revoke the old slot. Guard the deployments belonging to the
   web principal being rotated:

   - For `ROASTPILOT_WEB_PROD`, first rebuild or redeploy a known-good
     Production rollback target with the new Production-scoped key and verify
     that it authenticates. At least one such deployment must be promotable
     before revocation; only then is the documented `vercel rollback` or
     promotion path safe.
   - For `ROASTPILOT_WEB`, redeploy or retire every Preview deployment that
     must remain usable before revocation, because existing deployments retain
     their old Preview environment value.

   Set `<old-key-slot>` to `RSA_PUBLIC_KEY` or `RSA_PUBLIC_KEY_2`, whichever
   slot the `[VERIFY-LIVE]` fingerprint check proves holds the old,
   now-rolled-off key. Keep that old public-key body in approved escrow until
   post-revocation verification succeeds:

   ```sql
   USE ROLE ACCOUNTADMIN;
   ALTER USER <user> UNSET <old-key-slot>;
   ```

6. Immediately repeat the probe against the exact consumer target. For every
   web target, including each rollback deployment that must remain usable, use
   its own new, distinct, never-previously-requested route-valid Base58 slug.
   Probe the deployment belonging to the rotated principal: Production for
   `ROASTPILOT_WEB_PROD`, or the specific authenticated Preview deployment for
   `ROASTPILOT_WEB`.
   Do not reuse the pre-revocation slug or one used for another deployment; the
   resulting 404 must perform a fresh Snowflake query rather than return a
   cached null. This post-revocation probe is the final proof that the target
   uses the new key. If it fails, restore the dual-key state by putting the
   escrowed old public-key body back into the now-empty `<old-key-slot>`, then
   diagnose the consumer:

   ```sql
   USE ROLE ACCOUNTADMIN;
   ALTER USER <user>
     SET <old-key-slot> = '<old single-line public key body>';
   ```

For every later rotation, derive both the target slot and the old slot from the
live `[VERIFY-LIVE]` fingerprint and empty-slot checks. Never assume which
named slot holds either key. Always write the proven-empty slot and never
overwrite the in-use slot.

Compromise or emergency exception, revoke first: when the current private key
is known or credibly suspected to be compromised, invert the normal order.
Unset the compromised public-key slot first, accepting the brief authentication
gap, then register, distribute, restart or redeploy, and verify the replacement.
Containment takes priority over zero downtime in this named exception.

## Verify

The sanctioned `ROASTPILOT_AGENT_CI` verification path is a human-approved
dispatch of `dev-snowflake-agent-verify.yml`. It supplies both the agent and
seed secrets from the `dev-snowflake-agent` GitHub Environment and converts
them to temporary files before running the verifier.

A local run requires the intended `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`,
`SNOWFLAKE_ROLE`, `SNOWFLAKE_WAREHOUSE`, and `SNOWFLAKE_PRIVATE_KEY_FILE` agent
configuration. It additionally requires `SNOWFLAKE_SEED_PRIVATE_KEY_FILE` for
the fixed `ROASTPILOT_SEED_CI` principal, plus
`SNOWFLAKE_SEED_PRIVATE_KEY_PASSPHRASE` when that seed key is encrypted:

```bash
python3 snowflake/upsert_roast_verify_live.py --target ROASTPILOT_DEV
```

The script always calls `connect_seed` and opens that seed connection. An
agent-only local configuration therefore fails before it can complete the
rotated-agent verification.

For web key-pair authentication, select the deployment belonging to the
principal being rotated and use a freshly generated, route-valid Base58 slug
that meets the entropy floor and has never been requested before.

For `ROASTPILOT_WEB_PROD`, probe the Production URL:

```bash
curl -i 'https://roastpilot-cloud.vercel.app/r/<fresh-route-valid-base58-slug>'
```

For `ROASTPILOT_WEB`, probe the specific Preview deployment carrying the new
Preview-scoped key, never the Production alias. If deployment protection is
enabled, use an authenticated access path such as `vc curl` so the request
reaches the route:

```bash
vc curl '/r/<fresh-route-valid-base58-slug>' --deployment '<preview-deployment-url>'
```

It must return the graceful 404 page, never 500. A placeholder such as
`missing` can fail route validation before Snowflake is queried, and a
previously requested valid slug can return a cached null for five minutes. The
fresh-slug 404 performs that deployment's Snowflake query and therefore proves
that it authenticates with the rotated principal's key, uses the `PUBLIC_WEB`
grants, and reaches Snowflake.

A scripted review-write POST that reaches BotID must return 403:

```bash
curl -i -X POST \
  'https://roastpilot-cloud.vercel.app/api/r/23456789ABCDEFGHJK/reviews' \
  -H 'Content-Type: application/json' \
  --data '{"score":5,"website":""}'
```

That 403 proves only the fail-closed BotID edge gate; the scripted POST does
not authenticate to Snowflake or verify `SUBMIT_REVIEW`. Verify the positive
write path with a genuine browser submission for a known non-private roast,
which passes BotID and completes successfully.

Confirm that the target was redeployed after the environment update. Consumer
uptake and all HTTP results are `[VERIFY-LIVE]`. Do not print the new secret in
debug output, evidence, or logs.

If the agent probe or fresh-slug web GET does not pass on the new key, do not
unset the old key. Keep the dual-key state, diagnose the consumer, and repeat
the live probe without exposing credential material.

## Ownership summary

| Step | Owner and identity |
| --- | --- |
| Generate and escrow a key-pair | Operator in the approved secure environment |
| Rotate the existing production web service user provisioned under C7-S1 (#545) | Operator as `ACCOUNTADMIN` or authorised `SECURITYADMIN` |
| Set or unset a service user's public-key slot | Operator as `ACCOUNTADMIN` or authorised `SECURITYADMIN` |
| Verify `DEFAULT_SECONDARY_ROLES = ()` and fingerprints | Operator as `ACCOUNTADMIN` |
| Upload a web private key and redeploy | Orchestrator and operator, with the operator supplying the private key at the CLI |
| Replace a local agent private-key file and restart | Agent operator |
| Run the local agent live probe | Agent operator through `ROASTPILOT_AGENT` |
| Update the `dev-snowflake-agent` Environment secret and dispatch the gated DEV CI probe | GitHub operator, human approver, and `ROASTPILOT_AGENT_CI` |
| Run the web HTTP probes and genuine browser submission | Orchestrator against the redeployed target |
| Remove plaintext working files after escrow | Operator |

Schemachange owns database schema evolution. It does not own these service-user
key operations, and no CI migration substitutes for the operator identities
listed above.
