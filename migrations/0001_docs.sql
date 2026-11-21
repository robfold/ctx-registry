-- Server-side docs search: one row per library version, one row per doc chunk,
-- and an FTS5 index over the chunks. `lib` ('L' || library id) lets one MATCH
-- filter a single library without scanning the others.

CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  source TEXT,
  chunks INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL,
  lib TEXT NOT NULL,
  seq INTEGER NOT NULL,
  doc_path TEXT NOT NULL,
  doc_title TEXT NOT NULL,
  section_title TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_by_library ON chunks (library_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  lib, doc_title, section_title, content,
  content = 'chunks', content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_after_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, lib, doc_title, section_title, content)
  VALUES (new.id, new.lib, new.doc_title, new.section_title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_after_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, lib, doc_title, section_title, content)
  VALUES ('delete', old.id, old.lib, old.doc_title, old.section_title, old.content);
END;
