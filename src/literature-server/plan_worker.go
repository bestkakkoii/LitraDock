package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (s *server) controlPlan(ctx context.Context, library, id, requestID, action string, expected int64) (planReceipt, error) {
	var receipt planReceipt
	if !uuidPattern.MatchString(requestID) || expected < 1 || !slices.Contains([]string{"pause", "resume", "cancel", "retry"}, action) {
		return receipt, &planError{400, "A control requires a request UUID, positive revision and supported action."}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback(context.Background())
	if err = capacityLock(ctx, tx); err != nil {
		return receipt, err
	}
	var revision int64
	if err = tx.QueryRow(ctx, "SELECT revision FROM native_plans WHERE library_id=$1 AND plan_id=$2 FOR UPDATE", library, id).Scan(&revision); err != nil {
		return receipt, err
	}
	var previous string
	var previousRevision int64
	var raw []byte
	err = tx.QueryRow(ctx, "SELECT action,expected_revision,receipt FROM native_plan_commands WHERE library_id=$1 AND plan_id=$2 AND request_id=$3", library, id, requestID).Scan(&previous, &previousRevision, &raw)
	if err == nil {
		if previous != action || previousRevision != expected {
			return receipt, planConflict("Control request ID already has another payload.")
		}
		err = json.Unmarshal(raw, &receipt)
		return receipt, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return receipt, err
	}
	if revision != expected {
		return receipt, planConflict("Plan changed; refresh before choosing a new control.")
	}
	p, _, err := s.loadPlan(ctx, tx, library, id)
	if err != nil {
		return receipt, err
	}
	if !slices.Contains(p.AllowedActions, action) {
		return receipt, planConflict("Control is not currently available for this plan.")
	}
	var commands int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM native_plan_commands").Scan(&commands); err != nil {
		return receipt, err
	}
	if commands >= 2000 {
		return receipt, planConflict("Control history capacity reached; contact the operator.")
	}
	if action == "retry" || action == "resume" {
		block, e := s.planBlock(ctx, tx)
		if e != nil {
			return receipt, e
		}
		if block.BlockedReasonCode != "" {
			return receipt, planConflict(block.Reason)
		}
	}
	children, err := tx.Query(ctx, "SELECT batch_id FROM native_batches WHERE library_id=$1 AND plan_id=$2 ORDER BY batch_id FOR UPDATE", library, id)
	if err != nil {
		return receipt, err
	}
	if _, err = pgx.CollectRows(children, pgx.RowTo[string]); err != nil {
		return receipt, err
	}
	next := "active"
	affected := 0
	switch action {
	case "pause", "cancel":
		next = "paused"
		if action == "cancel" {
			next = "cancelled"
		}
		if _, err = tx.Exec(ctx, `UPDATE native_items i SET state=$3,lease=NULL,lease_until=NULL,reason=$4 FROM native_batches b
 WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND b.library_id=$1 AND b.plan_id=$2 AND i.state IN ('queued','running','paused')`, library, id, next, "Plan "+next+"; prior originals preserved."); err != nil {
			return receipt, err
		}
		if _, err = tx.Exec(ctx, "UPDATE native_batches SET state=$3 WHERE library_id=$1 AND plan_id=$2 AND state IN ('active','paused')", library, id, next); err != nil {
			return receipt, err
		}
		affected = p.Counts["waiting"] + p.Counts["queued"] + p.Counts["running"] + p.Counts["paused"]
		if action == "cancel" {
			if _, err = tx.Exec(ctx, "UPDATE native_plan_items SET cancelled=true WHERE library_id=$1 AND plan_id=$2 AND child_batch_id IS NULL", library, id); err != nil {
				return receipt, err
			}
		}
	case "resume":
		if _, err = tx.Exec(ctx, `UPDATE native_items i SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
 reason=CASE WHEN attempts>=3 THEN 'Attempt limit reached; operator review required.' ELSE 'Plan resumed.' END FROM native_batches b
 WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND b.library_id=$1 AND b.plan_id=$2 AND i.state='paused'`, library, id); err != nil {
			return receipt, err
		}
		if _, err = tx.Exec(ctx, "UPDATE native_batches SET state='active' WHERE library_id=$1 AND plan_id=$2 AND state='paused'", library, id); err != nil {
			return receipt, err
		}
		affected = p.Counts["paused"]
	case "retry":
		var child string
		err = tx.QueryRow(ctx, `SELECT b.batch_id FROM native_batches b JOIN native_items i USING(library_id,batch_id)
 WHERE b.library_id=$1 AND b.plan_id=$2 AND i.state IN ('failed','transient','rate_wait') AND i.attempts<3
 ORDER BY b.created_at,b.batch_id,i.rank LIMIT 1`, library, id).Scan(&child)
		if err != nil {
			return receipt, err
		}
		changed, e := tx.Exec(ctx, `UPDATE native_items SET state='queued',reason='Explicit plan retry requested.'
 WHERE library_id=$1 AND batch_id=$2 AND state IN ('failed','transient','rate_wait') AND attempts<3`, library, child)
		if e != nil {
			return receipt, e
		}
		affected = int(changed.RowsAffected())
		if _, err = tx.Exec(ctx, "UPDATE native_batches SET state='active' WHERE library_id=$1 AND batch_id=$2", library, child); err != nil {
			return receipt, err
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE native_plans SET state=$3,revision=revision+1,updated_at=now() WHERE library_id=$1 AND plan_id=$2", library, id, next); err != nil {
		return receipt, err
	}
	p, _, err = s.loadPlan(ctx, tx, library, id)
	if err != nil {
		return receipt, err
	}
	receipt = planReceipt{PlanID: id, Revision: p.Revision, State: p.State, AffectedCount: affected}
	raw, err = json.Marshal(receipt)
	if err != nil {
		return receipt, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO native_plan_commands VALUES($1,$2,$3,$4,$5,$6)", library, id, requestID, action, expected, raw); err != nil {
		return receipt, err
	}
	return receipt, tx.Commit(ctx)
}

// Called only by the existing single worker while holding its heavy/recovery gate.
func (s *server) admitPlan(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = capacityLock(ctx, tx); err != nil {
		return err
	}
	block, err := s.planBlock(ctx, tx)
	if err != nil {
		return err
	}
	if block.BlockedReasonCode != "" {
		return nil
	}
	var library, plan string
	err = tx.QueryRow(ctx, `SELECT p.library_id::text,p.plan_id FROM native_plans p WHERE p.state='active'
 AND EXISTS(SELECT 1 FROM native_plan_items m WHERE m.library_id=p.library_id AND m.plan_id=p.plan_id AND m.child_batch_id IS NULL AND NOT m.cancelled)
 AND NOT EXISTS(SELECT 1 FROM native_batches b JOIN native_items i USING(library_id,batch_id) WHERE b.library_id=p.library_id AND b.plan_id=p.plan_id AND i.state IN ('queued','running','paused'))
 ORDER BY p.last_scheduled_at NULLS FIRST,p.created_at,p.plan_id FOR UPDATE OF p SKIP LOCKED LIMIT 1`).Scan(&library, &plan)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, "SELECT search_id FROM native_plan_items WHERE library_id=$1 AND plan_id=$2 AND child_batch_id IS NULL AND NOT cancelled ORDER BY rank LIMIT 10", library, plan)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return errors.New("Plan membership changed during admission.")
	}
	batch := newID("BAT-")
	canonical := append([]string{}, ids...)
	slices.Sort(canonical)
	if _, err = tx.Exec(ctx, "INSERT INTO native_batches(library_id,batch_id,request_id,selection,state,plan_id) VALUES($1,$2,$3,$4,'active',$5)", library, batch, newUUID(), strings.Join(canonical, ","), plan); err != nil {
		return err
	}
	for rank, id := range ids {
		if _, err = tx.Exec(ctx, "INSERT INTO native_items(library_id,batch_id,search_id,rank,state) VALUES($1,$2,$3,$4,'queued')", library, batch, id, rank+1); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE native_plan_items SET child_batch_id=$4 WHERE library_id=$1 AND plan_id=$2 AND search_id=$3", library, plan, id, batch); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE native_plans SET revision=revision+1,updated_at=now(),last_scheduled_at=now() WHERE library_id=$1 AND plan_id=$2", library, plan); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *server) claimBatch(ctx context.Context, lease string) (library, batch, id string, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(context.Background())
	if err = capacityLock(ctx, tx); err != nil {
		return
	}
	block, err := s.planBlock(ctx, tx)
	if err != nil {
		return
	}
	var plan string
	err = tx.QueryRow(ctx, `SELECT i.library_id::text,i.batch_id,i.search_id,COALESCE(b.plan_id,'')
 FROM native_items i JOIN native_batches b USING(library_id,batch_id) LEFT JOIN native_plans p ON p.library_id=b.library_id AND p.plan_id=b.plan_id
 WHERE b.state='active' AND i.state='queued' AND i.attempts<3 AND (b.plan_id IS NULL OR (p.state='active' AND $1))
 ORDER BY b.created_at,b.batch_id,i.rank LIMIT 1`, block.BlockedReasonCode == "").Scan(&library, &batch, &id, &plan)
	if err != nil {
		return
	}
	if plan != "" {
		var state string
		err = tx.QueryRow(ctx, "SELECT state FROM native_plans WHERE library_id=$1 AND plan_id=$2 FOR UPDATE", library, plan).Scan(&state)
		if err != nil {
			return
		}
		if state != "active" {
			err = pgx.ErrNoRows
			return
		}
	}
	var state string
	err = tx.QueryRow(ctx, "SELECT state FROM native_batches WHERE library_id=$1 AND batch_id=$2 FOR UPDATE", library, batch).Scan(&state)
	if err != nil {
		return
	}
	_, err = tx.Exec(ctx, "UPDATE native_items SET state='running',attempts=attempts+1,lease=$4,lease_until=now()+interval '120 seconds' WHERE library_id=$1 AND batch_id=$2 AND search_id=$3", library, batch, id, lease)
	if err != nil {
		return
	}
	if err = touchPlan(ctx, tx, library, plan); err != nil {
		return
	}
	err = tx.Commit(ctx)
	return
}

