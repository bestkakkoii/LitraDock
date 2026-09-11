-- 新增關聯證據與手動原始檔輸入；保留既有表格欄位順序和所有永久識別碼。
CREATE TABLE ld_manual_inputs(library_id uuid NOT NULL,job_id text NOT NULL,stage_token text NOT NULL,hash text NOT NULL,kind text NOT NULL,provenance text NOT NULL,PRIMARY KEY(library_id,job_id),FOREIGN KEY(library_id,job_id) REFERENCES ld_jobs);
CREATE TABLE ld_object_provenance(library_id uuid NOT NULL,job_id text NOT NULL,search_id text NOT NULL,hash text NOT NULL,details text NOT NULL,PRIMARY KEY(library_id,job_id),FOREIGN KEY(library_id,job_id) REFERENCES ld_jobs,FOREIGN KEY(library_id,search_id,hash) REFERENCES ld_article_files);
CREATE INDEX ld_provenance_record ON ld_object_provenance(library_id,search_id);
CREATE TABLE ld_source_usage(provider text NOT NULL,day text NOT NULL,requests integer NOT NULL,PRIMARY KEY(provider,day));
INSERT INTO ld_schema(version) VALUES(2);
