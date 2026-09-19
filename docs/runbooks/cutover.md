# Trial to on-demand billing cutover

This runbook covers the operator-controlled transition from Snowflake trial
credits to on-demand billing for the existing production account. It does not
create, migrate, resize or re-provision any Snowflake or Vercel object.

## S0: Context and decisions

The account is already in Azure UK South, on the Standard edition and using
on-demand capacity. C1 through C7 ran against its 30-day trial allocation of
approximately $400 in credits. Here, "cutover" means arranging continued
on-demand billing when those trial credits expire. It is a billing transition,
not an account, region, edition or warehouse-size migration.

The existing production deployment remains the one documented in
[Production deployment](prod-deploy-runbook.md). Its service-user and key-pair
lifecycle remains governed by [Snowflake key-pair provisioning and
rotation](key-rotation.md). The cost-control boundary remains the shared
warehouse and monitor documented in [Resource monitor and shared
warehouse](resource-monitor.md).

Run the checks below as close as practical to the billing change, and complete
the payment-method step before the remaining trial credits are exhausted.
Unknown billing state, identity or configuration fails closed: stop the
cutover and verify it through the named live administration surface.

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

   Compare the returned account identifier with the approved production
   account record `[VERIFY-LIVE]`. Never copy that identifier into this public
   repository. Stop if the account or region differs.

2. In Snowsight, open **Admin -> Accounts** and inspect the live account
   details `[VERIFY-LIVE]`. Confirm that the edition is Standard and that the
   capacity/billing model is on-demand. There is no repository-approved SQL
   query for those billing fields; do not substitute an inferred column or
   fabricated query.

3. In Snowsight, open **Admin -> Cost Management -> Billing** and confirm the
   trial-credit balance, expiry state and payment-method readiness
   `[VERIFY-LIVE]`. Record the observation in the private operator log without
   copying an account identifier or payment details into the repository.

4. Before trial credits are exhausted, enable or confirm on-demand billing and
   a valid payment method in that Snowsight Billing surface `[VERIFY-LIVE]`.
   Obtain the normal operator approval for the charge. Do not wait for the
   account or warehouse to be suspended.

5. Re-open the same Billing surface and verify that continued on-demand billing
   is active `[VERIFY-LIVE]`. The same account, region, edition and warehouse
   continue at expiry. No object is recreated and there is no downtime or
   re-provisioning: credentials, roles, secure views, resource monitor and the
   live taster at <https://roastpilot-cloud.vercel.app> remain in place.

If payment readiness or continued billing cannot be proved, stop and escalate
before the credits expire. Do not treat a successful Snowflake query as proof
of future billing continuity.

## S3: Confirm existing cost controls

Run the C7-S3 live verifier exactly as documented in [Resource monitor and
shared warehouse](resource-monitor.md#manual-verification). Use
`ACCOUNTADMIN`, or an already-existing role that can see the account resource
monitor. `ROASTPILOT_CLI` and `ROASTPILOT_ADMIN` cannot see
`ROASTPILOT_MONITOR`; do not mistake a zero-row result for a missing monitor.

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

These are checks of existing controls, not instructions to alter them. Do not
re-embed or modify the verifier during cutover. A mismatch or visibility error
blocks the cutover until the live state is understood and reconciled through
the normal change process.

## S4: Verify the production service-user and key-pair

`ROASTPILOT_WEB_PROD` and its production key-pair already exist and are live.
They were provisioned under C7-S1 (#545), with their lifecycle documented under
C7-S2 (#546). Billing cutover is not the gate for creating prod credentials.
Do not create, replace or rotate either credential during this procedure.

As `ACCOUNTADMIN`, verify the existing service user:

```sql
USE ROLE ACCOUNTADMIN;
SHOW USERS LIKE 'ROASTPILOT_WEB_PROD';
```

The result must contain exactly one row whose exact name is
`ROASTPILOT_WEB_PROD`. Confirm that its `default_secondary_roles` column is
empty, representing `DEFAULT_SECONDARY_ROLES = ()`. In Snowsight, open
**Admin -> Users & Roles -> ROASTPILOT_WEB_PROD** and confirm that key-pair
authentication is configured `[VERIFY-LIVE]`; do not copy a fingerprint or any
key material into the operator record.

Use the verification detail in [Production deployment](prod-deploy-runbook.md#verify-the-production-grant-boundary)
and leave all key-pair mechanics to [Snowflake key-pair provisioning and
rotation](key-rotation.md). If a genuinely fresh environment ever lacks this
credential, provision it per C7-S2 before go-live as a separate action, not as
part of billing cutover.

## S5: Ownership summary

| Cutover step | Owner and identity |
| --- | --- |
| Confirm live account and `AZURE_UKSOUTH` region | Operator as `ACCOUNTADMIN` |
| Confirm Standard edition and on-demand capacity | Operator as `ACCOUNTADMIN` |
| Confirm trial balance, expiry and payment readiness | Operator as `ACCOUNTADMIN` |
| Enable or confirm payment method before expiry | Operator as `ACCOUNTADMIN` |
| Verify continued on-demand billing | Operator as `ACCOUNTADMIN` |
| Verify `ROASTPILOT_MONITOR` and `ROASTPILOT_WH` | Operator as `ACCOUNTADMIN`, or an already-existing monitor-visible role |
| Verify `ROASTPILOT_WEB_PROD` and key-pair presence | Operator as `ACCOUNTADMIN` |
| Region, edition and warehouse size | Already provisioned / no action |
| Monitor and warehouse configuration | Already provisioned / no action |
| Production database, service user and key-pair | Already provisioned / no action |
| Vercel Production environment and live taster | Already provisioned / no action |

The operator owns only the live verification and billing activation steps.
This runbook authorises no new role, grant, warehouse, credential, database or
application deployment.
