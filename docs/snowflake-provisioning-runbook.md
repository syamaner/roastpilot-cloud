# Snowflake account-role provisioning runbook

Account-scoped DDL is operator-run provisioning: an operator runs it once as
`ACCOUNTADMIN`, while migrations only grant to and use existing roles within a
database and never contain account-scoped DDL. This is D106 in
[`factory.md`](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/factory.md),
and preserves the grant boundaries in [`AGENTS.md`](../AGENTS.md). The live
audit rejects account-level grants, any `PUBLIC` grant reaching our objects,
and off-manifest app-role grants within `ROASTPILOT_DEV` (`PUBLIC_WEB`
additionally cross-environment). `ROASTPILOT_AGENT` grants outside
`ROASTPILOT_DEV` are not audited until #358 lands. The exact migration set is
separately closed by `check_grant_manifest.py`. A missing DEV-side prerequisite
the gate audits (the CI role boundary; the two app roles' `ROASTPILOT_DEV` manifests, including their database/schema/warehouse `USAGE`; the two-layer `PUBLIC` invariant; and the CI user's
`DEFAULT_SECONDARY_ROLES = ()`) appears as a live-gate failure, never as something a migration can paper over. The steps the gate does not audit (the resource monitor, the
`ROASTPILOT_PREVIEW` and `ROASTPILOT` databases, the preview user, and the role-to-`SYSADMIN` assignments) are verified only by the recipe in this runbook. This separation is D-317-D and
D-317-E (#317).

> **Provenance, 26 August 2026.** This record was reconstructed from read-only
> `SHOW` output through the `roastpilot` connection, using role
> `ROASTPILOT_ADMIN`. The original DDL text was not preserved. Every statement
> below is an equivalent reconstruction, not the literal original. Objects
> outside that role's visibility are marked **verify as ACCOUNTADMIN**.

The plan sources are [`plan.md` §3](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/plan.md#3-architecture)
for access control, [`plan.md` §8](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/plan.md#8-privacy--deletion)
for deletion recoverability, and `plan.md` §14 item 9 for key rotation. Connection and live-gate conventions are in [`snowflake/README.md`](../snowflake/README.md).
Live facts below come only from the dated inventory captured with this runbook.

## Account-level inventory

| Object | Type | Created | Owner / hierarchy | Provisioning story or decision | Visibility status |
|---|---|---|---|---|---|
| `ROASTPILOT_ADMIN` | role | 17 Jul 2026 | `ACCOUNTADMIN`; assigned only to `ROASTPILOT_CLI`, not below `SYSADMIN` | C1-S2 #2 | Verified |
| `ROASTPILOT_DEV_CI_ROLE` | role | 18 Jul 2026 | `ACCOUNTADMIN`; granted to `SYSADMIN` and `ROASTPILOT_DEV_CI` | F1-S8 #11 | Verified |
| `ROASTPILOT_PREVIEW_ROLE` | role | 18 Jul 2026 | `ACCOUNTADMIN`; granted to `SYSADMIN` and `ROASTPILOT_PREVIEW_APP` | F1-S8 #11 | Verified; no grants visible |
| `ROASTPILOT_AGENT` | role | 19 Jul 2026 | `ACCOUNTADMIN`; granted to `SYSADMIN`; no user yet | D106 | Verified |
| `PUBLIC_WEB` | role | 19 Jul 2026 | `ACCOUNTADMIN`; granted to `SYSADMIN`; no user yet | D106 | Verified |
| `SY` | user | 16 Jul 2026 | Human account owner | Account creation, D99 | Verified |
| `ROASTPILOT_CLI` | user | 17 Jul 2026 | Default role `ROASTPILOT_ADMIN`; default warehouse `ROASTPILOT_WH` | C1-S2 #2 | Verified; operator user |
| `ROASTPILOT_DEV_CI` | user | 18 Jul 2026 | Assigned role `ROASTPILOT_DEV_CI_ROLE` | F1-S8 #11 | Exists; key and secondary-role details verify as ACCOUNTADMIN |
| `ROASTPILOT_PREVIEW_APP` | user | 18 Jul 2026 | Assigned role `ROASTPILOT_PREVIEW_ROLE` | F1-S8 #11 | Exists; details verify as ACCOUNTADMIN |
| `ROASTPILOT_DEV` | database | 17 Jul 2026 | `ROASTPILOT_ADMIN` | C1-S2 #2 | Verified; retention 1 day |
| `ROASTPILOT` | database | 19 Jul 2026 per D106 | Owner unknown | D106 | Not visible, verify as ACCOUNTADMIN |
| `ROASTPILOT_PREVIEW` | database | Date not visible | Owner unknown | Preview provisioning recorded by D106 | Not visible, verify as ACCOUNTADMIN |
| `ROASTPILOT_WH` | warehouse | 17 Jul 2026 | `ACCOUNTADMIN`; X-Small, auto-suspend 60 seconds | C1-S2 #2 and D106 | Verified |
| `DEV_CI_WH` | warehouse | 18 Jul 2026 per F1-S8 | Owner and settings not visible | F1-S8 #11 | Not visible, verify as ACCOUNTADMIN |
| `ROASTPILOT_MONITOR` | resource monitor | 19 Jul 2026 per D106 | Account-level; intended for `ROASTPILOT_WH` | D106 | Not visible, verify as ACCOUNTADMIN |

## Equivalent reconstructed DDL

These blocks describe the recorded end state. Verify live state before reusing
any statement. The `REVOKE` statements, `ALTER WAREHOUSE ... SET
RESOURCE_MONITOR` and `ALTER USER ... SET DEFAULT_SECONDARY_ROLES` change live
state, as do the `CREATE` and `GRANT` statements.

### 17 July 2026, C1-S2 #2

Run as: `ACCOUNTADMIN`, switching to `ROASTPILOT_ADMIN` where shown.

```sql
USE ROLE ACCOUNTADMIN;
CREATE ROLE ROASTPILOT_ADMIN;
USE ROLE SYSADMIN;
GRANT CREATE DATABASE ON ACCOUNT TO ROLE ROASTPILOT_ADMIN;
USE ROLE USERADMIN;
GRANT CREATE ROLE ON ACCOUNT TO ROLE ROASTPILOT_ADMIN;
GRANT CREATE USER ON ACCOUNT TO ROLE ROASTPILOT_ADMIN;
USE ROLE ACCOUNTADMIN;
CREATE WAREHOUSE ROASTPILOT_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60;
GRANT USAGE, OPERATE ON WAREHOUSE ROASTPILOT_WH TO ROLE ROASTPILOT_ADMIN;
CREATE USER ROASTPILOT_CLI RSA_PUBLIC_KEY = '<RSA_PUBLIC_KEY>'
  DEFAULT_ROLE = ROASTPILOT_ADMIN DEFAULT_WAREHOUSE = ROASTPILOT_WH;
GRANT ROLE ROASTPILOT_ADMIN TO USER ROASTPILOT_CLI;
USE ROLE ROASTPILOT_ADMIN;
CREATE DATABASE ROASTPILOT_DEV COMMENT = 'M2 C1-S2 dev/contract-test database (plan §10)';
CREATE SCHEMA ROASTPILOT_DEV.APP;
CREATE SCHEMA ROASTPILOT_DEV.METADATA;
```

`ROASTPILOT_DEV.PUBLIC` is created automatically with the database. The verified
owner of the database and all three schemas is `ROASTPILOT_ADMIN`.

`V1.0.0__bootstrap.sql` uses `CREATE SCHEMA IF NOT EXISTS APP`. On a fresh target it creates `APP` as the deploy role, making that role the schema owner. On `ROASTPILOT_DEV`, the operator pre-created `APP` on 17 July, before the CI role existed on 18 July, so `ROASTPILOT_ADMIN` owns the schema while the deploy role owns its objects, producing the #313 silo.

The recorded `SYSADMIN` and `USERADMIN` grantors are retained for fidelity.
Re-granting an account privilege normally needs a role that holds it with grant
option, such as `ACCOUNTADMIN` or `SECURITYADMIN`. If a re-run under the recorded
roles fails, run those three account-privilege `GRANT` statements as `ACCOUNTADMIN`.

### 18 July 2026, F1-S8 #11

Run as: `ACCOUNTADMIN`, switching to `ROASTPILOT_ADMIN` for owned-object grants.
Verify warehouse and preview-user properties as `ACCOUNTADMIN` before reuse.

```sql
USE ROLE ACCOUNTADMIN;
CREATE ROLE ROASTPILOT_DEV_CI_ROLE;
GRANT ROLE ROASTPILOT_DEV_CI_ROLE TO ROLE SYSADMIN;
CREATE WAREHOUSE DEV_CI_WH;
GRANT USAGE ON WAREHOUSE DEV_CI_WH TO ROLE ROASTPILOT_DEV_CI_ROLE;
CREATE USER ROASTPILOT_DEV_CI RSA_PUBLIC_KEY = '<RSA_PUBLIC_KEY>';
ALTER USER ROASTPILOT_DEV_CI SET DEFAULT_SECONDARY_ROLES = ();
GRANT ROLE ROASTPILOT_DEV_CI_ROLE TO USER ROASTPILOT_DEV_CI;
CREATE ROLE ROASTPILOT_PREVIEW_ROLE;
GRANT ROLE ROASTPILOT_PREVIEW_ROLE TO ROLE SYSADMIN;
CREATE USER ROASTPILOT_PREVIEW_APP;
GRANT ROLE ROASTPILOT_PREVIEW_ROLE TO USER ROASTPILOT_PREVIEW_APP;
USE ROLE ROASTPILOT_ADMIN;
GRANT USAGE, MODIFY, MONITOR, CREATE SCHEMA, CREATE DATABASE ROLE, APPLYBUDGET, EXECUTE AUTO CLASSIFICATION ON DATABASE ROASTPILOT_DEV TO ROLE ROASTPILOT_DEV_CI_ROLE;
GRANT ALL PRIVILEGES ON SCHEMA ROASTPILOT_DEV.APP TO ROLE ROASTPILOT_DEV_CI_ROLE;
GRANT ALL PRIVILEGES ON SCHEMA ROASTPILOT_DEV.METADATA TO ROLE ROASTPILOT_DEV_CI_ROLE;
GRANT ALL PRIVILEGES ON SCHEMA ROASTPILOT_DEV.PUBLIC TO ROLE ROASTPILOT_DEV_CI_ROLE;
```

The default role and warehouse for `ROASTPILOT_DEV_CI` and
`ROASTPILOT_PREVIEW_APP` are not visible to `ROASTPILOT_ADMIN` and remain
unreconstructed. The operator records the observed values in the inventory
table rather than asserting them. The only asserted user property is
`ROASTPILOT_DEV_CI.DEFAULT_SECONDARY_ROLES = ()`, verified by the live gate.

`PUBLIC` in the last schema grant is the database's auto-created `PUBLIC`
schema, not the `PUBLIC` role. No grant in this document targets the `PUBLIC` role.

The observed CI schema privilege set is the full schema privilege set (67 privileges
per schema on `APP`/`METADATA`/`PUBLIC`, consistent with `GRANT ALL PRIVILEGES ON
SCHEMA`). The 201 individual schema rows are not enumerated here.

### 19 July 2026, D106

Run as: `ACCOUNTADMIN`. Verify both databases' owners and settings, the preview
database's creation date, the resource monitor and monitor attachment as
`ACCOUNTADMIN` before reuse.

```sql
USE ROLE ACCOUNTADMIN;
CREATE ROLE ROASTPILOT_AGENT;
CREATE ROLE PUBLIC_WEB;
GRANT ROLE ROASTPILOT_AGENT TO ROLE SYSADMIN;
GRANT ROLE PUBLIC_WEB TO ROLE SYSADMIN;
CREATE DATABASE ROASTPILOT_PREVIEW;
CREATE DATABASE ROASTPILOT;
CREATE RESOURCE MONITOR ROASTPILOT_MONITOR WITH CREDIT_QUOTA = 5
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS ON 50 PERCENT DO NOTIFY ON 100 PERCENT DO SUSPEND
           ON 110 PERCENT DO SUSPEND_IMMEDIATE;
ALTER WAREHOUSE ROASTPILOT_WH SET RESOURCE_MONITOR = ROASTPILOT_MONITOR;
GRANT USAGE ON WAREHOUSE ROASTPILOT_WH TO ROLE ROASTPILOT_AGENT;
GRANT USAGE ON WAREHOUSE ROASTPILOT_WH TO ROLE PUBLIC_WEB;
```

D106 deliberately created neither application service users nor a production
deploy credential.

### 23 to 24 August 2026, D-317-D/E and D-345-C/E/F/G

Run as: `ROASTPILOT_ADMIN` for owned database and schema grants, then
`ACCOUNTADMIN` for warehouse grants and revokes.

```sql
USE ROLE ROASTPILOT_ADMIN;
GRANT USAGE ON DATABASE ROASTPILOT_DEV TO ROLE PUBLIC_WEB;
GRANT USAGE ON DATABASE ROASTPILOT_DEV TO ROLE ROASTPILOT_AGENT;
GRANT USAGE ON SCHEMA ROASTPILOT_DEV.APP TO ROLE PUBLIC_WEB;
GRANT USAGE ON SCHEMA ROASTPILOT_DEV.APP TO ROLE ROASTPILOT_AGENT;
USE ROLE ACCOUNTADMIN;
-- During #317 both app roles also acquired DEV_CI_WH USAGE;
-- the exact GRANT statements are unreconstructed.
-- D-345-C (mistaken drift reading, reversed by D-345-E)
REVOKE USAGE ON WAREHOUSE ROASTPILOT_WH FROM ROLE PUBLIC_WEB;
REVOKE USAGE ON WAREHOUSE ROASTPILOT_WH FROM ROLE ROASTPILOT_AGENT;
GRANT USAGE ON WAREHOUSE ROASTPILOT_WH TO ROLE PUBLIC_WEB;
GRANT USAGE ON WAREHOUSE ROASTPILOT_WH TO ROLE ROASTPILOT_AGENT;
REVOKE USAGE ON WAREHOUSE DEV_CI_WH FROM ROLE PUBLIC_WEB;
REVOKE USAGE ON WAREHOUSE DEV_CI_WH FROM ROLE ROASTPILOT_AGENT;
```

D106 deliberately granted both app roles `ROASTPILOT_WH` as their shared
warehouse. During the #317 arc they also acquired `DEV_CI_WH` usage, but the
exact grant statements are unreconstructed. On 24 August D-345-C revoked the
shared warehouse on a mistaken drift reading. D-345-E re-granted it the same
day, then removed `DEV_CI_WH` as cleanup because that warehouse belongs to the
CI role and is never an application-role prerequisite. `assert_dev_ci_grants.py`
enforces `_ALLOWED_APP_ROLE_WAREHOUSES = {"ROASTPILOT_WH"}`: the shared
warehouse grant is required by the gate, never drift.

### 26 August 2026, #356 one-off operator access

Run as: `ACCOUNTADMIN`. These DEV-only grants target the non-audited operator
role. They are harmless to the app-role manifests but revocable.

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ROASTPILOT_DEV.APP TO ROLE ROASTPILOT_ADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA ROASTPILOT_DEV.APP TO ROLE ROASTPILOT_ADMIN;
GRANT USAGE ON ALL PROCEDURES IN SCHEMA ROASTPILOT_DEV.APP TO ROLE ROASTPILOT_ADMIN;

-- Matching rollback recipe:
REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ROASTPILOT_DEV.APP FROM ROLE ROASTPILOT_ADMIN;
REVOKE SELECT ON ALL VIEWS IN SCHEMA ROASTPILOT_DEV.APP FROM ROLE ROASTPILOT_ADMIN;
REVOKE USAGE ON ALL PROCEDURES IN SCHEMA ROASTPILOT_DEV.APP FROM ROLE ROASTPILOT_ADMIN;
```

Revoking re-creates the #313 silo for operator-run loaders: `ROASTPILOT_ADMIN`
owns the schema, while `ROASTPILOT_DEV_CI_ROLE` owns deployed objects.
Because `ROASTPILOT_ADMIN` is outside the live audit's role set, which covers
only the CI role, `PUBLIC`, `PUBLIC_WEB`, `ROASTPILOT_AGENT` and allowlisted
Snowflake defaults, the audit will not notice these grants. The `SHOW GRANTS TO
ROLE ROASTPILOT_ADMIN` check in the verification recipe notices whether they
were left in place.

## What the migration owns vs what the operator owns

| Owner | Exact grant surface |
|---|---|
| Migration, `R__z_roles_grants.sql` | `PUBLIC_WEB`: `SELECT` on `APP.ROAST_BY_SLUG`, `SELECT` on `APP.REVIEWS_BY_ROAST`, and `USAGE` on `APP.SUBMIT_REVIEW(...)` |
| Migration, `R__z_roles_grants.sql` | `ROASTPILOT_AGENT`: `SELECT, INSERT, UPDATE, DELETE` on each of five tables, `CLOUD_ROASTS`, `ROAST_TELEMETRY`, `ROAST_ARTIFACTS`, `TASTING_REVIEWS` and `REFERENCE_ROAST_SUMMARIES` |
| Migration, `R__z_roles_grants.sql` | `ROASTPILOT_AGENT`: `READ, WRITE` on stage `APP.ROAST_ARTIFACTS` |
| Operator, this runbook | Role and user creation, role hierarchy and assignment, databases, schemas, warehouses, resource monitor, database/schema/warehouse prerequisite `USAGE`, CI provisioning privileges, secondary-role settings, and the #356 one-off grants |

These are nine object-level grant statements: two view grants, one procedure
grant, five table grants and one stage grant. The closed manifest permits only
the two app roles. `ROASTPILOT_AGENT` holds no procedure `USAGE`, per D-317-A.
The C3 procedure grant will be migration-owned because the deploy role owns it.
It also requires editing the closed exact set in
`snowflake/check_grant_manifest.py`, which feeds the live app-role manifest in
`assert_dev_ci_grants.py`, or both gates go red.

## Verification recipe

Run the first block through the normal `roastpilot` connection. It is read-only.

```sql
SHOW ROLES;
SHOW USERS;
SHOW DATABASES;
SHOW WAREHOUSES;
SHOW GRANTS ON DATABASE ROASTPILOT_DEV;
SHOW GRANTS ON SCHEMA ROASTPILOT_DEV.APP;
SHOW GRANTS TO ROLE PUBLIC_WEB;
SHOW GRANTS TO ROLE ROASTPILOT_AGENT;
SHOW GRANTS TO ROLE ROASTPILOT_DEV_CI_ROLE;
SHOW GRANTS TO USER ROASTPILOT_DEV_CI;
SHOW GRANTS TO ROLE ROASTPILOT_PREVIEW_ROLE;
SHOW GRANTS TO USER ROASTPILOT_PREVIEW_APP;
SHOW GRANTS TO ROLE ROASTPILOT_ADMIN;
SHOW GRANTS OF ROLE PUBLIC_WEB;
SHOW GRANTS OF ROLE ROASTPILOT_AGENT;
SHOW GRANTS OF ROLE ROASTPILOT_DEV_CI_ROLE;
SHOW GRANTS OF ROLE ROASTPILOT_PREVIEW_ROLE;
SHOW GRANTS OF ROLE ROASTPILOT_ADMIN;
SHOW FUTURE GRANTS TO ROLE ROASTPILOT_PREVIEW_ROLE;
SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN DATABASE ROASTPILOT_DEV;
```

Expected visible results are the five project roles, four users,
`ROASTPILOT_DEV`, `ROASTPILOT_WH`, the six-row `PUBLIC_WEB` manifest, the
`ROASTPILOT_AGENT` surface, 23 rows visible to `ROASTPILOT_ADMIN` (25 including
the two stage grants, which that role cannot see), no preview-role grants, and
retention `1`.

The preview user's grants are exactly one row, the `ROASTPILOT_PREVIEW_ROLE` role grant, with zero direct object privileges; a direct user grant would be that principal's only privilege path because its role holds no visible grants. The CI user's grants are exactly one row, the `ROASTPILOT_DEV_CI_ROLE` role grant.

Expected grantees are exactly: `PUBLIC_WEB -> ROLE SYSADMIN`; `ROASTPILOT_AGENT -> ROLE SYSADMIN`; `ROASTPILOT_DEV_CI_ROLE -> USER ROASTPILOT_DEV_CI + ROLE SYSADMIN`; `ROASTPILOT_PREVIEW_ROLE -> USER ROASTPILOT_PREVIEW_APP + ROLE SYSADMIN`; and `ROASTPILOT_ADMIN -> USER ROASTPILOT_CLI`. Any other grantee is a finding. The preview role's future-grant query must return no rows; it is outside the live gate's future-grant queries, so this recipe is its only check.

While the #356 access remains, the `ROASTPILOT_ADMIN` result contains 26 object-privilege rows on deployed `APP` objects: 20 table DML, three view `SELECT` and three procedure `USAGE` rows.
After rollback, expect zero `SELECT`/`INSERT`/`UPDATE`/`DELETE` rows on `APP` tables, zero `SELECT` rows on `APP` views and zero `USAGE` rows on `APP` procedures. `OWNERSHIP` rows for the
database, its three schemas and `METADATA.CHANGE_HISTORY` remain because `ROASTPILOT_ADMIN` owns those containers and the history table, not the deployed `APP` objects.

Run this second block as `ACCOUNTADMIN` for the invisible items.

```sql
SHOW DATABASES LIKE 'ROASTPILOT';
SHOW DATABASES LIKE 'ROASTPILOT_PREVIEW';
SHOW RESOURCE MONITORS;
SHOW WAREHOUSES LIKE 'ROASTPILOT_WH';
SHOW WAREHOUSES LIKE 'DEV_CI_WH';
SHOW GRANTS ON WAREHOUSE DEV_CI_WH;
SHOW GRANTS TO ROLE ROASTPILOT_DEV_CI_ROLE;
SHOW USERS LIKE 'ROASTPILOT_DEV_CI';
SHOW USERS LIKE 'ROASTPILOT_PREVIEW_APP';
```

Snowflake `SHOW ... LIKE` treats `_` as a single-character wildcard. Escape
syntax has not been verified in a live session, so these patterns remain
unescaped. A returned row counts as confirmation only when its `name` is a
byte-exact match for the requested literal, matching the `identifiers_match`
rule in `assert_dev_ci_grants.py`.

Expected rows, subject to verification, are both databases, the monitor with
its 5-credit quota and 50/100/110 triggers, its attachment in the
`ROASTPILOT_WH` output's `resource_monitor` column, `DEV_CI_WH` with CI-role
`USAGE`, both users for inventory recording, and the CI user with a key and no
secondary roles. The users' default roles and warehouses remain unreconstructed.

Mechanically, dispatch `.github/workflows/dev-snowflake-contract.yml` and obtain
approval for its `dev-snowflake-ci` Environment. It checks the CI boundary, both
app-role manifests, the D-11-B..E (#11) two-layer `PUBLIC` invariant, and the CI
user's empty secondary roles. Within the boundaries stated in the opening
paragraph (account-level grants, `PUBLIC` grants reaching our objects, and
off-manifest app-role grants within `ROASTPILOT_DEV`, with `PUBLIC_WEB`
additionally cross-environment), rejecting those grants is intended;
`ROASTPILOT_AGENT` grants outside `ROASTPILOT_DEV` stay unaudited until #358.

## Time Travel and deletion recoverability

`DATA_RETENTION_TIME_IN_DAYS = 1` was verified on `ROASTPILOT_DEV` on 26 August
2026. Rows removed by `DELETE_ROAST` remain recoverable during that window with
Time Travel `AT` or `BEFORE` queries on affected tables, or a clone created with
`AT` or `BEFORE` pointing to a pre-deletion timestamp, offset or statement ID.
A clone without that clause captures the current, post-delete state even inside
the window. Afterwards, Fail-safe is for Snowflake's own recovery only. Staged files removed by the future #341 `REMOVE` are not covered by Time Travel.

Verify effective retention at schema and table level:

```sql
SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN SCHEMA ROASTPILOT_DEV.APP;
SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN TABLE ROASTPILOT_DEV.APP.<table>;
```

Run the table form for `CLOUD_ROASTS`, `ROAST_TELEMETRY`, `ROAST_ARTIFACTS`, `TASTING_REVIEWS` and `REFERENCE_ROAST_SUMMARIES`. Expect `1` on each with `level` empty or `DATABASE`, meaning no object-level override. A table-level `0` voids the recovery window stated here.

Deletion is therefore not instant and final. The production retention value
is a C7 decision. This follows [`plan.md` §8](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/plan.md#8-privacy--deletion),
which requires the recoverability window to be documented.

## Forward items

- C3 provisions the `ROASTPILOT_AGENT` service user and key pair.
- C4 provisions the `PUBLIC_WEB` service user and key pair.
- Both service users must use the CI user's `DEFAULT_SECONDARY_ROLES = ()` discipline.
- C7 owns zero-downtime key rotation (`plan.md` §14 item 9) and the production deploy credential.
- `ROASTPILOT_PREVIEW_ROLE` currently has no visible grants.
- Issue #358 owns the per-environment app-role audit.

## Items to confirm as ACCOUNTADMIN

- [ ] `ROASTPILOT` database, including owner and settings.
- [ ] `ROASTPILOT_PREVIEW` database, including owner and settings.
- [ ] `ROASTPILOT_MONITOR`, its thresholds and attachment to `ROASTPILOT_WH`.
- [ ] `DEV_CI_WH` and its `USAGE` grant to `ROASTPILOT_DEV_CI_ROLE`.
- [ ] `ROASTPILOT_DEV_CI` public key and `DEFAULT_SECONDARY_ROLES = ()`.
