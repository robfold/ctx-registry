-- Whether a library's sections have vectors in Vectorize, so a re-index only
-- deletes vectors that exist (Vectorize rate-limits deletes).
ALTER TABLE libraries ADD COLUMN vectors INTEGER NOT NULL DEFAULT 0;

-- Libraries already searchable when this migration first ran had been indexed with vectors.
UPDATE libraries SET vectors = 1 WHERE ready = 1;
