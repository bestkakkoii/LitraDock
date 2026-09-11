-- 自動續傳與健康證據獨立於既有識別碼；暫停是明確使用者狀態。
CREATE TABLE ld_retry(library_id uuid NOT NULL,job_id text NOT NULL,next_at timestamptz NOT NULL,first_at timestamptz NOT NULL,number integer NOT NULL,category text NOT NULL,status text NOT NULL,successor_job text,PRIMARY KEY(library_id,job_id),FOREIGN KEY(library_id,job_id) REFERENCES ld_jobs);
CREATE INDEX ld_retry_due ON ld_retry(status,next_at);
CREATE TABLE ld_health(library_id uuid NOT NULL REFERENCES ld_libraries,path text NOT NULL,state text NOT NULL,expected_hash text,actual_hash text,bytes bigint,checked_at timestamptz NOT NULL,reason text NOT NULL,PRIMARY KEY(library_id,path));
CREATE TABLE ld_transfers(transfer_id uuid PRIMARY KEY,library_id uuid NOT NULL REFERENCES ld_libraries,origin_library uuid NOT NULL,state text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ld_recovery_guard(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),required boolean NOT NULL);
INSERT INTO ld_recovery_guard VALUES(true,false);
INSERT INTO ld_schema(version) VALUES(3);
