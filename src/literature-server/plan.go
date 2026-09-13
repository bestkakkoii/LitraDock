package main

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var savedIDPattern = regexp.MustCompile(`^LD-[0-9a-f]{32}$`)
var runIDPattern = regexp.MustCompile(`^RUN-[0-9a-f]{32}$`)
var planIDPattern = regexp.MustCompile(`^PLN-[0-9a-f]{32}$`)

type planError struct {
	Status  int
	Message string
}

func (e *planError) Error() string      { return e.Message }
func planConflict(message string) error { return &planError{409, message} }

type planReceipt struct {
	PlanID        string `json:"planID"`
	Revision      int64  `json:"revision"`
	State         string `json:"state"`
	SelectedCount int    `json:"selectedCount,omitempty"`
	AffectedCount int    `json:"affectedCount"`
}
type planAdmission struct {
	AdmittedCount     int        `json:"admittedCount"`
	WaitingCount      int        `json:"waitingCount"`
	BlockedReasonCode string     `json:"blockedReasonCode"`
	Reason            string     `json:"reason"`
	RetryAfter        *time.Time `json:"retryAfter"`
}
type planSummary struct {
	RequestedFormat    string         `json:"requestedFormat"`
	PlanID             string         `json:"planID"`
	RunID              string         `json:"runID"`
	State              string         `json:"state"`
	SelectedCount      int            `json:"selectedCount"`
	CreatedAt          time.Time      `json:"createdAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
	Revision           int64          `json:"revision"`
	AllowedActions     []string       `json:"allowedActions"`
	Counts             map[string]int `json:"counts"`
	Admission          planAdmission  `json:"admission"`
	RetryEligibleCount int            `json:"retryEligibleCount"`
}
type planItem struct {
	MediaType         string         `json:"mediaType"`
	DepositVersion    string         `json:"depositVersion"`
	DepositType       string         `json:"depositType"`
	SearchID          string         `json:"searchID"`
	Rank              int            `json:"rank"`
	ChildBatchID      *string        `json:"childBatchID"`
	Phase             string         `json:"phase"`
	AcquisitionState  *string        `json:"acquisitionState"`
	Reason            string         `json:"reason"`
	Attempts          int            `json:"attempts"`
	RetryEligible     bool           `json:"retryEligible"`
	DownloadAvailable bool           `json:"downloadAvailable"`
	Article           map[string]any `json:"article"`
	OriginalHash      string         `json:"original_hash"`
	Bytes             int            `json:"bytes"`
	RightsURI         string         `json:"rights_uri"`
	SourceURI         string         `json:"source_uri"`
	RepositoryStamp   string         `json:"repository_stamp"`
	Format            string         `json:"format"`
	Version           string         `json:"version"`
	cancelled         bool
	raw               string
}

// All acquisition lifecycle writers use capacity -> parent -> batch -> item order.
func capacityLock(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(724913015)")
	return err
}
func acquisitionCapacity(ctx context.Context, tx pgx.Tx, extra int) error {
	var count, total int64
	err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM native_items)+(SELECT count(*) FROM native_plan_items WHERE child_batch_id IS NULL),
 (SELECT COALESCE(sum(octet_length(content)+octet_length(proof)),0) FROM native_originals)`).Scan(&count, &total)
	if err != nil {
		return err
	}
	if count+int64(extra) > 1000 || total >= 256*1024*1024 {
		return planConflict("Acquisition capacity reached; no partial selection was admitted.")
	}
	return nil
}
func touchPlan(ctx context.Context, tx pgx.Tx, library, plan string) error {
	if plan == "" {
		return nil
	}
	_, err := tx.Exec(ctx, "UPDATE native_plans SET revision=revision+1,updated_at=now() WHERE library_id=$1 AND plan_id=$2", library, plan)
	return err
}
func (s *server) queuePlan(ctx context.Context, library, requestID, run string, selected []string, formats ...string) (planReceipt, error) {
	var receipt planReceipt
	format, fe := requestedFormat(formats)
	if fe != nil {
		return receipt, &planError{400, fe.Error()}
	}
	if !uuidPattern.MatchString(requestID) || !runIDPattern.MatchString(run) || len(selected) < 1 || len(selected) > 100 {
		return receipt, &planError{400, "A plan requires a request UUID, saved run and 1–100 unique saved IDs."}
	}
	ids := append([]string{}, selected...)
	slices.Sort(ids)
	for i, id := range ids {
		if !savedIDPattern.MatchString(id) || i > 0 && ids[i-1] == id {
			return receipt, &planError{400, "Invalid or duplicate saved record ID."}
		}
	}
	selection := run + ":" + strings.Join(ids, ",")
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback(context.Background())
	if err = capacityLock(ctx, tx); err != nil {
		return receipt, err
	}
	var previous, previousFormat string
	var raw []byte
	err = tx.QueryRow(ctx, "SELECT selection,receipt,requested_format FROM native_plans WHERE library_id=$1 AND request_id=$2", library, requestID).Scan(&previous, &raw, &previousFormat)
	if err == nil {
		if previous != selection || previousFormat != format {
			return receipt, planConflict("Request ID already has another selection.")
		}
		err = json.Unmarshal(raw, &receipt)
		return receipt, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return receipt, err
	}
	if format == "pdf" && (!s.cfg.PDFEnabled || !s.cfg.AcquisitionEnabled) {
		return receipt, planConflict("PDF acquisition is disabled by the operator.")
	}
	if !s.cfg.PlanEnabled {
		return receipt, planConflict("New processing plans are disabled by the operator.")
	}
	var saved int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM ld_results WHERE library_id=$1 AND run_id=$2 AND search_id=ANY($3)", library, run, ids).Scan(&saved); err != nil {
		return receipt, err
	}
	if saved != len(ids) {
		return receipt, &planError{404, "Saved selection is unavailable in this library and run."}
	}
	if err = acquisitionCapacity(ctx, tx, len(ids)); err != nil {
		return receipt, err
	}
	receipt = planReceipt{PlanID: newID("PLN-"), Revision: 1, State: "active", SelectedCount: len(ids)}
	raw, err = json.Marshal(receipt)
	if err != nil {
		return receipt, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO native_plans(library_id,plan_id,run_id,request_id,selection,receipt,requested_format) VALUES($1,$2,$3,$4,$5,$6,$7)", library, receipt.PlanID, run, requestID, selection, raw, format); err != nil {
		return receipt, err
	}
	for rank, id := range selected {
		if _, err = tx.Exec(ctx, "INSERT INTO native_plan_items(library_id,plan_id,search_id,rank) VALUES($1,$2,$3,$4)", library, receipt.PlanID, id, rank+1); err != nil {
			return receipt, err
		}
	}
	return receipt, tx.Commit(ctx)
}

