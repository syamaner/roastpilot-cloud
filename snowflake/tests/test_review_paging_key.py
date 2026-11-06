"""D226 paging-key text and UUID grammar contracts; no Snowflake runtime proof."""
import re
from pathlib import Path

RAW = (Path(__file__).resolve().parent.parent / "migrations/R__secure_views.sql").read_text()
U = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
EXPR = "case when regexp_like(tr.id, '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') and regexp_like(r.id, '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then 'v1-' || sha2('roastpilot/c9-c3/review-paging-key/v1|' || r.id || '|' || tr.id, 256) else null end as paging_key"


def test_pk1_expression_exact_and_last():
    region = RAW[RAW.index("create or replace secure view reviews_by_roast"):]
    assert region.count(EXPR) == 1
    assert "tr.created_at,\n  " + EXPR + "\nfrom app.tasting_reviews tr" in region
    fields = re.search(r"select\n(.*?)\nfrom app.tasting_reviews", region, re.S)[1]
    # Exactly eleven original projection lines followed by the single expression.
    assert len(fields.splitlines()) == 12


def test_pk2_uuid_guard_both_ids():
    assert f"regexp_like(tr.id, '{U}') and regexp_like(r.id, '{U}')" in RAW
    assert RAW.count(U) == 2


def test_pk3_uuid_corpus():
    valid = "12345678-1234-4123-8123-123456abcdef"
    assert re.fullmatch(U, valid)
    for value in [valid.upper(), valid.replace("-4123-", "-1123-"), valid.replace("-8123-", "-c123-"), valid.replace("-", ""), valid+"\n", " "+valid, "", "seed-review-1"]:
        assert re.fullmatch(U, value) is None


def test_pk4_app_qualified_refs():
    sites = re.findall(r"\b(?:from|join)\s+([a-z_.]+)", RAW, re.I)
    assert sites == ["app.roast_telemetry", "app.cloud_roasts", "app.tasting_reviews", "app.cloud_roasts"]


def test_pk5_domain_and_prefix():
    assert "then 'v1-' || sha2('roastpilot/c9-c3/review-paging-key/v1|' || r.id || '|' || tr.id, 256) else null end as paging_key" in RAW


def test_pk6_hash_input_scoped_pair():
    assert re.search(r"sha2\((.*?), 256\)", RAW)[1] == "'roastpilot/c9-c3/review-paging-key/v1|' || r.id || '|' || tr.id"
