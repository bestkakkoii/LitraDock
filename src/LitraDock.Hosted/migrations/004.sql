-- 研究決策與取得作業分離；保留不可變事件與輸入版本，不變更既有記錄識別碼。
CREATE TABLE ld_projects (
 library_id uuid NOT NULL REFERENCES ld_libraries(library_id), project_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,project_id)
);
CREATE TABLE ld_reviews (
 library_id uuid NOT NULL, project_id text NOT NULL, search_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('unscreened','included','excluded','uncertain')),
 tags text NOT NULL, note text NOT NULL, reason text NOT NULL, evidence text NOT NULL,
 actor text NOT NULL, revision integer NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,project_id,search_id),
 FOREIGN KEY(library_id,project_id) REFERENCES ld_projects(library_id,project_id),
 FOREIGN KEY(library_id,search_id) REFERENCES ld_records(library_id,search_id)
);
CREATE TABLE ld_review_events (
 library_id uuid NOT NULL, event_id text NOT NULL, project_id text NOT NULL, search_id text NOT NULL,
 revision integer NOT NULL, data text NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,event_id), UNIQUE(library_id,project_id,search_id,revision),
 FOREIGN KEY(library_id,project_id,search_id) REFERENCES ld_reviews(library_id,project_id,search_id)
);
CREATE TABLE ld_conversions (
 library_id uuid NOT NULL, conversion_id text NOT NULL, search_id text NOT NULL,
 input_hash text, input_metadata text NOT NULL, mode text NOT NULL CHECK(mode IN ('original','abstract')),
 state text NOT NULL CHECK(state IN ('queued','running','paused','cancelled','failed','completed')),
 reason text NOT NULL, actor text NOT NULL, attempts integer NOT NULL DEFAULT 0,
 output_hash text, details text NOT NULL DEFAULT '{}', lease_token uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,conversion_id),
 FOREIGN KEY(library_id,search_id) REFERENCES ld_records(library_id,search_id),
 FOREIGN KEY(library_id,input_hash) REFERENCES ld_files(library_id,hash),
 FOREIGN KEY(library_id,output_hash) REFERENCES ld_files(library_id,hash)
);
CREATE INDEX ld_conversion_ready ON ld_conversions(state,created_at);
CREATE TABLE ld_derivations (
 library_id uuid NOT NULL, derivation_id text NOT NULL, search_id text NOT NULL, conversion_id text NOT NULL,
 input_hash text, hash text NOT NULL, kind text NOT NULL CHECK(kind IN ('Formatted Reading Copy','Abstract Only')),
 provenance text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,derivation_id), UNIQUE(library_id,conversion_id),
 FOREIGN KEY(library_id,search_id) REFERENCES ld_records(library_id,search_id),
 FOREIGN KEY(library_id,conversion_id) REFERENCES ld_conversions(library_id,conversion_id),
 FOREIGN KEY(library_id,input_hash) REFERENCES ld_files(library_id,hash),
 FOREIGN KEY(library_id,hash) REFERENCES ld_files(library_id,hash)
);
CREATE TABLE ld_conversion_events (
 library_id uuid NOT NULL, event_id text NOT NULL, conversion_id text NOT NULL, state text NOT NULL,
 reason text NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,event_id), FOREIGN KEY(library_id,conversion_id) REFERENCES ld_conversions(library_id,conversion_id)
);
CREATE TABLE ld_citations (
 library_id uuid NOT NULL, citation_id text NOT NULL, search_id text NOT NULL, data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,citation_id), FOREIGN KEY(library_id,search_id) REFERENCES ld_records(library_id,search_id)
);
INSERT INTO ld_schema VALUES(4,now());
