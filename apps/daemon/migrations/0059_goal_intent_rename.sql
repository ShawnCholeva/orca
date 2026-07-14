-- Rename the goal prose column: optional description -> required intent.
-- The NOT-NULL requirement is enforced at creation time in application code;
-- existing rows keep their (possibly empty) values.
ALTER TABLE goals RENAME COLUMN description TO intent;
