# snowflake/ — schemachange migrations

Snowflake DDL for roastpilot-cloud is managed with
[schemachange](https://github.com/Snowflake-Labs/schemachange), version-pinned
in [`requirements.txt`](./requirements.txt) (currently `4.3.3`). This
directory is the only place a Python tool lives in an otherwise Next.js/TS
repo — it is never added to `package.json` / `npm ci`.

Plan reference: `roastpilot-plan/roastpilot-cloud/plan.md` §4 (data model),
§9 (repo layout), §10 (testing), §15 (cost model).

## Setup

```bash
cd snowflake
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

(A `pipx install schemachange==4.3.3` works too if you want it isolated from
any project venv — either is fine, the version pin in `requirements.txt` is
what matters.)

For running the tooling's own unit tests (below), install
`requirements-dev.txt` instead (layers `pytest`/`pytest-cov` on top of
`requirements.txt`, never merged into it):

```bash
pip install -r requirements-dev.txt
```

## Connection convention

`schemachange-config.yml` sets **no** account/user/role/warehouse/auth.
Connection identity comes entirely from `SNOWFLAKE_*` environment variables
at deploy time, resolved from the named `roastpilot` connection in
`~/.snowflake/config.toml` (the file the `snow` CLI writes) via
[`with_connection_env.py`](./with_connection_env.py):

```bash
python3 with_connection_env.py schemachange deploy --schemachange-create-change-history-table
```

**Why the indirection** (verified locally, not a hypothetical): the generic
`snowflake-connector-python` config loader (`CONFIG_MANAGER`, what `snow`
itself and ad hoc scripts use) happily resolves `[connections.roastpilot]`
straight out of `config.toml`. But schemachange 4.3.3's *own* connections.toml
reader (`schemachange.config.utils.get_connections_toml_parameters`) expects
the older flat layout — top-level `[roastpilot]`, not nested
`[connections.roastpilot]` — and silently returns nothing for our file
(confirmed by calling it directly against the real config). Env vars are
schemachange's other fully-supported input layer (P2, above YAML, below
CLI), so `with_connection_env.py` reads `config.toml` **when it exists**
(see below for what happens when it doesn't) and exports
`SNOWFLAKE_ACCOUNT` / `_USER` / `_ROLE` / `_WAREHOUSE` / `_DATABASE` /
`_SCHEMA` / `_AUTHENTICATOR` / `_PRIVATE_KEY_FILE` before exec'ing the real
command, per field (see the merge behavior below — this isn't an
all-or-nothing bulk export). Nothing is duplicated into the repo — it
re-reads `config.toml` on every invocation, never caching it — and no
secret *value* lives on disk here, only a private key *path*.

The default connection name is `roastpilot` (key-pair auth, role
`ROASTPILOT_ADMIN`, warehouse `ROASTPILOT_WH`). **Never** put account
identifiers, usernames, or key paths directly in `schemachange-config.yml`
or any migration — they belong only in `~/.snowflake/config.toml`, which is
never committed.

To point at a different connection (e.g. a future CI-scoped or prod key)
without editing any file:

```bash
export SCHEMACHANGE_CONNECTION_NAME=some-other-connection
python3 with_connection_env.py schemachange deploy ...
```

Any `SNOWFLAKE_*` variable already set in the calling shell wins over what
`with_connection_env.py` resolves, **per field** — useful for CI, where the
DEV-scoped key comes from repo secrets rather than a local `config.toml`
(F1-S8/C7; out of scope here, see below).

`with_connection_env.py` reads `config.toml` whenever it exists and merges
it in field by field: each individual `SNOWFLAKE_*` value prefers whatever
the shell already set, and falls back to the profile for anything the shell
didn't set. A **missing** `config.toml` is tolerated (not an error) — this
is exactly CI's shape (issue #18): a job with every `SNOWFLAKE_*` field
already injected as a secret, no `config.toml` on the runner at all, so the
profile is never actually needed there. A `config.toml` that **exists but
doesn't contain the requested connection profile** is still a hard error —
that's a genuine misconfiguration, not "no local file at all".

`resolve_connection_env` also maps a profile's `database`/`schema` fields
(to `SNOWFLAKE_DATABASE`/`SNOWFLAKE_SCHEMA`) and accepts either
`private_key_file` or `private_key_path` in a connection profile — the
`snow` CLI itself accepts both spellings — normalizing whichever is present
to the single `SNOWFLAKE_PRIVATE_KEY_FILE` env var schemachange/the
connector read natively.

## Target database

`SNOWFLAKE_DATABASE` selects which database the migrations run against, and
also flows into `schemachange-config.yml`'s change-history table location
(`<database>.METADATA.CHANGE_HISTORY` — deliberately inside the target
database, not schemachange's default separate `METADATA` database, so DEV
stays self-contained). Defaults to `ROASTPILOT_DEV` if unset.

```bash
export SNOWFLAKE_DATABASE=ROASTPILOT_DEV   # default; export a different value for a future prod cutover (C7)
```

(`schemachange-config.yml` deliberately does **not** set a YAML
`snowflake-database:` key — schemachange logs a "deprecated, set in
connections.toml instead" warning for that key. The env var / CLI layer is
the supported override path, and it's what lets one config file serve DEV
today and a prod database later without a diff.)

## Applying migrations

```bash
cd snowflake
python3 with_connection_env.py schemachange deploy --schemachange-create-change-history-table
```

`--schemachange-create-change-history-table` is only needed the first time a
target database has never been deployed to (it creates
`METADATA.CHANGE_HISTORY`); safe to pass on every run, it's a no-op once the
table exists.

**Cost note (plan §15):** every deploy resumes the warehouse (a 60 s compute
minimum, `AUTO_SUSPEND = 60`), inside the account's 5-credit/month resource
monitor. Batch schema changes into one deploy rather than one migration at a
time where practical.

- **DEV**: apply freely — it's the whole point of `ROASTPILOT_DEV`.
- **Prod** (post-C7 cutover): apply from a reviewed PR only, never ad hoc from
  a laptop; that runbook lands with the C7 story.

## Validating offline (no warehouse, no connection)

`schemachange render` parses a migration's Jinja and prints the rendered SQL
to the console — it never opens a Snowflake session, so it's safe to run
anywhere, including CI, with no secrets:

```bash
cd snowflake
schemachange render migrations/V1.0.0__bootstrap.sql
```

This is what the CI job runs (offline lint: filenames match the `V<version>__
description.sql` / `R__description.sql` convention, and every migration
renders without a Jinja error). CI does **not** connect to Snowflake here —
see the next section for the live counterpart.

## Live contract check against ROASTPILOT_DEV (F1-S8)

`.github/workflows/dev-snowflake-contract.yml` is the live-connecting
counterpart the offline job above always deferred: it runs the grants
audit (`assert_dev_ci_grants.py`) **twice** — once BEFORE deploying
migrations against `ROASTPILOT_DEV` with the DEV-scoped CI key
(`ROASTPILOT_DEV_CI`, role `ROASTPILOT_DEV_CI_ROLE`), and once AFTER. The
pre-deploy run is the drift gate (catches a grant that was already wrong
going in, before writing anything); the post-deploy run is the
migration-output gate (catches a migration that ITSELF introduces a
forbidden grant — a bad `GRANT ... TO PUBLIC` migration is valid SQL and
succeeds, so only re-auditing the database AFTER it's applied can catch
it; a pre-deploy-only check would let that class of bad migration pass).

The grants check covers five independent things, all of which must pass:
`SHOW GRANTS TO ROLE` (current object grants on the primary role stay
within `ROASTPILOT_DEV`/`DEV_CI_WH`), `SHOW DATABASES`/`SHOW WAREHOUSES`
(nothing else is even VISIBLE to the role — closes the gap a future grant
would leave in `SHOW GRANTS` alone), `SHOW GRANTS TO ROLE PUBLIC` (PUBLIC
must hold **zero grants, anywhere** — `AGENTS.md`'s Architecture Invariant
is "No grants to `PUBLIC`, anywhere", not merely "PUBLIC stays inside the
DEV boundary", so this check does NOT reuse the primary role's
boundary-aware logic), and `SHOW GRANTS TO USER` (the CI service user
itself carries no role beyond the primary one, plus PUBLIC).

Every identifier comparison (database, warehouse, role, object name)
routes through one function, `identifiers_match` — an EXACT, byte-for-byte
match: no case-folding, no whitespace-stripping. Snowflake quoted
identifiers preserve exact case AND exact whitespace, so a quoted
`"roastpilot_dev"` or a quoted `"ROASTPILOT_DEV "` (trailing space) is a
genuinely different object from unquoted `ROASTPILOT_DEV` — and the real
system `PUBLIC` role is always the literal uppercase, unquoted string
`PUBLIC`, so a quoted `"public"` is a different, disallowed role, not a
case variant of the real one. A qualified object name is matched by
splitting on the first `.` and comparing that component exactly, not
`str.startswith`.

Before connecting, the script also asserts
`SNOWFLAKE_DEV_DATABASE`/`SNOWFLAKE_DEV_WAREHOUSE` still equal the known-
correct literals `ROASTPILOT_DEV`/`DEV_CI_WH` — every check above trusts
those vars AS the boundary, so this anchors them against silently drifting
to point at the wrong object.

**Secondary roles** are kept off for both connections in this job, by two
different mechanisms — `USE SECONDARY ROLES` is a SQL statement, not a
settable session parameter, so a single `session_parameters`-style
mechanism can't cover both:

- The grants-check connection issues a real `USE SECONDARY ROLES NONE`
  statement right after connecting, before any audit query.
- The deploy connection has no equivalent mid-session hook (schemachange
  owns it), so it's covered instead by an **operator-run, one-time,
  account-level action**: `ALTER USER ROASTPILOT_DEV_CI SET
  DEFAULT_SECONDARY_ROLES = ()`, which stops secondary roles activating by
  default on any connection this user makes.

Per the factory security model (`factory.md` §8: agent jobs hold no
Snowflake secrets), this workflow is **`workflow_dispatch`-only** and its
job declares `environment: dev-snowflake-ci` — a GitHub Environment with a
required reviewer, so the credential is never active until a human
explicitly approves that specific run. It also runs with
`step-security/harden-runner`'s egress LOCKED to a fixed allowlist (GitHub,
PyPI, Snowflake) rather than the audit-only mode the rest of this factory's
jobs use, since a live credential is genuinely at stake here.

`validate_migrations.py` mirrors schemachange's own deploy-time collector
exactly (issue #18): it discovers every migration RECURSIVELY, in any
subdirectory, and recognizes `.sql`, `.sql.jinja` (jinja-templated SQL), and
`.cli.yml`/`.cli.yml.jinja` (Snowflake CLI action scripts) — not just
top-level `*.sql`. A file matching one of those extensions but no valid
`V`/`R`/`A` naming convention is a hard validation FAILURE here, even though
schemachange's own collector would just silently skip it at deploy time
(never applying it, never erroring) — this validator exists specifically to
catch that footgun in CI before it becomes a silently-never-deployed
migration.

## Testing the tooling itself

`with_connection_env.py` and `validate_migrations.py` have their own unit
test suite under [`tests/`](./tests/) (pytest, never touches a real
Snowflake connection or credential):

```bash
pip install -r requirements-dev.txt
pytest tests/ --cov=with_connection_env --cov=validate_migrations --cov-report=term-missing
```

This is what CI runs, before the offline migration-validation step above —
so a regression in either script's own logic (the per-field env/profile
merge, tolerating a missing `config.toml`, recursive migration discovery)
is caught independently of whatever migrations currently happen to exist.

## Migration naming

- `V<version>__<description>.sql` — versioned, applied once, in order (e.g.
  `V1.0.0__bootstrap.sql`, `V1.1.0__add_reviews_table.sql`). Two underscores
  between the version and the description are required — schemachange
  rejects one.
- `R__<description>.sql` — repeatable, re-applied whenever its checksum
  changes (views, procedures).

Keep each migration to one logical change; smaller migrations are easier to
review and to reason about if a deploy needs to stop partway.

## Snowflake enforces only NOT NULL

A real difference from Postgres/Supabase (plan.md §4): Snowflake enforces
**NOT NULL** and nothing else. Primary/unique/foreign keys can be declared
(useful for documentation and some query optimizations) but are **not
enforced**, and `CHECK` constraints don't exist at all. Consequences for
anyone authoring a migration here:

- Idempotency (e.g. `cloud_roasts.idempotency_key`) must be enforced by the
  write path (`MERGE ... ON idempotency_key`), not by a unique constraint.
- Range/enum validation (ratings 1–5, visibility values, slider 0–100) lives
  in application code — Pydantic on the agent side, Zod in the Vercel route —
  and both must implement the same rules. The schema will silently accept
  what a real constraint would reject.
- Cascade deletion must be procedural (an explicit `DELETE_ROAST` proc), not
  `ON DELETE CASCADE`.
- A `data_quality_violations` view (C2) is how the would-be constraints get
  asserted after the fact — it must stay empty; that's what the test suite
  and the C8 operator workspace check.

None of this is built yet (C2 owns it) — this note exists so whoever writes
the first real table migration doesn't assume Snowflake will catch a bad
insert the way Postgres would.

## What's out of scope here (C1-S2)

This story is the schemachange bootstrap only: the tool, its config, a
minimal namespace migration, and offline CI validation. It does **not**
create `cloud_roasts` / `roast_telemetry` / `roast_artifacts` /
`tasting_reviews` / `reference_roast_summaries`, roles, grants, secure views,
or stored procedures — all of that is C2 (factory-built, human-merged, per
`factory.md`).