func planPhase(parent string, child *string, cancelled bool) (string, error) {
	if child == nil {
		if cancelled || parent == "cancelled" {
			return "cancelled", nil
		}
		if parent == "paused" {
			return "paused", nil
		}
		return "waiting", nil
	}
	switch *child {
	case "queued", "running", "paused", "cancelled":
		return *child, nil
	case "acquired":
		return "completed", nil
	case "unavailable", "unsupported":
		return "held", nil
	case "failed", "transient", "rate_wait":
		return "retry", nil
	}
	return "", errors.New("Unknown persisted acquisition state.")
}
func (s *server) loadPlan(ctx context.Context, tx pgx.Tx, library, id string) (planSummary, []planItem, error) {
	p := planSummary{Counts: map[string]int{"waiting": 0, "queued": 0, "running": 0, "completed": 0, "held": 0, "retry": 0, "paused": 0, "cancelled": 0}, AllowedActions: []string{}}
	err := tx.QueryRow(ctx, "SELECT plan_id,run_id,state,revision,created_at,updated_at,requested_format FROM native_plans WHERE library_id=$1 AND plan_id=$2", library, id).Scan(&p.PlanID, &p.RunID, &p.State, &p.Revision, &p.CreatedAt, &p.UpdatedAt, &p.RequestedFormat)
	if err != nil {
		return p, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT m.search_id,m.rank,m.child_batch_id,m.cancelled,i.state,COALESCE(i.reason,''),COALESCE(i.attempts,0),COALESCE(i.original_hash,''),r.metadata
 FROM native_plan_items m JOIN ld_records r USING(library_id,search_id)
 LEFT JOIN native_items i ON i.library_id=m.library_id AND i.batch_id=m.child_batch_id AND i.search_id=m.search_id
 WHERE m.library_id=$1 AND m.plan_id=$2 ORDER BY m.rank`, library, id)
	if err != nil {
		return p, nil, err
	}
	items := []planItem{}
	for rows.Next() {
		var i planItem
		err = rows.Scan(&i.SearchID, &i.Rank, &i.ChildBatchID, &i.cancelled, &i.AcquisitionState, &i.Reason, &i.Attempts, &i.OriginalHash, &i.raw)
		if err != nil {
			break
		}
		items = append(items, i)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return p, nil, err
	}
	if len(items) < 1 || len(items) > 100 {
		return p, nil, errors.New("Invalid persisted plan membership.")
	}
	for n := range items {
		i := &items[n]
		if i.ChildBatchID != nil && i.AcquisitionState == nil {
			return p, nil, errors.New("Missing child item.")
		}
		i.Phase, err = planPhase(p.State, i.AcquisitionState, i.cancelled)
		if err != nil {
			return p, nil, err
		}
		p.Counts[i.Phase]++
		if i.ChildBatchID != nil {
			p.Admission.AdmittedCount++
		} else if !i.cancelled {
			p.Admission.WaitingCount++
		}
		if i.Phase == "retry" && i.Attempts < 3 && p.State == "active" {
			i.RetryEligible = true
			p.RetryEligibleCount++
		}
		if i.ChildBatchID == nil {
			i.Reason = "Waiting for bounded child admission."
			if i.Phase == "paused" {
				i.Reason = "Plan paused before child admission."
			}
			if i.Phase == "cancelled" {
				i.Reason = "Plan cancelled before child admission."
			}
		}
	}
	p.SelectedCount = len(items)
	if p.State == "active" {
		if p.Counts["completed"] == len(items) {
			p.State = "complete"
		} else if p.Counts["waiting"]+p.Counts["queued"]+p.Counts["running"]+p.Counts["paused"] == 0 {
			p.State = "partial"
		}
	}
	switch p.State {
	case "active":
		p.AllowedActions = []string{"pause", "cancel"}
	case "paused":
		p.AllowedActions = []string{"cancel"}
		if s.cfg.PlanEnabled {
			p.AllowedActions = append(p.AllowedActions, "resume")
		}
	case "partial":
		p.AllowedActions = []string{"cancel"}
	}
	if s.cfg.PlanEnabled && p.RetryEligibleCount > 0 && p.Counts["queued"]+p.Counts["running"]+p.Counts["paused"] == 0 {
		p.AllowedActions = append(p.AllowedActions, "retry")
	}
	return p, items, nil
}

// This read never reserves a request or changes cooldown. request remains the final serialized check.
func (s *server) planBlock(ctx context.Context, tx pgx.Tx) (planAdmission, error) {
	a := planAdmission{}
	if !s.cfg.PlanEnabled || !s.cfg.AcquisitionEnabled {
		a.BlockedReasonCode = "policy_disabled"
		a.Reason = "Plan processing or acquisition is disabled by the operator."
		return a, nil
	}
	var next time.Time
	var used, total int64
	err := tx.QueryRow(ctx, `SELECT next_at,(SELECT COALESCE(sum(requests),0) FROM ld_source_usage WHERE provider='ncbi'),
 (SELECT COALESCE(sum(octet_length(content)+octet_length(proof)),0) FROM native_originals) FROM ld_source_budget WHERE name='ncbi'`).Scan(&next, &used, &total)
	if err != nil {
		return a, err
	}
	if total >= 256*1024*1024 {
		a.BlockedReasonCode = "storage_capacity"
		a.Reason = "Original storage capacity reached; contact the operator."
		return a, nil
	}
	if used >= 250 {
		a.BlockedReasonCode = "source_lifetime_budget"
		a.Reason = "Source lifetime allowance reached; contact the operator."
		return a, nil
	}
	if next.After(time.Now()) {
		a.BlockedReasonCode = "source_cooldown"
		a.Reason = "Source cooldown is active; saved work remains queued."
		a.RetryAfter = &next
		return a, nil
	}
	eastern, err := time.LoadLocation("America/New_York")
	if err != nil {
		return a, err
	}
	local := time.Now().In(eastern)
	if local.Weekday() >= time.Monday && local.Weekday() <= time.Friday && local.Hour() >= 5 && local.Hour() < 21 {
		var day int
		err = tx.QueryRow(ctx, "SELECT COALESCE(sum(requests),0) FROM ld_source_usage WHERE provider='ncbi' AND day=$1", local.Format("2006-01-02")).Scan(&day)
		if err != nil {
			return a, err
		}
		if day >= 100 {
			until := time.Date(local.Year(), local.Month(), local.Day(), 21, 0, 0, 0, eastern)
			a.BlockedReasonCode = "source_day_budget"
			a.Reason = "Source daytime allowance reached; waiting until 21:00 US Eastern."
			a.RetryAfter = &until
		}
	}
	return a, nil
}

func (s *server) planDetail(ctx context.Context, library, id string, offset, limit int) (any, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	p, items, err := s.loadPlan(ctx, tx, library, id)
	if err != nil {
		return nil, err
	}
	block, err := s.planBlock(ctx, tx)
	if err != nil {
		return nil, err
	}
	p.Admission.BlockedReasonCode = block.BlockedReasonCode
	p.Admission.Reason = block.Reason
	p.Admission.RetryAfter = block.RetryAfter
	if offset > len(items) {
		offset = len(items)
	}
	end := min(offset+limit, len(items))
	page := items[offset:end]
	for n := range page {
		i := &page[n]
		if json.Unmarshal([]byte(i.raw), &i.Article) != nil {
			return nil, errors.New("Invalid saved metadata.")
		}
		links(i.Article)
		if i.AcquisitionState != nil && *i.AcquisitionState == "acquired" {
			var b, proof []byte
			var format string
			err = tx.QueryRow(ctx, "SELECT content,rights_uri,source_uri,repository_stamp,format,proof FROM native_originals WHERE library_id=$1 AND search_id=$2 AND hash=$3", library, i.SearchID, i.OriginalHash).Scan(&b, &i.RightsURI, &i.SourceURI, &i.RepositoryStamp, &format, &proof)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
			i.Bytes = len(b)
			info, e := validateStored(b, proof, format, i.Article)
			if e == nil {
				i.Format = info.Format
				i.MediaType = info.MediaType
				i.Version = info.Version
				i.DepositVersion = info.DepositVersion
				i.DepositType = info.DepositType
			}
			i.DownloadAvailable = err == nil && e == nil && info.Hash == i.OriginalHash && s.cfg.AcquisitionEnabled && (format != "pdf" || s.cfg.PDFEnabled) && !slices.Contains(s.cfg.BlockedPMCIDs, articleString(i.Article, "Pmcid"))
			if !i.DownloadAvailable {
				i.Reason = "Historical original retained; current policy or integrity prevents Save. Open source links."
			}
		}
	}
	return map[string]any{"plan": p, "items": page, "total": len(items), "offset": offset, "limit": limit, "nextPollAfterMs": 2000, "policy": formatPolicy(p.RequestedFormat)}, tx.Commit(ctx)
}
func (s *server) listPlans(ctx context.Context, library string, offset, limit int) (any, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	var total int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM native_plans WHERE library_id=$1", library).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, "SELECT plan_id FROM native_plans WHERE library_id=$1 ORDER BY created_at,plan_id LIMIT $2 OFFSET $3", library, limit, offset)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	plans := []planSummary{}
	for _, id := range ids {
		p, _, err := s.loadPlan(ctx, tx, library, id)
		if err != nil {
			return nil, err
		}
		plans = append(plans, p)
	}
	return map[string]any{"plans": plans, "total": total, "offset": offset, "limit": limit}, tx.Commit(ctx)
}
