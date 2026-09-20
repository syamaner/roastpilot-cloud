# Trial to on-demand billing cutover

This runbook covers the operator-controlled transition from Snowflake trial credits to
on-demand billing. It does not create, migrate, resize or re-provision any object.

## S0: Context and decisions

The account is already in Azure UK South on the Standard edition. C1 through C7 ran
against its 30-day trial allocation of approximately $400 in credits. Here, "cutover"
means moving billing to the On-Demand purchasing model, not Capacity, when trial credits
expire. It is not an account, region, edition or warehouse-size migration.

The existing production deployment remains the one documented in
[Production deployment](prod-deploy-runbook.md). Its service-user and key-pair
lifecycle remains governed by [Snowflake key-pair provisioning and
rotation](key-rotation.md). The cost-control boundary remains the shared
warehouse and monitor documented in [Resource monitor and shared
warehouse](resource-monitor.md).

Run the checks close to the billing change, and complete the payment-method step before
the trial credits are exhausted. Unknown billing state, identity or configuration fails
closed: stop and verify it through the named live administration surface.

## S1: Target pin

D-C7-1 pins the cutover target to all of the following:

- same region: Azure UK South / `AZURE_UKSOUTH`;
- cheapest on-demand Standard edition; and
- smallest warehouse: X-SMALL.

This means **NO region change**, **NO capacity-or-Enterprise change**, and
**NO size change**. Do not create another account or warehouse for this
cutover. The warehouse-split option in D-C7-2 was not adopted and is only a
possible future change, not a cutover action.

## S2: Confirm billing state and prevent an expiry gap

Perform these numbered steps as the operator with `ACCOUNTADMIN` access.

1. Confirm that the session is connected to the intended live account and
   that its region is `AZURE_UKSOUTH`:

   ```sql
   USE ROLE ACCOUNTADMIN;
   SELECT CURRENT_ACCOUNT();
   SELECT CURRENT_REGION();
   ```

   `CURRENT_ACCOUNT()` returns the locator, not the organisation-account identifier.
   Compare it exactly with the approved locator `[VERIFY-LIVE]`, never another form or
   partial match. Never copy an identifier here. Stop if locator or region differs.

2. In the Snowsight account selector or **Admin -> Account** view `[VERIFY-LIVE]`, require
   its locator to match step 1 and the approved locator or STOP. Confirm Standard, not
   Enterprise, as the edition and On-Demand, not Capacity, as the target purchasing model.

3. In Snowsight, open **Admin -> Cost Management -> Billing** and confirm the
   current state `[VERIFY-LIVE]`: Trial is expected; On-Demand is valid after a prior
   cutover. Record it, trial balance/expiry and payment readiness privately. Trial
   does not block this runbook; an unknown or other state means STOP.

## S3: Confirm existing cost controls

