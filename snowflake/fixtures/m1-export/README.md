# M1 agent export fixture (de-identified real data)

Two real `roastpilot-agent` roast sessions, captured from
`~/git/roastpilot-agent/tests/fixtures/live-roast-2026-06-07/session-{1,2}/`
and committed here **data-only** as the shared contract fixture (D-312-F,
issue #312; satisfies #309 / C2-S9). This is the authoritative source shape the
seed pipeline (C2-S11) and the summary-mapping test (#315 / C2-S10) map
against. See plan.md §4 "Source export shape (M1 agent)" for the field →
column mapping.

Each `session-N/` directory is one export:

- `summary.json` — the flat roast summary (lifecycle timestamps, `metrics{…}`,
  `first_crack_model{…}`, `roaster_driver`).
- `roast.jsonl` — one JSON object per line, `type` discriminator, with
  `type=="telemetry"` sample rows interleaved with `type=="event"` lifecycle
  markers.

## De-identification

The shape is kept **verbatim** (byte-for-byte except the one change below). The
only identifying field in the real export is `session_id`; every occurrence was
replaced with a clearly-synthetic 32-hex constant (`5eed…0001` / `5eed…0002`).
A scan confirmed there are no IP addresses, emails, names, or other PII in
either file. `session_id` is validated-then-discarded by the seed parser (the
generator synthesises a fresh one), so its value here is inert.
