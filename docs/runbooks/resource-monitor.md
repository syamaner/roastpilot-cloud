# Resource monitor and shared warehouse

This is the operator check for the existing Snowflake resource monitor and
warehouse (C7-S3, #547). Provisioning happened outside this repository under
D106. No migration in this story creates or alters either object.

## Current decision: stay shared (D-C7-2)

The public web path and the agent path currently share one warehouse,
`ROASTPILOT_WH`, and one resource monitor, `ROASTPILOT_MONITOR`. This is the
ratified stay-shared choice for the current workload. The monitor bounds the
shared credit spend. The public and agent roles still have their separate
database privileges; a warehouse is compute, not a data authorization.

The expected state is:

| Setting | Expected value |
| --- | --- |
| Monitor credit quota | 5 |
| Notify trigger | includes 50% |
| Suspend trigger | 100% |
| Suspend immediate trigger | 110% (`[UNVERIFIED-OFFLINE]`) |
| Warehouse size | X-Small |
| Warehouse auto-suspend | 60 seconds |
| Warehouse auto-resume | true |
| Warehouse resource monitor | `ROASTPILOT_MONITOR` |
| Effective `STATEMENT_TIMEOUT_IN_SECONDS` on `ROASTPILOT_WH` | exactly 300 seconds |

The operator-ratified hardening sets `STATEMENT_TIMEOUT_IN_SECONDS = 300` on
`ROASTPILOT_WH`. The 172800-second (2-day) account default is the
denial-of-wallet gap this setting closes. The verifier rejects any effective
timeout other than 300 seconds. The 110% immediate trigger is asserted by the
story but does not appear in plan §15. The first live dispatch validates it
against the operator-provisioned object.

## Manual verification

Run from the repository root with a configured Snowflake connection. The
simplest path is a connection whose user can assume `ACCOUNTADMIN`. The
default `roastpilot` / `ROASTPILOT_CLI` service connection cannot: its
available roles (`ROASTPILOT_ADMIN`, `PUBLIC`, `SNOWFLAKE_LEARNING_ROLE`)
cannot see the resource monitor. For a least-privilege alternative,
`ACCOUNTADMIN` can grant a custom role visibility into both objects:

```sql
GRANT MONITOR ON RESOURCE MONITOR ROASTPILOT_MONITOR TO ROLE <role>;
GRANT MONITOR ON WAREHOUSE ROASTPILOT_WH TO ROLE <role>;
GRANT USAGE ON WAREHOUSE ROASTPILOT_WH TO ROLE <role>;
```

The monitor grant lets `SHOW RESOURCE MONITORS` return the monitor; the
warehouse `MONITOR` grant is for `SHOW WAREHOUSES` and `SHOW PARAMETERS ...
IN WAREHOUSE`. The `USAGE` grant lets the verifier select `ROASTPILOT_WH`
at connection time. This least-privilege grant set has not been live-verified
in this repo because the CI/service credentials cannot see the monitor. The
operator must confirm and adjust the exact minimal grants at the first
`ACCOUNTADMIN` dispatch; the `ACCOUNTADMIN` path is the supported one.
The default `SCHEMACHANGE_CONNECTION_NAME` is `roastpilot`. Substitute both
placeholders:

```bash
cd snowflake && SCHEMACHANGE_CONNECTION_NAME=<profile> SNOWFLAKE_ROLE=<role> python3 with_connection_env.py python3 resource_monitor_verify_live.py
```

`<profile>` is a `snow` connection whose user can assume `<role>`; use
`ACCOUNTADMIN` for the supported path, or the custom role granted `MONITOR ON
RESOURCE MONITOR ROASTPILOT_MONITOR`, `MONITOR ON WAREHOUSE ROASTPILOT_WH`,
and `USAGE ON WAREHOUSE ROASTPILOT_WH`.
`SNOWFLAKE_ROLE` selects only the session role, not the connection user or key.

The script reads `SHOW RESOURCE MONITORS`, `SHOW WAREHOUSES`, and `SHOW
PARAMETERS` after disabling secondary roles for its session. It reports a
failure and exits non-zero if a required row, column, value, or exact object
name is missing or malformed. A monitor that exists but is not assigned to
`ROASTPILOT_WH` also fails. The script does not repair drift.

If verification fails, inspect the live Snowflake setting with the operator
role, compare the expected state with plan §15 and D-C7-2, and reconcile the
operator-provisioned configuration through the normal change process. Keep
the verifier's constants aligned with the ratified expectation. Record the
first live observation of the 110% trigger before treating it as confirmed.

For the monitor, an "expected exactly one ... found 0" failure most often
means the running role cannot see it: `SHOW RESOURCE MONITORS` returns zero
rows without visibility into that object. Run under `ACCOUNTADMIN` or grant
`MONITOR ON RESOURCE MONITOR ROASTPILOT_MONITOR` to the running role before
concluding that the monitor is missing.

Before raising the shared five-credit cap, move CI to its own warehouse and
resource monitor as part of the future split below. Confirm CI no longer draws
from the application monitor before enlarging the application budget. Then
raise the cap through the normal ACCOUNTADMIN change process and re-run this
verifier against the resulting configuration.

## Future split, not built

If public traffic or agent jobs need independent compute isolation later,
plan a public warehouse and an agent warehouse with separate resource
monitors. Reassess quotas, timeout limits, role grants, cost attribution,
and verification for each warehouse before changing the shared setup.
The current verifier intentionally checks one warehouse and one monitor;
it does not provision or assume that future split.
