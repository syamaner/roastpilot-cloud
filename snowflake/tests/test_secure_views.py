"""Token-presence/absence + region-slice tests for the C2-S3 secure-view
migration (issue #311): R__secure_views.sql. Deliberately not a SQL parser
(#307-bounce pre-emption) -- reuses strip_line_comments/split_columns from
test_base_tables_schema.py. Hard ceiling: <=140 lines.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_migrations  # noqa: E402
from test_base_tables_schema import split_columns, strip_line_comments  # noqa: E402
SNOWFLAKE_DIR = Path(__file__).resolve().parent.parent
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "R__secure_views.sql"
STRIPPED = strip_line_comments(MIGRATION_PATH.read_text(encoding="utf-8"))
EXPECTED_SLUG_COLS = [
    "public_slug", "bean_origin", "bean_varietal", "bean_weight_g",
    "profile_name", "roast_level", "roasted_at_utc", "created_at", "summary", "curve",
]
EXPECTED_REVIEW_COLS = [
    "public_slug", "reviewer_name", "score", "aroma", "acidity",
    "sweetness", "body", "aftertaste", "brew_method", "notes", "created_at",
]
EXPECTED_CURVE_KEYS = [
    "elapsed_s", "bean_temp_c", "env_temp_c", "heat_percent", "fan_percent", "ror_c_per_min",
]
FORBIDDEN_SLUG = {"owner_id", "visibility", "raw", "submitted_ip_hash"}
FORBIDDEN_REVIEWS = {"owner_id", "submitted_ip_hash", "visibility"}

def _view_region(name: str) -> str:
    pattern = re.compile(
        rf"create\s+or\s+replace\s+secure\s+view\s+{name}\s+(?:copy\s+grants\s+)?as\b(.*?)"
        rf"(?=create\s+or\s+replace\s+secure\s+view|\Z)",
        re.IGNORECASE | re.DOTALL,
    )
    match = pattern.search(STRIPPED)
    assert match is not None, f"view {name} not found"
    return match.group(1)

def _top_level_from_index(text: str) -> int:
    depth = 0
    for token in re.finditer(r"[()]|\bfrom\b", text, re.IGNORECASE):
        symbol = token.group()
        if symbol == "(":
            depth += 1
        elif symbol == ")":
            depth -= 1
        elif depth == 0:
            return token.start()
    raise AssertionError("no top-level FROM found")

def _column_name(col_text: str) -> str:
    stripped_col = col_text.strip()
    alias_match = re.search(r"\bas\s+([a-zA-Z_]\w*)\s*$", stripped_col, re.IGNORECASE)
    if alias_match:
        return alias_match.group(1)
    return re.search(r"([a-zA-Z_]\w*)\s*$", stripped_col).group(1)

def _select_column_names(region: str) -> list[str]:
    select_match = re.search(r"\bselect\b", region, re.IGNORECASE)
    body = region[select_match.end() : _top_level_from_index(region)]
    return [_column_name(col) for col in split_columns(body)]

SLUG_REGION = _view_region("roast_by_slug")
REVIEWS_REGION = _view_region("reviews_by_roast")

def test_use_schema_app_precedes_first_create():
    use_match = re.search(r"use\s+schema\s+app\s*;", STRIPPED, re.IGNORECASE)
    first_create = re.search(r"create\s+or\s+replace\s+secure\s+view", STRIPPED, re.IGNORECASE)
    assert use_match and first_create and use_match.start() < first_create.start()

def test_exactly_two_secure_views_named_correctly():
    names = re.findall(r"create\s+or\s+replace\s+secure\s+view\s+(\w+)", STRIPPED, re.IGNORECASE)
    assert names == ["roast_by_slug", "reviews_by_roast"]

def test_both_definitions_use_the_word_secure():
    matches = re.findall(r"create\s+or\s+replace\s+(\w+)\s+view\b", STRIPPED, re.IGNORECASE)
    assert [m.lower() for m in matches] == ["secure", "secure"]

def test_both_views_have_copy_grants():
    matches = re.findall(
        r"create\s+or\s+replace\s+secure\s+view\s+\w+\s+copy\s+grants\s+as", STRIPPED, re.IGNORECASE
    )
    assert len(matches) == 2

def test_scope_fence_no_grant_role_proc_table_stage():
    forbidden = r"\bgrant\b|\bto\s+public\b|create\s+(?:or\s+replace\s+)?(role|procedure|function|table|stage)\b"
    assert re.search(forbidden, STRIPPED, re.IGNORECASE) is None
    creates = re.findall(r"\bcreate\s+or\s+replace\s+\w+\s+view\b", STRIPPED, re.IGNORECASE)
    assert len(creates) == 2

def test_roast_by_slug_has_visibility_private_filter():
    assert re.search(r"visibility\s*<>\s*'private'", SLUG_REGION, re.IGNORECASE)

def test_roast_by_slug_curve_gated_on_contributed_to_learning():
    assert re.search(
        r"case\s+when\s+r\.contributed_to_learning\s*=\s*true\s+then\s*\(\s*"
        r"select\s+array_agg\s*\(.*?\)\s+within\s+group\s*\(\s*order\s+by\s+t\.elapsed_s\s*\)\s+"
        r"from\s+roast_telemetry\s+t\s+where\s+t\.roast_id\s*=\s*r\.id\s*\)\s*end\s+as\s+curve",
        SLUG_REGION, re.IGNORECASE | re.DOTALL,
    )

def test_reviews_by_roast_has_visibility_private_filter():
    assert re.search(r"visibility\s*<>\s*'private'", REVIEWS_REGION, re.IGNORECASE)

def test_owner_id_absent_from_entire_migration():
    assert re.search(r"\bowner_id\b", STRIPPED, re.IGNORECASE) is None

def test_submitted_ip_hash_absent_from_entire_migration():
    assert re.search(r"\bsubmitted_ip_hash\b", STRIPPED, re.IGNORECASE) is None

def test_raw_absent_from_roast_by_slug_region():
    assert re.search(r"\braw\b", SLUG_REGION, re.IGNORECASE) is None

def test_roast_by_slug_projects_expected_and_no_forbidden_cols():
    cols = _select_column_names(SLUG_REGION)
    assert cols == EXPECTED_SLUG_COLS and not (set(cols) & FORBIDDEN_SLUG)

def test_reviews_by_roast_projects_expected_and_no_forbidden_cols():
    cols = _select_column_names(REVIEWS_REGION)
    assert cols == EXPECTED_REVIEW_COLS and not (set(cols) & FORBIDDEN_REVIEWS)

def test_curve_object_construct_has_exactly_six_celsius_keys():
    start = SLUG_REGION.lower().index("object_construct_keep_null(") + len("object_construct_keep_null(")
    depth, i = 1, start
    while depth > 0:
        depth += {"(": 1, ")": -1}.get(SLUG_REGION[i], 0)
        i += 1
    body = SLUG_REGION[start : i - 1]
    pairs = re.findall(r"'([a-zA-Z_]\w*)'\s*,\s*t\.(\w+)", body)
    assert [key for key, _ in pairs] == EXPECTED_CURVE_KEYS
    assert all(key == column for key, column in pairs) and "raw" not in body.lower()

def test_no_fahrenheit_token_or_conversion():
    assert re.search(r"fahrenheit|_f\b|\*\s*9\s*/\s*5|\*\s*1\.8|\+\s*32", STRIPPED, re.IGNORECASE) is None

def test_validate_migrations_passes():
    assert validate_migrations.main() == 0
