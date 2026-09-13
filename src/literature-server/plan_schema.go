package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

const planSchema = `
CREATE TABLE native_plans(
 library_id uuid NOT NULL REFERENCES ld_libraries, plan_id text NOT NULL, run_id text NOT NULL,
 request_id uuid NOT NULL, selection text NOT NULL, receipt jsonb NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','cancelled')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), last_scheduled_at timestamptz,
 PRIMARY KEY(library_id,plan_id), UNIQUE(library_id,request_id), FOREIGN KEY(library_id,run_id) REFERENCES ld_runs);
ALTER TABLE native_batches ADD COLUMN plan_id text;
ALTER TABLE native_batches ADD CONSTRAINT native_batch_plan FOREIGN KEY(library_id,plan_id) REFERENCES native_plans;
CREATE INDEX native_batch_plan_index ON native_batches(library_id,plan_id);
CREATE TABLE native_plan_items(
 library_id uuid NOT NULL,plan_id text NOT NULL,search_id text NOT NULL,rank integer NOT NULL CHECK(rank BETWEEN 1 AND 100),
 child_batch_id text, cancelled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(library_id,plan_id,search_id),UNIQUE(library_id,plan_id,rank),
 FOREIGN KEY(library_id,plan_id) REFERENCES native_plans,
 FOREIGN KEY(library_id,search_id) REFERENCES ld_records,
 FOREIGN KEY(library_id,child_batch_id,search_id) REFERENCES native_items);
CREATE TABLE native_plan_commands(
 library_id uuid NOT NULL,plan_id text NOT NULL,request_id uuid NOT NULL, action text NOT NULL,
 expected_revision bigint NOT NULL,receipt jsonb NOT NULL,
 PRIMARY KEY(library_id,plan_id,request_id), FOREIGN KEY(library_id,plan_id) REFERENCES native_plans);
INSERT INTO native_schema(version) VALUES(2);
`

func migratePlans(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var version int
	if err := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); err != nil {
		return errors.New("Native schema inspection failed.")
	}
	if !rollback {
		if version == 2 {
			return nil
		}
		if version != 1 {
			return errors.New("Plan migration requires native schema 1.")
		}
		_, err := tx.Exec(ctx, planSchema)
		return err
	}
	if version != 2 {
		return errors.New("Empty-plan rollback requires native schema 2.")
	}
	var occupied bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_plans) OR EXISTS(SELECT 1 FROM native_plan_items)
 OR EXISTS(SELECT 1 FROM native_plan_commands) OR EXISTS(SELECT 1 FROM native_batches WHERE plan_id IS NOT NULL)`).Scan(&occupied); err != nil {
		return err
	}
	if occupied {
		return errors.New("Plan data exists; retain schema 2 and use a compatible binary, without deleting user work.")
	}
	_, err := tx.Exec(ctx, `DROP TABLE native_plan_commands; DROP TABLE native_plan_items;
 ALTER TABLE native_batches DROP CONSTRAINT native_batch_plan; ALTER TABLE native_batches DROP COLUMN plan_id;
 DROP TABLE native_plans; DELETE FROM native_schema WHERE version=2;`)
	return err
}
