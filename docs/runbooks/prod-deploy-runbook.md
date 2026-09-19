# Production deployment

This runbook deploys the Vercel application and Snowflake schema to the
production database, `ROASTPILOT`. It records the production process validated
under C7-S1 (#545). It is repeatable guidance, not authorization to weaken the
production grant boundary or the synthetic seed guard.

## Context and decisions

Production uses a separate `ROASTPILOT` database rather than DEV data
(D-C7-5). The migrations are database-portable because their application
objects use unqualified `app.*` names.

The production web application uses the separate service user
`ROASTPILOT_WEB_PROD`, with its own key-pair and the `PUBLIC_WEB` role
(D-C7-6). Do not reuse the Preview or DEV web credential for production.
`PUBLIC_WEB` is an account-level role, so its object grants must be checked
carefully after every production deployment.

For the first production deployment, `ACCOUNTADMIN` directly enables
`ROASTPILOT_ADMIN` to create the schema by granting it `USAGE` and
`CREATE SCHEMA` on `ROASTPILOT` (D-C7-7). The deployment then uses the existing
`roastpilot` key-pair connection as `ROASTPILOT_ADMIN`. A dedicated production
CI role and CI-gated deployment automation are deferred to a later hardening
story.

## P1: deploy the Snowflake schema

Run these steps in order. The first and third require the operator's
`ACCOUNTADMIN` access. The middle step runs through the existing
`roastpilot` connection as `ROASTPILOT_ADMIN`.

### P1 precondition: provision the production database

The `ROASTPILOT` database must exist before P1a. As `ACCOUNTADMIN`, verify it
and create it only if it is absent:

```sql
USE ROLE ACCOUNTADMIN;
SHOW DATABASES LIKE 'ROASTPILOT';
CREATE DATABASE IF NOT EXISTS ROASTPILOT;
```

P1a's database grant fails if `ROASTPILOT` does not exist.

### P1a: enable the deployment role

As `ACCOUNTADMIN`, grant the interim deployment role only the database
privileges required for the schema deployment:

```sql
USE ROLE ACCOUNTADMIN;
GRANT USAGE, CREATE SCHEMA ON DATABASE ROASTPILOT TO ROLE ROASTPILOT_ADMIN;
```

### P1b: apply the migrations

Before using the deployment credential, check out the reviewed release commit
from `main` and verify that the working tree is clean and `HEAD` matches
`origin/main`. From the repository root, run:

```bash
git fetch origin
git switch --detach origin/main
git status --short
git status --ignored --short snowflake/migrations/
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

Both status commands must produce no output and the final comparison must
succeed. The ignored-files check ensures that `snowflake/migrations/` contains
only reviewed tracked files. Schemachange runs every migration SQL file it
finds, including an ignored or untracked file left behind by a branch switch.
Confirm that `origin/main` is the reviewed release commit and stop if any check
fails. The deployment command applies the migration files in the current
checkout, so an old branch or an uncommitted edit would execute unreviewed DDL
as `ROASTPILOT_ADMIN`.

`with_connection_env.py` allows ambient `SNOWFLAKE_*` variables to override
the selected connection. Before deploying, remove stray identity overrides and
confirm that none remain:

```bash
unset SNOWFLAKE_ROLE SNOWFLAKE_ACCOUNT SNOWFLAKE_WAREHOUSE SNOWFLAKE_USER
env | grep -E '^SNOWFLAKE_(ROLE|ACCOUNT|WAREHOUSE|USER)='
```

The final command must produce no output. Alternatively, set every variable
explicitly to the intended account, user, warehouse and
`SNOWFLAKE_ROLE=ROASTPILOT_ADMIN`. The effective deployment identity must be
the `roastpilot` connection as `ROASTPILOT_ADMIN`, not an ambient shell
override.

Then, from `snowflake/`, with its Python virtual environment active, run:

```bash
SCHEMACHANGE_CONNECTION_NAME=roastpilot SNOWFLAKE_DATABASE=ROASTPILOT \
  python3 with_connection_env.py schemachange deploy --schemachange-create-change-history-table
```

The validated first deployment applied 11 scripts. It created the `APP` and
`METADATA` schemas, the application tables and procedures, both secure views,
and the object grants contained in the migrations. Schemachange records its
history in `ROASTPILOT.METADATA.CHANGE_HISTORY`.

Schema changes are forward-only. Snowflake can auto-commit earlier DDL in a
multi-statement migration before a later statement fails. Schemachange does not
then mark that migration complete, so the next deployment re-runs the failed
migration before it can reach any later corrective migration.

The failed migration itself must therefore be replayable before deployment
resumes. Make it replayable through a reviewed repository change merged to
`main`. This may use idempotent DDL, such as `CREATE ... IF NOT EXISTS` or
`CREATE OR REPLACE`, or a schemachange-managed corrective step that runs as
part of the replay. Then check out the reviewed `main` commit and re-run the
deployment. A later migration alone cannot repair a deployment wedged on an
earlier partial migration.

Use new corrective schemachange migrations from `main` for subsequent schema
evolution. Removing partially created production objects by hand is not
permitted. Never use an ad-hoc `ALTER` or a manual reversal as a substitute for
a migration. Recovery and schema evolution must remain reproducible from the
reviewed repository checkout under the schemachange-only rule.

### P1c: grant the deliberately omitted prerequisites

The migrations deliberately omit the containing database and schema `USAGE`
grants. As `ACCOUNTADMIN`, grant those prerequisites to the two application
roles:

```sql
USE ROLE ACCOUNTADMIN;
GRANT USAGE ON DATABASE ROASTPILOT     TO ROLE PUBLIC_WEB;
GRANT USAGE ON SCHEMA ROASTPILOT.APP  TO ROLE PUBLIC_WEB;
GRANT USAGE ON DATABASE ROASTPILOT     TO ROLE ROASTPILOT_AGENT;
GRANT USAGE ON SCHEMA ROASTPILOT.APP  TO ROLE ROASTPILOT_AGENT;
```

Both roles already have `USAGE` on the shared `ROASTPILOT_WH` warehouse. Do
not broaden these grants and never grant them to `PUBLIC`.

## Verify the production grant boundary

After P1, inspect the account-level role and filter the result to production
objects:

```sql
SHOW GRANTS TO ROLE PUBLIC_WEB;
SHOW FUTURE GRANTS TO ROLE PUBLIC_WEB;
SHOW GRANTS TO ROLE PUBLIC;
SHOW FUTURE GRANTS TO ROLE PUBLIC;
```

`SHOW FUTURE GRANTS TO ROLE PUBLIC_WEB` must return no rows. A future grant on
this shared account-level role could make a later-created base table readable,
even when the current-grants query is clean. An empty result is part of the
grant-boundary invariant.

Filter both `PUBLIC` results to `ROASTPILOT` and the objects owned by this
project. Neither query may contain a grant that reaches an object we own. This
enforces the invariant that nothing we own is granted to `PUBLIC`, including
through future grants.

The production surface for `PUBLIC_WEB` must be exactly:

| Privilege | Object |
| --- | --- |
| `USAGE` | database `ROASTPILOT` |
| `USAGE` | schema `ROASTPILOT.APP` |
| `USAGE` | warehouse `ROASTPILOT_WH` |
| `SELECT` | secure view `ROASTPILOT.APP.ROAST_BY_SLUG` |
| `SELECT` | secure view `ROASTPILOT.APP.REVIEWS_BY_ROAST` |
| `USAGE` | procedure `ROASTPILOT.APP.SUBMIT_REVIEW` |

There must be no access to a base table, no access to another procedure, and
no grant to `PUBLIC`. Grants do not prove that the secure-view definitions have
not drifted. As an operator role that can inspect both views, run:

```sql
SELECT GET_DDL('VIEW', 'ROASTPILOT.APP.ROAST_BY_SLUG');
SELECT GET_DDL('VIEW', 'ROASTPILOT.APP.REVIEWS_BY_ROAST');
```

Confirm that each live definition still enforces `visibility <> 'private'`.
An unchanged repeatable migration is not reapplied merely because a deployed
view was replaced or altered, so this live check is part of the boundary
verification. An equivalent negative check as `PUBLIC_WEB`, proving that a
known private roast is absent from both views, is also acceptable.

After first-time P2 provisioning, and during each later boundary audit, verify
the production web user as `ACCOUNTADMIN`:

```sql
USE ROLE ACCOUNTADMIN;
SHOW USERS LIKE 'ROASTPILOT_WEB_PROD';
```

Confirm that the `default_secondary_roles` column is empty, representing
`DEFAULT_SECONDARY_ROLES = ()`. Pinning the primary role in application code
does not prevent secondary-role inheritance from broadening the session.

## P2: provision the production web credential for the first deployment

Generate a production-only, unencrypted PKCS8 key-pair in a secure operator
environment:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out roastpilot_web_prod_key.p8 -nocrypt
openssl rsa -in roastpilot_web_prod_key.p8 -pubout -out roastpilot_web_prod_key.pub
```

The value supplied as `RSA_PUBLIC_KEY` is the public key's single-line base64
body, without the PEM header, footer or newlines. As `ACCOUNTADMIN`, create the
service user and grant it only `PUBLIC_WEB`:

```sql
USE ROLE ACCOUNTADMIN;
CREATE USER ROASTPILOT_WEB_PROD
  TYPE = SERVICE
  DEFAULT_ROLE = PUBLIC_WEB
  DEFAULT_SECONDARY_ROLES = ()
  DEFAULT_WAREHOUSE = ROASTPILOT_WH
  RSA_PUBLIC_KEY = '<single-line public key body>'
  COMMENT = 'prod public web app; PUBLIC_WEB only (D-C7-6)';
GRANT ROLE PUBLIC_WEB TO USER ROASTPILOT_WEB_PROD;
```

Do not put the private key in SQL, an issue, a pull request, chat or logs.
This `CREATE USER` step is first-time provisioning and is not idempotent. On a
subsequent deployment, verify the existing `ROASTPILOT_WEB_PROD` service
principal and its `PUBLIC_WEB` role grant instead of trying to create it again.
Rotate its key only when a key rotation is deliberately planned. Do not run
`CREATE USER` during an ordinary redeployment.

## P3: configure the Vercel Production environment

Set these `SNOWFLAKE_WEB_*` variables at Vercel's Production scope:

| Variable | Production value |
| --- | --- |
| `SNOWFLAKE_WEB_ACCOUNT` | the production Snowflake account identifier |
| `SNOWFLAKE_WEB_USER` | `ROASTPILOT_WEB_PROD` |
| `SNOWFLAKE_WEB_PRIVATE_KEY` | contents of `roastpilot_web_prod_key.p8` |
| `SNOWFLAKE_WEB_WAREHOUSE` | `ROASTPILOT_WH` |
| `SNOWFLAKE_WEB_DATABASE` | `ROASTPILOT` |
| `SNOWFLAKE_WEB_SCHEMA` | `APP` |
| `SNOWFLAKE_WEB_PRIVATE_KEY_PASSPHRASE` | set only when the private key is encrypted |

P2 creates an unencrypted key with `-nocrypt`, so omit
`SNOWFLAKE_WEB_PRIVATE_KEY_PASSPHRASE` for that key. Add the private key from
the operator's terminal so that it does not transit chat or logs:

```bash
vercel env add SNOWFLAKE_WEB_PRIVATE_KEY production < roastpilot_web_prod_key.p8
```

After confirming the upload, store the private key in the operator's approved
secrets manager or credential escrow, then remove the plaintext
`roastpilot_web_prod_key.p8` file from the working directory. It is a long-lived,
unencrypted production credential and must not remain on disk there.

The production write path also requires these variables alongside the
`SNOWFLAKE_WEB_*` variables:

| Variable | Production source |
| --- | --- |
| `KV_REST_API_URL` | Upstash Redis Marketplace integration |
| `KV_REST_API_TOKEN` | Upstash Redis Marketplace integration |
| `REVIEW_IP_HASH_PEPPER` | operator-set Production secret |

The Upstash integration provisions `KV_REST_API_URL` and
`KV_REST_API_TOKEN`, which are present at all scopes. Set
`REVIEW_IP_HASH_PEPPER` specifically at Production scope, for example by
generating a value with `openssl rand -hex 32`. All three variables must exist
at Production scope. Without them, the IP hash cannot be computed or the rate
limiter fails closed after BotID, so genuine reviews cannot be accepted.

Redeploy Production after changing environment variables. Existing deployments
do not acquire changed variables automatically.

### Releases and rollback

After the Production variables are set, create a Production-targeted build with
`vercel deploy --prod`. Never promote a Preview deployment to Production. A
Preview deployment carries Preview-scoped environment variables, including
the DEV Snowflake credential and `ROASTPILOT_DEV`, so promotion would violate
the production separation required by D-C7-5.

An application rollback does not roll back Snowflake, whose schema remains
forward-only. Before rolling back, confirm that the target application is
compatible with the current production schema, including secure-view
projections and procedure contracts. If it is not compatible, roll forward
with a corrected application deployment or a reviewed forward schema
correction.

For a compatible target, run `vercel rollback` to a previous good Production
deployment, or use `vercel ls` to identify and promote only a deployment that
was built for Production with Production-scoped variables. Never roll back or
promote from a Preview deployment. After every release or rollback, re-verify
BotID and the SSG read path before treating Production as healthy.

## P4: provide production roast data

The synthetic seed toolkit deliberately refuses production targets.
`scripts/seed/prod-guard.ts` limits `ALLOWED_SEED_DATABASES` to
`ROASTPILOT_PREVIEW` and `ROASTPILOT_DEV`. Do not bypass or widen that guard.
The preferred path for every production roast is the validated procedure path:
the real agent uses `UPSERT_ROAST` and `LOAD_ROAST_TELEMETRY`. `UPSERT_ROAST`
validates the payload and applies the idempotent `MERGE` that a direct table
write would bypass.

If a one-off demonstration roast is required before the agent path is
available, a direct owner insert as `ROASTPILOT_ADMIN` is an explicit exception.
It may copy only a non-PII roast and telemetry rows that already satisfy every
range, enum and visibility rule, such as an existing validated roast. Assign a
fresh UUID to the copied `cloud_roasts.id`, then rewrite every copied
`roast_telemetry.roast_id` to that new UUID. Also assign a fresh slug and
idempotency key. The slug must be a freshly generated, route-valid Base58 value
that meets the entropy floor. An arbitrary label such as `demo-roast-1` fails
route validation and returns 404. Reusing the source ID is unsafe because
Snowflake does not enforce the documented primary key and
`DATA_QUALITY_VIOLATIONS` does not detect duplicate roast IDs. A duplicate can
make joins ambiguous and break `DELETE_ROAST`.

Use only a source roast that already has `contributed_to_learning = true`, copy
that value unchanged, and never override an opted-out roast's consent. If no
opted-in source exists, do not fabricate consent or copy its telemetry.

Snowflake does not enforce the documented range and enum constraints, so the
operator is responsible for pre-validating every copied value when bypassing
the procedure guards. A direct insert also bypasses the calls to
`RECOMPUTE_REFERENCE_SUMMARY` made by `UPSERT_ROAST` and
`LOAD_ROAST_TELEMETRY`. After all copied roast and telemetry rows are complete,
run:

```sql
CALL ROASTPILOT.APP.RECOMPUTE_REFERENCE_SUMMARY(<bean_origin>, <roast_level>);
```

This refreshes `REFERENCE_ROAST_SUMMARIES` for the copied roast's bean-origin
and roast-level group. The validated procedure path remains preferred. Treat a
direct insert as an exceptional production data operation, not as a seed-tool
invocation or the normal ingest path.

## P5: verify the live deployment

First, as `ROASTPILOT_ADMIN`, run the owner-only data-quality check:

```sql
SELECT count(*) FROM ROASTPILOT.APP.DATA_QUALITY_VIOLATIONS;
```

The query must return 0. `DATA_QUALITY_VIOLATIONS` is deliberately not granted
to `PUBLIC_WEB`, so this is an operator check rather than a public-URL check.

Then verify all of the following against the public production URL:

- A read for a known production slug returns 200 when production has a roast.
  The slug must belong to a roast whose visibility is `unlisted` or `public`.
  A `private` roast is correctly filtered by `ROAST_BY_SLUG` and returns 404.
- For the unknown-slug probe, query a freshly generated, route-valid Base58
  slug that meets the entropy floor and has never been requested before. It
  must return the graceful 404 page, never 500.
- A scripted review write that reaches BotID is rejected with 403.
- A genuine browser submission for the same non-private roast used in the 200
  read check passes BotID and completes successfully.

Use a route-valid Base58 slug, JSON content type, a parseable JSON body, and an
empty or absent `website` honeypot field for the scripted BotID probe. This
concrete request reaches BotID:

```bash
curl -i -X POST \
  'https://roastpilot-cloud.vercel.app/api/r/23456789ABCDEFGHJK/reviews' \
  -H 'Content-Type: application/json' \
  --data '{"score":5,"website":""}'
```

It must return 403. A bad slug returns 404, a missing JSON content type returns
415, malformed JSON returns 400, and a filled `website` field returns the
honeypot's 200 response. All of those outcomes occur before BotID and therefore
do not verify its scripted-write denial.

A placeholder such as `missing` can fail route validation before Snowflake is
queried. A previously requested valid slug can return a cached null for five
minutes. Using a fresh, route-valid slug ensures that the 404 performs the
production query and therefore proves that Vercel can authenticate with the
production key-pair, use the `PUBLIC_WEB` grants and reach Snowflake. The
browser submission verifies the positive write path; the scripted POST
verifies the fail-closed edge gate.

## Ownership summary

| Step | Owner and identity |
| --- | --- |
| P1 precondition, provision the production database if absent | Operator as `ACCOUNTADMIN` |
| P1a, grant database deployment privileges | Operator as `ACCOUNTADMIN` |
| P1b, run schemachange | `roastpilot` key-pair connection as `ROASTPILOT_ADMIN` |
| P1c, grant database and schema prerequisites | Operator as `ACCOUNTADMIN` |
| P1 boundary and web-user verification | Operator as `ACCOUNTADMIN` |
| P2, create and authorize the service user | Operator as `ACCOUNTADMIN` |
| P3, set Vercel Production variables and redeploy | Orchestrator and operator, with the operator supplying the private key at the CLI |
| P4, optional one-off production data operation | Operator through `ROASTPILOT_ADMIN` |
| P5, owner-only data-quality check | Operator through `ROASTPILOT_ADMIN` |
| P5, public URL and browser verification | Orchestrator |

The `roastpilot` connection can deploy database-portable migrations and carry
out the deliberate data operation through `ROASTPILOT_ADMIN`. It cannot
replace the `ACCOUNTADMIN` steps that establish database access, prerequisite
role grants or the service user.
