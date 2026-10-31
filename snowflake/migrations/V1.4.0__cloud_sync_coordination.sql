-- C9-C2: coordinated ordering, field acknowledgement and permanent tombstones.
use schema app;
create table cloud_sync_coordination (lock_name string not null, write_seq number(38,0) not null);
insert into cloud_sync_coordination (lock_name, write_seq) values ('cloud_sync_writer', 0);
alter table cloud_roast_tombstones add column deletion_write_seq number(38,0);
alter table cloud_roast_tombstones alter column cloud_roast_id drop not null;
create table cloud_roast_field_revisions (cloud_roast_id string not null, field_name string not null, accepted_revision number(38,0) not null, accepted_write_seq number(38,0) not null);
insert into cloud_roast_field_revisions (cloud_roast_id, field_name, accepted_revision, accepted_write_seq) select r.id, f.column1, 0, 0 from cloud_roasts r cross join (values ('operator_rating'), ('operator_notes'), ('contributed_to_learning')) f;
drop procedure if exists delete_roast(string);
