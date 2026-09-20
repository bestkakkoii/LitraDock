package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const captureMembershipLimit = 20000

// NLM 文件建議每段少於 10,000 筆；實際保留回應也曾將 10,000 調整為 9,999。
// 採保守操作界線，不能把該次單筆回應宣稱為大量來源容量驗證。
const captureProviderBoundary = 9999
const captureRequestLimit = 256

const queryCaptureSchema = `
ALTER TABLE native_search_windows DROP CONSTRAINT native_search_windows_next_offset_check;
ALTER TABLE native_search_windows ADD CONSTRAINT native_search_windows_next_offset_check CHECK(next_offset BETWEEN 0 AND 20000);
CREATE TABLE native_query_captures(
 library_id uuid NOT NULL,run_id text NOT NULL,plan text NOT NULL CHECK(octet_length(plan)<=262144),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(library_id,run_id),FOREIGN KEY(library_id,run_id) REFERENCES native_user_route_runs);
CREATE TABLE native_query_capture_stages(
 library_id uuid NOT NULL,run_id text NOT NULL,attempt_id uuid NOT NULL,segment integer NOT NULL,
 provider_total integer NOT NULL CHECK(provider_total>=0),returned_count integer NOT NULL CHECK(returned_count BETWEEN 0 AND 10000),
 added_count integer NOT NULL CHECK(added_count BETWEEN 0 AND 10000),disposition text NOT NULL,
 translation text NOT NULL CHECK(octet_length(translation)<=262144),received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(library_id,attempt_id),FOREIGN KEY(library_id,run_id) REFERENCES native_query_captures,
 FOREIGN KEY(library_id,attempt_id) REFERENCES native_user_route_attempts);
CREATE TABLE native_query_capture_members(
 library_id uuid NOT NULL,run_id text NOT NULL,pmid text NOT NULL CHECK(pmid ~ '^[0-9]{1,20}$'),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 20000),segment integer NOT NULL CHECK(segment>=0),
 segment_rank integer NOT NULL CHECK(segment_rank BETWEEN 1 AND 10000),attempt_id uuid,
 PRIMARY KEY(library_id,run_id,pmid),UNIQUE(library_id,run_id,ordinal),
 FOREIGN KEY(library_id,run_id) REFERENCES native_query_captures,
 FOREIGN KEY(library_id,attempt_id) REFERENCES native_user_route_attempts);
INSERT INTO native_schema(version) VALUES(11);`

func migrateQueryCapture(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var version int
	if err := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); err != nil {
		return err
	}
	if !rollback {
		if version == 11 {
			return nil
		}
		if version != 10 {
			return errors.New("staged query capture requires schema 10")
		}
		_, err := tx.Exec(ctx, queryCaptureSchema)
		return err
	}
	if version != 11 {
		return errors.New("staged query rollback requires schema 11")
	}
	var used bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM native_query_captures) OR EXISTS(SELECT 1 FROM native_search_windows WHERE next_offset>1000)").Scan(&used); err != nil {
		return err
	}
	if used {
		return errors.New("staged query research exists; retain schema 11 with compatible capture and source admission disabled")
	}
	_, err := tx.Exec(ctx, `DROP TABLE native_query_capture_members,native_query_capture_stages,native_query_captures;
ALTER TABLE native_search_windows DROP CONSTRAINT native_search_windows_next_offset_check;
ALTER TABLE native_search_windows ADD CONSTRAINT native_search_windows_next_offset_check CHECK(next_offset BETWEEN 0 AND 1000);
DELETE FROM native_schema WHERE version=11`)
	return err
}

type captureSegment struct {
	ID    int    `json:"id"`
	Kind  string `json:"kind"`
	Start string `json:"start,omitempty"`
	End   string `json:"end,omitempty"`
}

type queryCapturePlan struct {
	State       string           `json:"state"`
	AnchorDay   string           `json:"anchorDay"`
	NextID      int              `json:"nextID"`
	Frontier    []captureSegment `json:"frontier"`
	Requests    int              `json:"requests"`
	Completed   int              `json:"completed"`
	LatestTotal *int             `json:"latestTotal"`
	Active      bool             `json:"active"`
	Reason      string           `json:"reason"`
}

