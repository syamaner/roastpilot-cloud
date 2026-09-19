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
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

`git status --short` must produce no output and the final comparison must
succeed. Confirm that `origin/main` is the reviewed release commit and stop if
either check fails. The deployment command applies the migration files in the
current checkout, so an old branch or an uncommitted edit would execute
unreviewed DDL as `ROASTPILOT_ADMIN`.

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
resumes. Its DDL may already be idempotent, using forms such as
`CREATE ... IF NOT EXISTS` or `CREATE OR REPLACE`, so that re-running it
succeeds. Otherwise, the operator must first remove only the partially created
objects, then re-run the same reviewed migration. Review and record that
cleanup as recovery from the failed deployment. A later corrective migration
alone cannot repair a deployment wedged on an earlier partial migration.

Use new corrective schemachange migrations from `main` for subsequent schema
evolution. Never use an ad-hoc `ALTER` or a manual reversal as a substitute for
a migration. This keeps schema evolution in the repository and follows the
schemachange-only rule.

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
```

`SHOW FUTURE GRANTS TO ROLE PUBLIC_WEB` must return no rows. A future grant on
this shared account-level role could make a later-created base table readable,
even when the current-grants query is clean. An empty result is part of the
grant-boundary invariant.

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

## P2: create the production web credential

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
  DEFAULT_WAREHOUSE = ROASTPILOT_WH
  RSA_PUBLIC_KEY = '<single-line public key body>'
  COMMENT = 'prod public web app; PUBLIC_WEB only (D-C7-6)';
GRANT ROLE PUBLIC_WEB TO USER ROASTPILOT_WEB_PROD;
```

Do not put the private key in SQL, an issue, a pull request, chat or logs.

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

To roll back, run `vercel rollback` to a previous good Production deployment,
or use `vercel ls` to identify and promote only a deployment that was built for
Production with Production-scoped variables. Never roll back or promote from a
Preview deployment. After every release or rollback, re-verify BotID and the
SSG read path before treating Production as healthy.

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
fresh slug and idempotency key. Use only a source roast that already has
`contributed_to_learning = true`, copy that value unchanged, and never override
an opted-out roast's consent. If no opted-in source exists, do not fabricate
consent or copy its telemetry.

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
  For the unknown-slug probe, query a freshly generated, route-valid Base58
  slug that meets the entropy floor and has never been requested before. It
  must return the graceful 404 page, never 500.
- A scripted review write is rejected by BotID. A `curl` POST returns 403.
- A genuine browser submission passes BotID and completes successfully.

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
| P1a, grant database deployment privileges | Operator as `ACCOUNTADMIN` |
| P1b, run schemachange | `roastpilot` key-pair connection as `ROASTPILOT_ADMIN` |
| P1c, grant database and schema prerequisites | Operator as `ACCOUNTADMIN` |
| P1 boundary verification | Operator with account grant visibility |
| P2, create and authorize the service user | Operator as `ACCOUNTADMIN` |
| P3, set Vercel Production variables and redeploy | Orchestrator and operator, with the operator supplying the private key at the CLI |
| P4, optional one-off production data operation | Operator through `ROASTPILOT_ADMIN` |
| P5, owner-only data-quality check | Operator through `ROASTPILOT_ADMIN` |
| P5, public URL and browser verification | Orchestrator |

The `roastpilot` connection can deploy database-portable migrations and carry
out the deliberate data operation through `ROASTPILOT_ADMIN`. It cannot
replace the `ACCOUNTADMIN` steps that establish database access, prerequisite
role grants or the service user.
