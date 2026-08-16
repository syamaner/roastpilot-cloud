# Authorized decision context

- Source: https://github.com/syamaner/roastpilot-cloud/pull/153
- Posted by: `syamaner`
- Posted at: `2026-07-27T21:17:22Z`
- Verdict boundary: `2026-07-27T21:37:25Z`
- Capture policy: pre-outcome plan and verification substance only; merge result, disposition, and readiness-label text are excluded.

## Bounded fix

The DEV Snowflake contract summary interpolated three repository variables directly into a shell `run:` body. Expression interpolation occurs before shell parsing, so operator-controlled values could become script text. The fix is structural: bind each value through step-level `env:` and reference it as a quoted shell variable. Benign summary rendering remains unchanged because parameter-expansion results are not reparsed as shell syntax.

Runner-produced step outcome expressions remain directly interpolated because their values are closed enums and their step identifiers are literals in protected workflow configuration.

## One-PR plan

One conventional protected-surface unit contains:

1. Replace the three repository-variable shell interpolations with exact step-level environment bindings.
2. Add a repository-wide closed allow-list test for expressions permitted inside workflow and composite-action `run:` bodies.
3. Cover workflow and composite-action files, reject an empty scanned corpus, and preserve the existing Environment gate, egress block, grant audits, key cleanup, and timeout.

The unit does not change what the summary reports, grant-audit logic, identifier validation, Environment configuration, or branch protection. The workflow and its enforcement test land together because separating them would either leave the sink unguarded or make the new guard fail before the workflow change.

## Verification and routing

Adversarial cases include command substitution, backticks, arithmetic expansion, quote breaking, redirection, option smuggling, environment indirection, step outputs, bracket access, helper expressions, case variants, and mixed allowed/disallowed expressions. Unknown forms fail closed; only reviewed whole-expression shapes pass. The protected workflow surface requires conventional execution and the factory-security lens, followed by lint, typecheck, and the full test suite.
