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
    def executable_references(text):
        executable = re.sub(r"(?m)^[ \t]*--[^\n]*", "", text)
        return re.findall(r"\b(?:from|join)\s+([a-z_.]+)", executable, re.I)

    expected = ["app.roast_telemetry", "app.cloud_roasts", "app.tasting_reviews", "app.cloud_roasts"]
    assert executable_references(RAW) == expected
    comments = "-- FROM fake_table\n  -- join is prose\n\t-- JOIN another_fake\n"
    assert executable_references(comments) == []
    assert executable_references(comments + RAW + comments) == expected
    mixed_keywords = RAW.replace("from app.", "FrOm app.").replace("join app.", "JoIn app.")
    assert executable_references(mixed_keywords) == expected
    executable = re.sub(r"(?m)^[ \t]*--[^\n]*", "", RAW)
    sites = list(re.finditer(r"\b(?:from|join)\s+(app\.[a-z_]+)", executable, re.I))
    assert len(sites) == 4
    for site in sites:
        unqualified = executable[:site.start(1)] + site[1][4:] + executable[site.end(1):]
        assert executable_references(unqualified) != expected


def test_pk5_domain_and_prefix():
    assert "then 'v1-' || sha2('roastpilot/c9-c3/review-paging-key/v1|' || r.id || '|' || tr.id, 256) else null end as paging_key" in RAW


def test_pk6_hash_input_scoped_pair():
    assert re.search(r"sha2\((.*?), 256\)", RAW)[1] == "'roastpilot/c9-c3/review-paging-key/v1|' || r.id || '|' || tr.id"