type queryCaptureView struct {
	Strategy            string `json:"strategy"`
	State               string `json:"state"`
	PendingSegments     int    `json:"pendingSegments"`
	CompletedSegments   int    `json:"completedSegments"`
	Requests            int    `json:"requests"`
	RequestLimit        int    `json:"requestLimit"`
	MembershipLimit     int    `json:"membershipLimit"`
	ProviderBoundary    int    `json:"providerBoundary"`
	LatestProviderTotal *int   `json:"latestProviderTotal"`
	Order               string `json:"order"`
	CanCapture          bool   `json:"canCapture"`
	Reason              string `json:"reason"`
}

func newCapturePlan(now time.Time) *queryCapturePlan {
	return &queryCapturePlan{State: "ready", AnchorDay: now.UTC().Format("2006-01-02"), NextID: 2,
		Frontier: []captureSegment{{ID: 1, Kind: "root"}}, Reason: "Capture is explicit. Existing membership stays saved; later source observations may differ."}
}

func readCapturePlan(ctx context.Context, reader continuationReader, library, run string) (*queryCapturePlan, error) {
	var raw string
	err := reader.QueryRow(ctx, "SELECT plan FROM native_query_captures WHERE library_id=$1 AND run_id=$2", library, run).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var plan queryCapturePlan
	if len(raw) > 262144 || json.Unmarshal([]byte(raw), &plan) != nil || !slices.Contains([]string{"ready", "complete", "limited"}, plan.State) ||
		plan.Requests < 0 || plan.Requests > captureRequestLimit || plan.Completed < 0 || plan.Completed > captureRequestLimit ||
		plan.NextID < 2 || plan.NextID > 1024 || len(plan.Frontier) > captureRequestLimit+1 || (plan.State == "ready" && len(plan.Frontier) == 0) ||
		(plan.State == "complete" && len(plan.Frontier) != 0) || (plan.LatestTotal != nil && *plan.LatestTotal < 0) {
		return nil, errors.New("invalid saved capture plan")
	}
	if _, err = time.Parse("2006-01-02", plan.AnchorDay); err != nil {
		return nil, errors.New("invalid capture anchor date")
	}
	seen := map[int]bool{}
	for _, segment := range plan.Frontier {
		if segment.ID < 1 || segment.ID >= plan.NextID || seen[segment.ID] {
			return nil, errors.New("invalid capture segment identity")
		}
		seen[segment.ID] = true
		if _, err = segmentQuery("validation", segment); err != nil {
			return nil, err
		}
	}
	return &plan, nil
}

func saveCapturePlan(ctx context.Context, tx pgx.Tx, library, run string, plan *queryCapturePlan) error {
	raw, err := json.Marshal(plan)
	if err != nil || len(raw) > 262144 {
		return errors.New("capture plan exceeds its storage bound")
	}
	_, err = tx.Exec(ctx, "UPDATE native_query_captures SET plan=$3 WHERE library_id=$1 AND run_id=$2", library, run, string(raw))
	return err
}

func segmentQuery(query string, segment captureSegment) (string, error) {
	if segment.Kind == "root" {
		if segment.Start != "" || segment.End != "" {
			return "", errors.New("invalid root segment")
		}
		return query, nil
	}
	start, e1 := time.Parse("2006-01-02", segment.Start)
	end, e2 := time.Parse("2006-01-02", segment.End)
	if e1 != nil || e2 != nil || start.After(end) || !slices.Contains([]string{"range", "complement"}, segment.Kind) {
		return "", errors.New("invalid capture date range")
	}
	rangeTerm := start.Format("2006/01/02") + ":" + end.Format("2006/01/02") + "[crdt]"
	op := " AND "
	if segment.Kind == "complement" {
		op = " NOT "
	}
	return "(" + query + ")" + op + "(" + rangeTerm + ")", nil
}

