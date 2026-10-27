"""D220 public projection structural checks; no Snowflake runtime claim."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_base_tables_schema import split_columns, strip_line_comments
from test_secure_views import SLUG_REGION, REVIEWS_REGION, _select_column_names, _top_level_from_index

ROOT = Path(__file__).resolve().parent.parent
RAW = (ROOT / "migrations/R__secure_views.sql").read_text(encoding="utf-8")
SQL = strip_line_comments(RAW)
O1 = ["started_at_utc", "first_crack_at_utc", "beans_added_at_utc", "beans_dropped_at_utc", "total_roast_seconds", "development_time_percent"]
TIMESTAMPS = O1[:4]
G_CONTRACT = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
O3 = [
    ("2026-06-07T11:58:31.306365+00:00", True),
    ("2026-06-07T11:58:31Z", True),
    ("2026-06-07T11:58:31.1-05:30", True),
    ("2026-06-07T11:58:31.123456789+14:00", True),
    ("2026-13-45T25:61:61Z", True),
    ("2026-06-07T11:58:31.1234567890Z", False),
    ("2026-06-07T11:58:31", False),
    ("2026-06-07 11:58:31Z", False),
    ("2026-06-07T11:58Z", False),
    ("2026-06-07T11:58:31+0000", False),
    ("2026-06-07T11:58:31z", False),
    ("2026-06-07T11:58:31Z\n", False),
    (" 2026-06-07T11:58:31Z", False),
    ("2026-06-07T11:58:31.Z", False),
    ("2026-06-07T11:58:31Z<script>", False),
    ("", False),
    ("roaster_driver", False),
    ("2026-06-07T11:58:31+00:00; x", False),
]
BASE_REVIEWS = "create or replace secure view reviews_by_roast copy grants as\nselect\n  r.public_slug,\n  tr.reviewer_name,\n  tr.score,\n  tr.aroma,\n  tr.acidity,\n  tr.sweetness,\n  tr.body,\n  tr.aftertaste,\n  tr.brew_method,\n  tr.notes,\n  tr.created_at\nfrom tasting_reviews tr\njoin cloud_roasts r on tr.roast_id = r.id\nwhere r.visibility <> 'private';\n"


def summary_pairs():
    """Read the summary expression without evaluating SQL."""
    start = SLUG_REGION.lower().index("object_construct_keep_null(") + len("object_construct_keep_null(")
    depth, end = 1, start
    while depth:
        depth += {"(": 1, ")": -1}.get(SLUG_REGION[end], 0)
        end += 1
    values = split_columns(SLUG_REGION[start:end - 1])
    assert len(values) % 2 == 0
    return [(values[i].strip().strip("'"), values[i + 1].strip()) for i in range(0, len(values), 2)]


def test_cur1_summary_keys_exact_order_and_sources():
    pairs = summary_pairs()
    assert [key for key, _ in pairs] == ["curated_version", *O1]
    for key, value in pairs[1:]:
        assert re.findall(r"r\.summary:([a-z_]+)", value) == [key] * (3 if key in TIMESTAMPS else 2)


def test_cur2_no_bare_summary_reference():
    assert re.search(r"\br\.summary(?!:)", SQL, re.IGNORECASE) is None
    assert set(re.findall(r"r\.summary:([a-z_]+)", SQL)) <= set(O1)


def test_cur3_guards_per_key():
    values = dict(summary_pairs())
    for key in TIMESTAMPS:
        value = values[key]
        assert f"typeof(r.summary:{key}) = 'VARCHAR'" in value
        assert f"regexp_like(r.summary:{key}::string, '{G_CONTRACT}')" in value
        assert value.startswith("case when ") and value.endswith("else null end")
    for key in O1[4:]:
        value = values[key]
        assert f"typeof(r.summary:{key}) in ('INTEGER', 'DECIMAL', 'DOUBLE')" in value
        assert value.startswith("case when ") and value.endswith("else null end")


def test_cur4_curated_version_literal_one():
    assert dict(summary_pairs())["curated_version"] == "1"


def test_cur5_fixture_excluded_keys_absent():
    for session in (1, 2):
        fixture = json.loads((ROOT / f"fixtures/m1-export/session-{session}/summary.json").read_text())
        for key in fixture.keys() - set(O1):
            assert re.search(rf"'{re.escape(key)}'|r\.summary:{re.escape(key)}\b", SQL) is None


def test_cur6_fixture_o1_types_and_grammar():
    for session in (1, 2):
        fixture = json.loads((ROOT / f"fixtures/m1-export/session-{session}/summary.json").read_text())
        for key in TIMESTAMPS:
            assert isinstance(fixture[key], str) and re.fullmatch(G_CONTRACT, fixture[key])
        for key in O1[4:]:
            assert isinstance(fixture[key], (int, float)) and not isinstance(fixture[key], bool)


def test_corp1_grammar_labels():
    for value, accepted in O3:
        assert (re.fullmatch(G_CONTRACT, value) is not None) == accepted


def test_priv1_private_tokens_absent():
    for token in ("operator_notes", "idempotency_key", "contributed_to_learning", "owner_id", "updated_at", "cloud_roast_tombstones", "roast_artifacts"):
        assert re.search(rf"\b{token}\b", SQL, re.IGNORECASE) is None
    without_joins = SQL.replace("t.roast_id = r.id", "").replace("tr.roast_id = r.id", "")
    assert re.search(r"\bid\b|\broast_id\b", without_joins, re.IGNORECASE) is None


def test_rating1_operator_rating_last_and_unwrapped():
    assert _select_column_names(SLUG_REGION) == ["public_slug", "bean_origin", "bean_varietal", "bean_weight_g", "profile_name", "roast_level", "roasted_at_utc", "created_at", "summary", "curve", "operator_rating"]
    body = SLUG_REGION[re.search(r"\bselect\b", SLUG_REGION).end():_top_level_from_index(SLUG_REGION)]
    assert split_columns(body)[-1].strip() == "r.operator_rating"
    assert SLUG_REGION.count("r.operator_rating") == 1
    assert "operator_rating" not in REVIEWS_REGION


def test_consent1_no_consent_token_in_views():
    assert "contributed_to_learning" not in RAW


def test_reviews_region_byte_identical():
    assert RAW[RAW.index("create or replace secure view reviews_by_roast"):] == BASE_REVIEWS