func (s *server) recoverBatchLeases(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = capacityLock(ctx, tx); err != nil {
		return err
	}
	// Recovery is also a lifecycle writer: lock parents and children before items.
	for _, query := range []string{
		`SELECT p.plan_id FROM native_plans p WHERE EXISTS(SELECT 1 FROM native_batches b WHERE b.library_id=p.library_id AND b.plan_id=p.plan_id AND b.state='active') ORDER BY p.library_id,p.plan_id FOR UPDATE`,
		`SELECT batch_id FROM native_batches WHERE state='active' ORDER BY library_id,batch_id FOR UPDATE`,
	} {
		rows, e := tx.Query(ctx, query)
		if e != nil {
			return e
		}
		_, e = pgx.CollectRows(rows, pgx.RowTo[string])
		if e != nil {
			return e
		}
	}
	_, err = tx.Exec(ctx, `WITH changed AS (UPDATE native_items SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
 reason='Interrupted attempt recovered; prior originals preserved.',lease=NULL,lease_until=NULL
 WHERE state='running' AND lease_until<now() RETURNING library_id,batch_id)
 UPDATE native_plans p SET revision=revision+1,updated_at=now() WHERE EXISTS(SELECT 1 FROM changed c JOIN native_batches b USING(library_id,batch_id) WHERE b.library_id=p.library_id AND b.plan_id=p.plan_id)`)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE native_batches b SET state=CASE WHEN EXISTS(SELECT 1 FROM native_items i WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND i.state<>'acquired') THEN 'partial' ELSE 'complete' END
 WHERE b.state='active' AND NOT EXISTS(SELECT 1 FROM native_items i WHERE i.library_id=b.library_id AND i.batch_id=b.batch_id AND i.state IN ('queued','running','paused'))`)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