// 日期分割是原始條件與完整日期域的聯集分割。額外保留 NOT 域，不能
// 把不在日期域中的 PMID 靜默排除；分段順序不是全域 Best Match 排名。
func splitCaptureSegment(plan *queryCapturePlan, segment captureSegment) ([]captureSegment, error) {
	if segment.Kind == "root" {
		children := []captureSegment{{ID: plan.NextID, Kind: "range", Start: "1800-01-01", End: plan.AnchorDay}, {ID: plan.NextID + 1, Kind: "complement", Start: "1800-01-01", End: plan.AnchorDay}}
		plan.NextID += 2
		return children, nil
	}
	if segment.Kind != "range" || segment.Start == segment.End {
		return nil, errors.New("This single-day or outside-range segment exceeds the supported 9,999-ID segment limit. Its membership remains unresolved; no partial segment was accepted.")
	}
	start, e1 := time.Parse("2006-01-02", segment.Start)
	end, e2 := time.Parse("2006-01-02", segment.End)
	if e1 != nil || e2 != nil || !start.Before(end) {
		return nil, errors.New("invalid capture split")
	}
	startDay, endDay := start.Unix()/86400, end.Unix()/86400
	mid := time.Unix((startDay+(endDay-startDay)/2)*86400, 0).UTC()
	// 先處理較新的一半；兩個範圍不重疊且其聯集涵蓋完整父範圍。
	children := []captureSegment{{ID: plan.NextID, Kind: "range", Start: mid.AddDate(0, 0, 1).Format("2006-01-02"), End: segment.End}, {ID: plan.NextID + 1, Kind: "range", Start: segment.Start, End: mid.Format("2006-01-02")}}
	plan.NextID += 2
	return children, nil
}

func (s *server) captureView(ctx context.Context, reader continuationReader, library, run string, w *continuationView, frozen bool) (*queryCaptureView, error) {
	if !s.stagedQuery || w.Execution != userRouteExecution {
		return nil, nil
	}
	p, err := readCapturePlan(ctx, reader, library, run)
	if err != nil {
		return nil, err
	}
	v := &queryCaptureView{Strategy: "create_date_v1", State: "not_started", RequestLimit: captureRequestLimit, MembershipLimit: captureMembershipLimit, ProviderBoundary: captureProviderBoundary, Order: "initial_then_segment", Reason: "Capture additional IDs explicitly. Date segments retain the original query; ordering across stages is not global Best Match."}
	v.CanCapture = frozen && w.State != "queued" && w.State != "running" && w.State != "expired" && w.Attempts < 3 && s.cfg.StagedQueryEnabled && s.cfg.UserRouteEnabled && s.cfg.SearchEnabled && s.cfg.SearchContinuationEnabled
	if p != nil {
		v.State, v.PendingSegments, v.CompletedSegments, v.Requests, v.LatestProviderTotal, v.Reason = p.State, len(p.Frontier), p.Completed, p.Requests, p.LatestTotal, p.Reason
		v.CanCapture = v.CanCapture && p.State == "ready" && p.Requests < captureRequestLimit
		w.WindowLimit = captureMembershipLimit
		if p.Active {
			w.CanContinue = false
			w.CanRetry = false
			if w.State != "queued" && w.State != "running" {
				// 僅修正讀取投影；既有中斷憑證與歷史 reason 不回寫或偽造完成。
				w.Reason = "ID capture is unfinished. Saved records and selection remain available; retry this capture explicitly when available."
			}
		}
	}
	return v, nil
}

