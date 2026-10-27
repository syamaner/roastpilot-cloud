-- OWNER-approved staging: identity only; no ordering, payload, notes,
-- reviews, grants or writer in C1. C2 adds ordering under its ratified
-- protocol. No emptiness or deployed-state claim is made.
use schema app;

create table cloud_roast_tombstones (
  cloud_roast_id string not null,
  idempotency_key string not null,
  public_slug string not null
);
