package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *server) queueBatch(ctx context.Context, library, requestID string, selected []string, formats ...string) (string, error) {
	format, err := requestedFormat(formats)
	if err != nil {
		return "", err
	}
	if !uuidPattern.MatchString(requestID) || len(selected) < 1 || len(selected) > 10 {
		return "", errors.New("batch requires request UUID and1–10 saved record IDs")
	}
	ids := append([]string{}, selected...)
	slices.Sort(ids)
	for i, id := range ids {
		if !strings.HasPrefix(id, "LD-") || len(id) != 35 || i > 0 && ids[i-1] == id {
			return "", errors.New("invalid or duplicate selection")
		}
	}
	selection := strings.Join(ids, ",")
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(724913015)"); e != nil {
		return "", e
	}
	var previous, previousSelection, previousFormat string
	e = tx.QueryRow(ctx, "SELECT batch_id,selection,requested_format FROM native_batches WHERE library_id=$1 AND request_id=$2", library, requestID).Scan(&previous, &previousSelection, &previousFormat)
	if e == nil {
		if selection != previousSelection || format != previousFormat {
			return "", errors.New("request ID already has another selection")
		}
		return previous, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return "", e
	}
	if format == "pdf" && (!s.cfg.PDFEnabled || !s.cfg.AcquisitionEnabled) {
		return "", errors.New("PDF acquisition is disabled by the operator")
	}
	if e = acquisitionCapacity(ctx, tx, len(ids)); e != nil {
		return "", e
	}
	var saved int
	e = tx.QueryRow(ctx, "SELECT count(*) FROM ld_records WHERE library_id=$1 AND search_id=ANY($2)", library, ids).Scan(&saved)
	if e != nil || saved != len(ids) {
		return "", errors.New("selection includes unavailable records")
	}
	batch := newID("BAT-")
	if _, e = tx.Exec(ctx, "INSERT INTO native_batches(library_id,batch_id,request_id,selection,state,requested_format) VALUES($1,$2,$3,$4,'active',$5)", library, batch, requestID, selection, format); e != nil {
		return "", e
	}
	for i, id := range ids {
		if _, e = tx.Exec(ctx, "INSERT INTO native_items(library_id,batch_id,search_id,rank,state) VALUES($1,$2,$3,$4,'queued')", library, batch, id, i+1); e != nil {
			return "", e
		}
	}
	return batch, tx.Commit(ctx)
}
func (s *server) controlBatch(ctx context.Context, library, batch, action string) error {
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	if e = capacityLock(ctx, tx); e != nil {
		return e
	}
	var plan string
	if e = tx.QueryRow(ctx, "SELECT COALESCE(plan_id,'') FROM native_batches WHERE library_id=$1 AND batch_id=$2", library, batch).Scan(&plan); e != nil {
		return e
	}
	if plan != "" {
		return errors.New("This batch belongs to a processing plan; use the plan controls.")
	}
	var state string
	if e = tx.QueryRow(ctx, "SELECT state FROM native_batches WHERE library_id=$1 AND batch_id=$2 FOR UPDATE", library, batch).Scan(&state); e != nil {
		return e
	}
	switch action {
	case "pause", "cancel":
		next := "paused"
		if action == "cancel" {
			next = "cancelled"
		}
		if _, e = tx.Exec(ctx, "UPDATE native_batches SET state=$3 WHERE library_id=$1 AND batch_id=$2", library, batch, next); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "UPDATE native_items SET state=$3,lease=NULL,lease_until=NULL,reason=$4 WHERE library_id=$1 AND batch_id=$2 AND state IN ('queued','running','paused')", library, batch, next, "Acquisition "+next+"; prior originals preserved.")
	case "resume":
		if state != "paused" {
			return errors.New("only paused batches can resume")
		}
		_, e = tx.Exec(ctx, "UPDATE native_batches SET state='active' WHERE library_id=$1 AND batch_id=$2;", library, batch)
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE native_items SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END WHERE library_id=$1 AND batch_id=$2 AND state='paused'", library, batch)
		}
	case "retry":
		if state == "cancelled" || state == "paused" {
			return errors.New("cancelled or paused batch cannot retry")
		}
		_, e = tx.Exec(ctx, "UPDATE native_items SET state='queued',reason='Explicit retry requested.' WHERE library_id=$1 AND batch_id=$2 AND attempts<3 AND state IN ('failed','transient','rate_wait')", library, batch)
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE native_batches SET state='active' WHERE library_id=$1 AND batch_id=$2", library, batch)
		}
	default:
		return errors.New("supported control: pause, resume, cancel, retry")
	}
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (s *server) batchDetail(ctx context.Context, library, batch string) (any, error) {
	batches, e := s.rows(ctx, "SELECT batch_id,state,created_at,plan_id,requested_format FROM native_batches WHERE library_id=$1 AND batch_id=$2", library, batch)
	if e != nil {
		return nil, e
	}
	if len(batches) != 1 {
		return nil, pgx.ErrNoRows
	}
	items, e := s.rows(ctx, `SELECT i.search_id,i.rank,i.state,i.reason,i.attempts,i.original_hash,r.metadata,
 COALESCE(o.rights_uri,'') AS rights_uri,COALESCE(o.repository_stamp,'') AS repository_stamp,
 COALESCE(o.source_uri,'') AS source_uri,COALESCE(octet_length(o.content),0) AS bytes
 FROM native_items i JOIN ld_records r USING(library_id,search_id)
 LEFT JOIN native_originals o ON o.library_id=i.library_id AND o.search_id=i.search_id AND o.hash=i.original_hash
 WHERE i.library_id=$1 AND i.batch_id=$2 ORDER BY rank`, library, batch)
	if e != nil {
		return nil, e
	}
	counts := map[string]int{}
	for _, item := range items {
		state := item["state"].(string)
		var a map[string]any
		if json.Unmarshal([]byte(item["metadata"].(string)), &a) != nil {
			return nil, errors.New("stored metadata invalid")
		}
		links(a)
		item["article"] = a
		delete(item, "metadata")
		item["acquisitionState"] = state
		item["downloadAvailable"] = false
		item["format"] = ""
		item["mediaType"] = ""
		item["version"] = ""
		item["depositVersion"] = ""
		item["depositType"] = ""
		if state == "acquired" {
			hash, _ := item["original_hash"].(string)
			if _, info, err := s.original(ctx, library, item["search_id"].(string), hash); err != nil {
				state = "unavailable"
				item["reason"] = "Stored original retained; current policy or integrity check prevents download. Open source links."
			} else {
				item["downloadAvailable"] = true
				item["format"] = info.Format
				item["mediaType"] = info.MediaType
				item["version"] = info.Version
				item["depositVersion"] = info.DepositVersion
				item["depositType"] = info.DepositType
			}
		}
		item["state"] = state
		counts[state]++
	}
	return map[string]any{"requestedFormat": batches[0]["requested_format"], "batch": batches[0], "items": items, "total": len(items), "counts": counts, "policy": formatPolicy(batches[0]["requested_format"].(string))}, nil
}
func (s *server) batchOne(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()
	gate, e := s.db.Acquire(ctx)
	if e != nil {
		return
	}
	defer gate.Release()
	defer func() {
		c, done := context.WithTimeout(context.Background(), 2*time.Second)
		defer done()
		if _, e := gate.Exec(c, "SELECT pg_advisory_unlock_all()"); e != nil {
			_ = gate.Conn().Close(c)
		}
	}()
	var shared, heavy bool
	if gate.QueryRow(ctx, "SELECT pg_try_advisory_lock_shared(724913010),pg_try_advisory_lock(724913011)").Scan(&shared, &heavy) != nil || !shared || !heavy {
		return
	}
	var blocked bool
	if gate.QueryRow(ctx, "SELECT required FROM ld_recovery_guard WHERE singleton").Scan(&blocked) != nil || blocked {
		return
	}
	if e = s.recoverBatchLeases(ctx); e != nil {
		return
	}
	if e = s.admitPlan(ctx); e != nil {
		return
	}
	lease := newUUID()
	library, batch, id, e := s.claimBatch(ctx, lease)
	if e != nil {
		return
	}
	var raw string
	e = s.db.QueryRow(ctx, "SELECT metadata FROM ld_records WHERE library_id=$1 AND search_id=$2", library, id).Scan(&raw)
	var article map[string]any
	if e == nil {
		e = json.Unmarshal([]byte(raw), &article)
	}
	var data, proof []byte
	var format string
	if e == nil {
		e = s.db.QueryRow(ctx, "SELECT requested_format FROM native_batches WHERE library_id=$1 AND batch_id=$2", library, batch).Scan(&format)
	}
	if e == nil && format == "pdf" && !s.cfg.PDFEnabled {
		e = pdfHeld("PDF acquisition is disabled by the operator.")
	}
	var info originalInfo
	if e == nil && slices.Contains(s.cfg.BlockedPMCIDs, articleString(article, "Pmcid")) {
		e = &sourceError{"unavailable", "Operator source restriction: article rights need clarification; open source links."}
	}
	if e == nil && !s.cfg.AcquisitionEnabled {
		e = &sourceError{"unavailable", "Acquisition is disabled by the operator; preserved files are not deleted."}
	}
	if e == nil {
		// Reuse only after validating the complete bytes and current identity/rights policy.
		reuse := s.db.QueryRow(ctx, "SELECT content,proof FROM native_originals WHERE library_id=$1 AND search_id=$2 AND format=$3 ORDER BY acquired_at DESC LIMIT 1", library, id, format).Scan(&data, &proof)
		if reuse == nil {
			info, e = validateStored(data, proof, format, article)
		} else if !errors.Is(reuse, pgx.ErrNoRows) {
			e = reuse
		} else if format == "pdf" {
			data, info, e = s.acquirePDF(ctx, article)
		} else {
			var qErr error
			q, qErr := pmcQuery(article)
			e = qErr
			if e == nil {
				data, e = s.request(ctx, "pmc-oai", q)
			}
			if e == nil {
				info, e = validateOriginal(data, article)
			}
		}
	}
	state, reason := "acquired", "Original "+strings.ToUpper(format)+" acquired on server; use Save to download to your device."
	if e != nil {
		state, reason = "failed", "Acquisition failed; no original accepted."
		var se *sourceError
		if errors.As(e, &se) {
			state, reason = se.State, se.Reason
		}
		if parent.Err() != nil {
			state, reason = "queued", "Interrupted; unfinished work retained for restart."
		}
	}
	finish, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	tx, e := s.db.Begin(finish)
	if e != nil {
		return
	}
	defer tx.Rollback(context.Background())
	if e = capacityLock(finish, tx); e != nil {
		return
	}
	var plan string
	if e = tx.QueryRow(finish, "SELECT COALESCE(plan_id,'') FROM native_batches WHERE library_id=$1 AND batch_id=$2", library, batch).Scan(&plan); e != nil {
		return
	}
	if plan != "" {
		var parentState string
		if e = tx.QueryRow(finish, "SELECT state FROM native_plans WHERE library_id=$1 AND plan_id=$2 FOR UPDATE", library, plan).Scan(&parentState); e != nil || parentState != "active" || !s.cfg.PlanEnabled {
			return
		}
	}
	var batchState, itemState, token string
	if e = tx.QueryRow(finish, "SELECT state FROM native_batches WHERE library_id=$1 AND batch_id=$2 FOR UPDATE", library, batch).Scan(&batchState); e != nil {
		return
	}
	if e = tx.QueryRow(finish, "SELECT state,COALESCE(lease::text,'') FROM native_items WHERE library_id=$1 AND batch_id=$2 AND search_id=$3 FOR UPDATE", library, batch, id).Scan(&itemState, &token); e != nil || batchState != "active" || itemState != "running" || token != lease {
		return
	}
	var hash any
	if state == "acquired" {
		var total int64
		if tx.QueryRow(finish, "SELECT COALESCE(sum(octet_length(content)+octet_length(proof)),0) FROM native_originals").Scan(&total) != nil {
			return
		}
		var present bool
		if tx.QueryRow(finish, "SELECT EXISTS(SELECT 1 FROM native_originals WHERE library_id=$1 AND search_id=$2 AND hash=$3)", library, id, info.Hash).Scan(&present) != nil {
			return
		}
		added := int64(len(data) + len(info.Proof))
		if present {
			added = 0
		}
		if total+added > 256*1024*1024 {
			state, reason = "failed", "Original storage capacity reached; no partial original saved."
		} else {
			_, e = tx.Exec(finish, `INSERT INTO native_originals(library_id,search_id,hash,content,source_uri,rights_uri,repository_stamp,policy,format,proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, library, id, info.Hash, data, info.Source, info.Rights, info.Stamp, formatPolicy(format), format, nonNilBytes(info.Proof))
			if e != nil {
				return
			}
			hash = info.Hash
		}
	}
	_, e = tx.Exec(finish, "UPDATE native_items SET state=$4,reason=$5,original_hash=$6,lease=NULL,lease_until=NULL WHERE library_id=$1 AND batch_id=$2 AND search_id=$3", library, batch, id, state, reason, hash)
	if e != nil {
		return
	}
	var pending, ok, total int
	if tx.QueryRow(finish, "SELECT count(*) FILTER(WHERE state IN ('queued','running','paused')),count(*) FILTER(WHERE state='acquired'),count(*) FROM native_items WHERE library_id=$1 AND batch_id=$2", library, batch).Scan(&pending, &ok, &total) != nil {
		return
	}
	if pending == 0 {
		final := "partial"
		if ok == total {
			final = "complete"
		}
		if _, e = tx.Exec(finish, "UPDATE native_batches SET state=$3 WHERE library_id=$1 AND batch_id=$2", library, batch, final); e != nil {
			return
		}
	}
	if e = touchPlan(finish, tx, library, plan); e != nil {
		return
	}
	_ = tx.Commit(finish)
}

func (s *server) original(ctx context.Context, library, id, hash string) ([]byte, originalInfo, error) {
	var info originalInfo
	if !s.cfg.AcquisitionEnabled {
		return nil, info, errors.New("current acquisition policy disabled")
	}
	if len(hash) != 64 {
		return nil, info, errors.New("invalid hash")
	}
	var b, proof []byte
	var raw, format string
	e := s.db.QueryRow(ctx, "SELECT o.content,r.metadata,o.format,o.proof FROM native_originals o JOIN ld_records r USING(library_id,search_id) WHERE o.library_id=$1 AND o.search_id=$2 AND o.hash=$3", library, id, hash).Scan(&b, &raw, &format, &proof)
	if e != nil {
		return nil, info, e
	}
	var a map[string]any
	if json.Unmarshal([]byte(raw), &a) != nil {
		return nil, info, errors.New("invalid metadata")
	}
	if slices.Contains(s.cfg.BlockedPMCIDs, articleString(a, "Pmcid")) {
		return nil, info, errors.New("operator source restriction")
	}
	if format == "pdf" && !s.cfg.PDFEnabled {
		return nil, info, errors.New("PDF policy disabled")
	}
	info, e = validateStored(b, proof, format, a)
	if e != nil || info.Hash != hash {
		return nil, info, fmt.Errorf("original hash or current policy validation failed")
	}
	return b, info, nil
}
