# Trial to on-demand billing cutover

This runbook covers the operator-controlled transition from Snowflake trial credits to
on-demand billing. It does not create, migrate, resize or re-provision any object.

## S0: Context and decisions

The account is already in Azure UK South, on the Standard edition and using on-demand
capacity. C1 through C7 ran against its 30-day trial allocation of approximately $400
in credits. Here, "cutover" means arranging continued on-demand billing when those
trial credits expire. It is not an account, region, edition or warehouse-size migration.

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
   Compare it exactly with an approved production locator record `[VERIFY-LIVE]`, never
   with `<organisation>-<account_name>`, `<organisation>.<account_name>` or a partial
   match. Never copy an identifier here. Stop if the exact locator or region differs.

2. In the Snowsight account selector or **Admin -> Account** view `[VERIFY-LIVE]`,
   require the browser's account locator to exactly match both step 1 and the approved
   production locator. STOP otherwise. Confirm Standard edition and on-demand capacity
   there `[VERIFY-LIVE]`; do not substitute an inferred column or fabricated query.

3. In Snowsight, open **Admin -> Cost Management -> Billing** and confirm the
   trial-credit balance, expiry state and payment-method readiness
   `[VERIFY-LIVE]`. Record the observation in the private operator log without
   copying an account identifier or payment details into the repository.

## S3: Confirm existing cost controls

Run the C7-S3 verifier in [Resource monitor and shared warehouse](resource-monitor.md#manual-verification).
Use `ACCOUNTADMIN` or a monitor-visible role; `ROASTPILOT_CLI` and `ROASTPILOT_ADMIN` cannot.

Using its exact `<profile>`, role and effective overrides, have the verifier connection
report `SELECT CURRENT_ACCOUNT();` `[VERIFY-LIVE]`. Require the exact S2 locator;
unknown/mismatch means STOP, regardless of same-named objects.

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

These checks do not alter controls or re-embed the verifier. Any identity, visibility
or value failure blocks cutover until reconciled through the normal change process.

## S4: Verify the production service-user and key-pair

`ROASTPILOT_WEB_PROD` and its key-pair already exist and are live under C7-S1 (#545)
and C7-S2 (#546). Billing cutover is not the gate for creating prod credentials.
Do not create, replace or rotate either credential during this procedure.

As `ACCOUNTADMIN`, verify the existing service user:

```sql
USE ROLE ACCOUNTADMIN;
SELECT CURRENT_ACCOUNT();
SHOW USERS LIKE 'ROASTPILOT_WEB_PROD';
```

Accept only when this session's locator exactly matches S2 and the complete `SHOW`
result has exactly one row whose `name` byte-exactly equals `ROASTPILOT_WEB_PROD`.
`LIKE` treats `_` as a wildcard; zero, multiple or non-exact rows mean STOP. Only that row may be checked; its
`default_secondary_roles` must be empty, representing `DEFAULT_SECONDARY_ROLES = ()`.
With Snowsight reconfirmed on the approved locator, confirm key-pair authentication
under **Admin -> Users & Roles -> ROASTPILOT_WEB_PROD** `[VERIFY-LIVE]`; copy no key data.

Presence is not proof. First prove the deployed Production target's effective
`SNOWFLAKE_WEB_ACCOUNT` resolves to the approved locator `[VERIFY-LIVE]`. Then run
the fresh route-valid 404 probe in [Production deployment](prod-deploy-runbook.md#p5-verify-the-live-deployment).
Require its live-query 404 proving the deployed key and `PUBLIC_WEB`; otherwise STOP.

See [Production deployment](prod-deploy-runbook.md#verify-the-production-grant-boundary)
and [Snowflake key-pair provisioning and rotation](key-rotation.md). In a fresh
environment, provision a missing credential per C7-S2 separately before go-live.

## S5: Ownership summary

| Cutover step | Owner and identity |
| --- | --- |
| Confirm live account and `AZURE_UKSOUTH` region | Operator as `ACCOUNTADMIN` |
| Confirm the Snowsight browser account exactly matches the approved production locator | Operator as `ACCOUNTADMIN` |
| Confirm Standard edition and on-demand capacity | Operator as `ACCOUNTADMIN` |
| Confirm trial balance, expiry and payment readiness | Operator as `ACCOUNTADMIN` |
| Prove the S3 verifier account locator, then verify `ROASTPILOT_MONITOR` and `ROASTPILOT_WH` | Operator as `ACCOUNTADMIN`, or an already-existing monitor-visible role |
| Bind the S4 SQL/Snowsight account, then verify exact user identity and secondary roles | Operator as `ACCOUNTADMIN` |
| Bind the deployed Production account locator, then pass the route-valid 404 probe | Operator against Vercel Production and the live URL |
| Reconfirm the Snowsight browser account before activation | Operator as `ACCOUNTADMIN` |
| Enable or confirm payment method before expiry | Operator as `ACCOUNTADMIN` |
| Verify continued billing and recheck cost controls | Operator as `ACCOUNTADMIN` |
| Region, edition and warehouse size | Already provisioned / no action |
| Monitor and warehouse configuration | Already provisioned / no action |
| Production database, service user and key-pair | Already provisioned / no action |
| Vercel Production environment and live taster | Already provisioned / no action |

The operator owns only live verification and billing activation. This runbook authorises
no new role, grant, warehouse, credential, database or application deployment.

## S6: Activate billing only after all checkpoints pass

1. Immediately before activation, use the Snowsight account selector or **Admin -> Account**
   view `[VERIFY-LIVE]`; require the exact SQL-approved S2 locator or STOP.

2. Activate only after S2 SQL = Snowsight = approved locator; S3's connection equals
   that locator and passes; and S4's SQL, Snowsight and deployed-target locators equal
   it while the exact-user, secondary-role and functional 404 proofs all pass.
   Then enable billing and a valid payment method before expiry `[VERIFY-LIVE]`.

3. Verify continued billing `[VERIFY-LIVE]` and repeat all S3 identity and value checks,
   proving the controls remain in the approved account. The same account, region,
   edition and warehouse continue at expiry. Nothing is recreated and there is no
   downtime: credentials, roles, views, monitor and live taster remain in place.

STOP unless S2 identity, S3 locator and controls, every S4 locator/identity/404 proof,
payment readiness, continued billing and final S3 recheck pass; one query is insufficient.