func (s *server) controlQueryCapture(ctx context.Context, library, run string, a continuationAction) (continuationReceipt, error) {
	out := continuationReceipt{}
	if !s.stagedQuery || !s.userRoute || !runIDPattern.MatchString(run) || !uuidPattern.MatchString(a.RequestID) || a.Revision < 1 || a.Action != "capture" || (a.CredentialMode != "" && !validCredentialMode(a.CredentialMode)) {
		return out, &planError{400, "A browser-owned run, request UUID, revision and capture action are required."}
	}
	intent := fmt.Sprintf("%s:%d:capture:%s", run, a.Revision, a.CredentialMode)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(context.Background())
	if err = capacityLock(ctx, tx); err != nil {
		return out, err
	}
	if err = snapshotAdmission(ctx, tx, library); err != nil {
		return out, err
	}
	if err = retireExpiredUserRouteWork(ctx, tx, s.stagedQuery); err != nil {
		return out, err
	}
	var prior, receipt string
	err = tx.QueryRow(ctx, "SELECT intent,receipt FROM native_search_actions WHERE library_id=$1 AND request_id=$2", library, a.RequestID).Scan(&prior, &receipt)
	if err == nil {
		if prior != intent {
			return out, &planError{409, "Request UUID already belongs to a different action."}
		}
		if json.Unmarshal([]byte(receipt), &out) != nil {
			return out, errors.New("invalid capture action receipt")
		}
		return out, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if !s.cfg.StagedQueryEnabled || !s.cfg.UserRouteEnabled || !s.cfg.SearchEnabled || !s.cfg.SearchContinuationEnabled {
		return out, &planError{409, "Staged capture is disabled; saved work and prior receipts remain available."}
	}
	var job, state, idsRaw, mode string
	var revision, attempts, active, commands int
	var frozen bool
	err = tx.QueryRow(ctx, `SELECT j.job_id,w.state,w.revision,w.attempts,w.frozen,w.ids,u.credential_mode
FROM ld_jobs j JOIN native_search_windows w USING(library_id,run_id) JOIN native_user_route_runs u USING(library_id,run_id)
WHERE j.library_id=$1 AND j.run_id=$2 AND j.kind='browser_search' FOR UPDATE OF j,w`, library, run).Scan(&job, &state, &revision, &attempts, &frozen, &idsRaw, &mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, &planError{404, "Browser-owned saved query not found."}
	}
	if err != nil {
		return out, err
	}
	if revision != a.Revision || !frozen || state == "queued" || state == "running" || state == "expired" || attempts >= 3 || a.CredentialMode != "" && a.CredentialMode != mode {
		return out, &planError{409, "Saved capture state changed or is unavailable; refresh it before acting."}
	}
	if err = tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM ld_jobs WHERE state IN ('queued','running','scheduled')),(SELECT count(*) FROM native_search_actions)").Scan(&active, &commands); err != nil {
		return out, err
	}
	if active >= 20 || commands >= 20000 {
		return out, &planError{409, "Shared request admission is full; no provider request started."}
	}
	p, err := readCapturePlan(ctx, tx, library, run)
	if err != nil {
		return out, err
	}
	if p == nil {
		var ids []string
		if json.Unmarshal([]byte(idsRaw), &ids) != nil || !validWindowIDs(ids) || len(ids) > searchWindowLimit {
			return out, errors.New("invalid initial captured membership")
		}
		p = newCapturePlan(time.Now())
		raw, _ := json.Marshal(p)
		if _, err = tx.Exec(ctx, "INSERT INTO native_query_captures(library_id,run_id,plan) VALUES($1,$2,$3)", library, run, string(raw)); err != nil {
			return out, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO native_query_capture_members(library_id,run_id,pmid,ordinal,segment,segment_rank)
SELECT $1,$2,id,n,0,n FROM unnest($3::text[]) WITH ORDINALITY AS x(id,n)`, library, run, ids); err != nil {
			return out, err
		}
	}
	if p.State != "ready" || len(p.Frontier) == 0 || p.Requests >= captureRequestLimit {
		return out, &planError{409, "Capture is complete or at a supported limit; saved membership remains available."}
	}
	p.Active = true
	if err = saveCapturePlan(ctx, tx, library, run, p); err != nil {
		return out, err
	}
	out = continuationReceipt{run, revision + 1, "queued"}
	if _, err = tx.Exec(ctx, "UPDATE native_search_windows SET state='queued',revision=$3 WHERE library_id=$1 AND run_id=$2", library, run, out.Revision); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, "UPDATE ld_jobs SET state='queued',reason='',lease_token=NULL,lease_until=clock_timestamp()+interval '120 seconds' WHERE library_id=$1 AND job_id=$2", library, job); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, "UPDATE ld_runs SET state='queued',reason='One explicit ID capture stage admitted; existing research is retained.' WHERE library_id=$1 AND run_id=$2", library, run); err != nil {
		return out, err
	}
	raw, _ := json.Marshal(out)
	if _, err = tx.Exec(ctx, "INSERT INTO native_search_actions VALUES($1,$2,$3,$4,$5)", library, a.RequestID, run, intent, string(raw)); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

// 每一段只接受從零開始、身分數完整且警告語意已知的回應。
// 特定 count-clamp 警告不改寫查詢；其他警告可能改變查詢意義，不能默默忽略。
// 原始 bytes 仍由 user-route attempt 保存；既有 10,000 筆歷史列與 descriptor 不重寫。
func parseCaptureSearchMetadata(body []byte, maximum int) (int, []string, string, error) {
	total, ids, translation, err := parseSearchMetadata(body, maximum)
	if err != nil {
		return 0, nil, "", err
	}
	doc, err := parseXML(body)
	if err != nil {
		return 0, nil, "", err
	}
	invalid := func() (int, []string, string, error) {
		return 0, nil, "", &sourceError{"failed", "Unsupported, incomplete or ambiguous PubMed capture response; no membership was appended."}
	}
	if len(doc.all("ErrorList")) > 0 || len(doc.all("ErrorMessage")) > 0 || len(ids) != min(total, maximum) {
		return invalid()
	}
	// 共用 XML 節點的 Text 含子節點文字；依序扣掉子節點，再驗證容器只剩空白。
	// 不修改共用解析器，避免影響既有多語文獻的混合內容保留行為。
	containerOnlyChildren := func(n *node) bool {
		remaining := n.Text
		for _, child := range n.Children {
			position := strings.Index(remaining, child.Text)
			if position < 0 || strings.TrimSpace(remaining[:position]) != "" {
				return false
			}
			remaining = remaining[position+len(child.Text):]
		}
		return strings.TrimSpace(remaining) == ""
	}
	if !containerOnlyChildren(doc) || !containerOnlyChildren(doc.child("IdList")) {
		return invalid()
	}
	if translated := doc.child("QueryTranslation"); translated != nil && len(translated.Children) != 0 {
		return invalid()
	}
	for name, expected := range map[string]int{"RetStart": 0, "RetMax": len(ids)} {
		if len(doc.direct(name)) != 1 || len(doc.child(name).Children) != 0 {
			return invalid()
		}
		value, e := strconv.Atoi(doc.directValue(name))
		if e != nil || value != expected {
			return invalid()
		}
	}
	warnings := doc.all("WarningList")
	if len(warnings) > 0 {
		if len(warnings) != 1 || len(doc.direct("WarningList")) != 1 || len(warnings[0].Children) != 1 || !containerOnlyChildren(warnings[0]) {
			return invalid()
		}
		message := warnings[0].Children[0]
		if message.Name != "OutputMessage" || len(message.Children) != 0 || strings.TrimSpace(message.Text) != "Restrictions achieved. start and count adjusted to 0, 9999" || maximum > captureProviderBoundary {
			return invalid()
		}
	}
	return total, ids, translation, nil
}

func (s *server) finishQueryCapture(ctx context.Context, tx pgx.Tx, library, run, job string, d userRouteDescriptor, body []byte) (continuationReceipt, error) {
	out := continuationReceipt{}
	p, err := readCapturePlan(ctx, tx, library, run)
	if err != nil {
		return out, err
	}
	if p == nil || !p.Active || p.State != "ready" || len(p.Frontier) == 0 || p.Frontier[0].ID != d.CaptureSegment {
		return out, &planError{409, "Capture segment changed; late response refused."}
	}
	segment := p.Frontier[0]
	var input, raw string
	var offset, missing int
	if err = tx.QueryRow(ctx, "SELECT r.input,w.ids,w.next_offset,jsonb_array_length(w.missing::jsonb) FROM ld_runs r JOIN native_search_windows w USING(library_id,run_id) WHERE r.library_id=$1 AND r.run_id=$2", library, run).Scan(&input, &raw, &offset, &missing); err != nil {
		return out, err
	}
	query, err := segmentQuery(normalizedPubMedQuery(input), segment)
	if err != nil || query != d.Parameters["term"] || d.Parameters["retmax"] != fmt.Sprint(captureProviderBoundary) || d.Parameters["retstart"] != "0" || d.Parameters["sort"] != "relevance" {
		return out, errors.New("capture descriptor does not match the saved segment")
	}
	total, ids, translation, err := parseCaptureSearchMetadata(body, captureProviderBoundary)
	if err != nil || total > 2147483647 || len(translation) > 262144 || len(ids) != min(total, captureProviderBoundary) || !validWindowIDs(ids) {
		return out, &planError{400, "Invalid or incomplete capture response; the saved frontier and IDs were not changed."}
	}
	var saved []string
	if json.Unmarshal([]byte(raw), &saved) != nil || !validWindowIDs(saved) {
		return out, errors.New("invalid durable capture membership")
	}
	if segment.Kind == "root" {
		p.LatestTotal = &total
	}
	disposition := "captured"
	added := []string{}
	if total > captureProviderBoundary {
		children, splitErr := splitCaptureSegment(p, segment)
		if splitErr != nil {
			p.State, p.Reason, disposition = "limited", splitErr.Error(), "provider_boundary"
		} else {
			p.Frontier = append(children, p.Frontier[1:]...)
			p.Reason = "This segment exceeds the supported 9,999-ID limit. Its complete date partitions are saved; capture the next stage explicitly."
			disposition = "split"
		}
	} else {
		seen := make(map[string]bool, len(saved))
		for _, id := range saved {
			seen[id] = true
		}
		for _, id := range ids {
			if !seen[id] {
				added = append(added, id)
			}
		}
		if len(saved)+len(added) > captureMembershipLimit {
			p.State, p.Reason, disposition = "limited", "This complete segment would exceed the 20,000-ID saved-run limit. No part of the segment was appended; its response and unresolved coverage remain recorded.", "membership_limit"
			added = nil
		} else {
			newIDs := make(map[string]bool, len(added))
			for _, id := range added {
				newIDs[id] = true
			}
			ordinal := len(saved)
			ordinals, ranks := []int{}, []int{}
			for rank, id := range ids {
				if !newIDs[id] {
					continue
				}
				ordinal++
				ordinals = append(ordinals, ordinal)
				ranks = append(ranks, rank+1)
			}
			if _, err = tx.Exec(ctx, `INSERT INTO native_query_capture_members(library_id,run_id,pmid,ordinal,segment,segment_rank,attempt_id)
SELECT $1,$2,id,n,$3,r,$4 FROM unnest($5::text[],$6::int[],$7::int[]) AS x(id,n,r)`, library, run, segment.ID, d.AttemptID, added, ordinals, ranks); err != nil {
				return out, err
			}
			saved = append(saved, added...)
			p.Frontier = p.Frontier[1:]
			p.Completed++
			p.Reason = "Complete segment IDs saved in capture order. Existing records and choices remain unchanged; source observations can differ across stages."
			if len(p.Frontier) == 0 {
				p.State = "complete"
				p.Reason = "All planned segments were observed. Saved membership is the union of retained observations, not a frozen provider snapshot or global ranking."
			}
		}
	}
	if p.Requests >= captureRequestLimit && p.State == "ready" {
		p.State = "limited"
		p.Reason = "The 256-attempt capture limit was reached. Remaining segments are unresolved and saved research remains available."
	}
	p.Active = false
	if err = saveCapturePlan(ctx, tx, library, run, p); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO native_query_capture_stages(library_id,run_id,attempt_id,segment,provider_total,returned_count,added_count,disposition,translation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", library, run, d.AttemptID, segment.ID, total, len(ids), len(added), disposition, translation); err != nil {
		return out, err
	}
	state := "ready"
	if offset == len(saved) {
		state = "window_limited"
		if p.State == "complete" {
			state = "exhausted"
		}
	}
	out = continuationReceipt{run, d.Revision + 1, state}
	encoded, _ := json.Marshal(saved)
	if _, err = tx.Exec(ctx, "UPDATE native_search_windows SET ids=$3,state=$4,revision=$5,attempts=0 WHERE library_id=$1 AND run_id=$2", library, run, string(encoded), state, out.Revision); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, "UPDATE ld_jobs SET state='completed',reason=$3,lease_token=NULL,lease_until=NULL WHERE library_id=$1 AND job_id=$2", library, job, p.Reason); err != nil {
		return out, err
	}
	// 再次擷取可能只確認既有 ID；若 coverage 與中繼資料都已完成，
	// 不可留下無後續動作可恢復的 partial。缺失資料仍保留 partial。
	runState := "partial"
	if state == "exhausted" && missing == 0 {
		runState = "complete"
	}
	if _, err = tx.Exec(ctx, "UPDATE ld_runs SET state=$3,reason=$4 WHERE library_id=$1 AND run_id=$2", library, run, runState, p.Reason); err != nil {
		return out, err
	}
	return out, nil
}

func capturePlanActive(ctx context.Context, reader continuationReader, enabled bool, library, run string) (bool, error) {
	if !enabled {
		return false, nil
	}
	p, err := readCapturePlan(ctx, reader, library, run)
	return p != nil && p.Active, err
}

func captureMetadataReason(saved, processed, captured, missing int, p *queryCapturePlan) string {
	return fmt.Sprintf("Saved %d unique records; processed %d of %d captured IDs; %d metadata records unavailable. Capture coverage: %s. Existing membership is retained across source observations.", saved, processed, captured, missing, strings.ReplaceAll(p.State, "_", " "))
}

// 擷取耗盡只封住未完成的擷取階段，不應把先前已保存的 ID 中繼資料
// 一起困住。工作/階段鎖由呼叫者持有，來源嘗試紀錄與累計次數不重設。
func settleCaptureCeiling(ctx context.Context, tx pgx.Tx, enabled bool, library, run string) (string, error) {
	if !enabled {
		return "", nil
	}
	p, err := readCapturePlan(ctx, tx, library, run)
	if err != nil || p == nil || !p.Active {
		return "", err
	}
	var attempts, offset int
	var raw string
	if err = tx.QueryRow(ctx, "SELECT attempts,next_offset,ids FROM native_search_windows WHERE library_id=$1 AND run_id=$2", library, run).Scan(&attempts, &offset, &raw); err != nil {
		return "", err
	}
	if attempts < 3 && p.Requests < captureRequestLimit {
		return "", nil
	}
	var ids []string
	if json.Unmarshal([]byte(raw), &ids) != nil || !validWindowIDs(ids) {
		return "", errors.New("invalid captured membership at attempt ceiling")
	}
	p.State, p.Active, p.Reason = "limited", false, "The capture attempt limit was reached. Remaining source coverage is unresolved; previously captured IDs can still be retrieved and exported."
	if err = saveCapturePlan(ctx, tx, library, run, p); err != nil {
		return "", err
	}
	state := "ready"
	if offset == len(ids) {
		state = "window_limited"
	}
	if _, err = tx.Exec(ctx, "UPDATE native_search_windows SET state=$3,attempts=0 WHERE library_id=$1 AND run_id=$2", library, run, state); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, "UPDATE ld_jobs SET state='completed',reason=$3,lease_token=NULL,lease_until=NULL WHERE library_id=$1 AND run_id=$2", library, run, p.Reason); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, "UPDATE ld_runs SET state='partial',reason=$3 WHERE library_id=$1 AND run_id=$2", library, run, p.Reason); err != nil {
		return "", err
	}
	return state, nil
}