Run the C7-S3 verifier in [Resource monitor and shared warehouse](resource-monitor.md#manual-verification).
Use `ACCOUNTADMIN` or a monitor-visible role; `ROASTPILOT_CLI` and `ROASTPILOT_ADMIN` cannot.

Using its exact `<profile>`, role and overrides, have the verifier connection report
`SELECT CURRENT_ACCOUNT();` `[VERIFY-LIVE]`; require the S2 locator or STOP.

The verifier must pass with this unchanged state:

| Setting | Required value |
| --- | --- |
| `ROASTPILOT_MONITOR` credit quota | 5 |
| Frequency | MONTHLY |
| Notify trigger | includes 50% |
| Suspend trigger | 100% |
| Suspend-immediate trigger | 110% |
| `ROASTPILOT_WH` size | X-Small |
| Auto-suspend | 60 seconds |
| Auto-resume | true |
| Bound resource monitor | `ROASTPILOT_MONITOR` |
| Effective `STATEMENT_TIMEOUT_IN_SECONDS` | exactly 300 seconds |

These checks alter nothing; any identity, visibility or value failure blocks cutover.

## S4: Verify the production service-user and key-pair

`ROASTPILOT_WEB_PROD` and its key-pair already exist and are live under C7-S1/C7-S2 (#545/#546).
Billing cutover is not their creation gate; do not create, replace or rotate them here.

As `ACCOUNTADMIN`, verify the existing service user:

```sql
USE ROLE ACCOUNTADMIN;
SELECT CURRENT_ACCOUNT();
SHOW USERS LIKE 'ROASTPILOT_WEB_PROD';
```

Accept only when the S2-matched session's complete `SHOW` has exactly one row whose `name`
byte-exactly equals `ROASTPILOT_WEB_PROD`; zero/multiple/non-exact rows mean STOP, and its `default_secondary_roles` must be empty, representing `DEFAULT_SECONDARY_ROLES = ()`.

Require deployed `SNOWFLAKE_WEB_ACCOUNT` to byte-match its approved SQL-API identifier
record and prove it maps to the S2 locator `[VERIFY-LIVE]`; never compare unlike forms.

Read Vercel Production's deployed values `[VERIFY-LIVE]`; require byte-exact
`SNOWFLAKE_WEB_USER = ROASTPILOT_WEB_PROD`, `SNOWFLAKE_WEB_WAREHOUSE = ROASTPILOT_WH`, and
`SNOWFLAKE_WEB_DATABASE = ROASTPILOT`, and `SNOWFLAKE_WEB_SCHEMA = APP`, or STOP. P5 does
not identify the principal or monitored warehouse and can pass through compatible
objects in another schema. The monitor binds `ROASTPILOT_WH`; database omission defaults
to `ROASTPILOT_DEV`, and a wrong database or schema targets the wrong environment.

Before cutover, both owning-runbook gates are REQUIRED for that approved account:

- [Verify the production grant boundary](prod-deploy-runbook.md#verify-the-production-grant-boundary) must pass for the complete role set and least-privilege boundary.
- [Verify the live deployment](prod-deploy-runbook.md#p5-verify-the-live-deployment) must pass for deployed user/key identity and live 404 reachability.

If either gate did not pass against the approved account, STOP; a fresh environment uses [key-pair provisioning](key-rotation.md) separately before go-live.

## S5: Ownership summary

| Cutover step | Owner and identity |
| --- | --- |
| Confirm live account and `AZURE_UKSOUTH` region | Operator as `ACCOUNTADMIN` |
| Confirm the Snowsight browser account exactly matches the approved production locator | Operator as `ACCOUNTADMIN` |
| Confirm Standard edition; record Trial/On-Demand state and On-Demand target | Operator as `ACCOUNTADMIN` |
| Confirm trial balance, expiry and payment readiness | Operator as `ACCOUNTADMIN` |
| Prove the S3 verifier account locator, then verify `ROASTPILOT_MONITOR` and `ROASTPILOT_WH` | Operator as `ACCOUNTADMIN`, or an already-existing monitor-visible role |
| Bind the S4 SQL account, then verify exact user identity and secondary roles | Operator as `ACCOUNTADMIN` |
| Map the deployed SQL-API identifier to the approved account | Operator against Vercel Production and the approved account record |
| Confirm deployed `SNOWFLAKE_WEB_USER` is byte-exact `ROASTPILOT_WEB_PROD` | Operator against Vercel Production |
| Confirm deployed `SNOWFLAKE_WEB_WAREHOUSE` is byte-exact `ROASTPILOT_WH` | Operator against Vercel Production |
| Confirm deployed `SNOWFLAKE_WEB_DATABASE` is byte-exact `ROASTPILOT` | Operator against Vercel Production |
| Confirm deployed `SNOWFLAKE_WEB_SCHEMA` is byte-exact `APP` | Operator against Vercel Production |
| Pass both required production grant-boundary and live-deployment verifications | Operator under the identities assigned by the production deployment runbook |
| Reconfirm the Snowsight browser account before activation | Operator as `ACCOUNTADMIN` |
| Enable or confirm payment method before expiry | Operator as `ACCOUNTADMIN` |
| Verify On-Demand Standard result and recheck cost controls | Operator as `ACCOUNTADMIN` |
| Region, edition and warehouse size | Already provisioned / no action |
| Monitor and warehouse configuration | Already provisioned / no action |
| Production database, service user and key-pair | Already provisioned / no action |
| Vercel Production environment and live taster | Already provisioned / no action |

The operator owns verification and billing activation; this authorises no new object or grant.

## S6: Activate billing only after all checkpoints pass

1. Immediately before activation, use the Snowsight account selector or **Admin -> Account** view `[VERIFY-LIVE]`; require the exact SQL-approved S2 locator or STOP.

2. Activate only after S2/S3 and S4 pass for the approved account, and deployed
   `SNOWFLAKE_WEB_USER`/`SNOWFLAKE_WEB_WAREHOUSE`/`SNOWFLAKE_WEB_DATABASE`/
   `SNOWFLAKE_WEB_SCHEMA` byte-match `ROASTPILOT_WEB_PROD`/`ROASTPILOT_WH`/`ROASTPILOT`/`APP`. Both [grant-boundary](prod-deploy-runbook.md#verify-the-production-grant-boundary) and [live-deployment](prod-deploy-runbook.md#p5-verify-the-live-deployment) gates must pass. Only then enable billing `[VERIFY-LIVE]`.

3. After activation, verify purchasing is On-Demand, not Capacity, and the edition is
   Standard, not Enterprise `[VERIFY-LIVE]`; repeat S3 with no recreation or downtime.

STOP unless S2 identity, S3 locator/controls, S4 identity/account mapping,
`SNOWFLAKE_WEB_USER`/`SNOWFLAKE_WEB_WAREHOUSE`/`SNOWFLAKE_WEB_DATABASE`/`SNOWFLAKE_WEB_SCHEMA` byte matches,
both delegated gates, payment readiness, continued billing and final S3 recheck pass.
