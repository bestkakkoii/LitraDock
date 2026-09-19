package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Closed synthetic transaction transport distinguishes operational Scan/Rows
// failures from malformed persisted data; it never opens a database connection.
type exportFaultTx struct {
	pgx.Tx
	stage   string
	failure error
	scan    bool
}
type exportFaultRow struct {
	values  []any
	failure error
}

func (r exportFaultRow) Scan(dest ...any) error {
	if r.failure != nil {
		return r.failure
	}
	for i, v := range r.values {
		target := reflect.ValueOf(dest[i]).Elem()
		if v == nil {
			target.SetZero()
		} else {
			target.Set(reflect.ValueOf(v))
		}
	}
	return nil
}

type exportFaultRows struct {
	pgx.Rows
	row       exportFaultRow
	delivered bool
	failure   error
	scan      bool
}

func (r *exportFaultRows) Next() bool {
	if r.delivered || r.failure != nil && !r.scan {
		return false
	}
	r.delivered = true
	return true
}
func (r *exportFaultRows) Scan(dest ...any) error {
	if r.scan {
		return r.failure
	}
	return r.row.Scan(dest...)
}
func (r *exportFaultRows) Close()     {}
func (r *exportFaultRows) Err() error { return r.failure }
func (t exportFaultTx) QueryRow(_ context.Context, q string, _ ...any) pgx.Row {
	if strings.Contains(q, "SELECT requested_format") {
		return exportFaultRow{values: []any{"pdf"}}
	}
	if strings.Contains(q, "count(*)") {
		return exportFaultRow{values: []any{1, int64(40)}}
	}
	if t.stage == "querybytes" {
		return exportFaultRow{failure: t.failure}
	}
	return exportFaultRow{values: []any{int64(20)}}
}
func (t exportFaultTx) Query(_ context.Context, q string, _ ...any) (pgx.Rows, error) {
	stage := "metadata"
	values := []any{"LD-synthetic", `{"SearchId":"LD-synthetic","Title":"SYNTHETIC"}`, "acquired", ""}
	if strings.HasPrefix(q, "SELECT run_id,search_id") {
		stage = "association"
		values = []any{"RUN-synthetic", "LD-synthetic"}
	}
	if strings.HasPrefix(q, "SELECT run_id,input") {
		stage = "queries"
		values = []any{"RUN-synthetic", "SYNTHETIC", "partial", "cap", 25001, 1, 1, nil, "{}"}
	}
	if strings.HasPrefix(q, "SELECT search_id,hash") {
		stage = "originals"
		values = nil
	}
	r := &exportFaultRows{row: exportFaultRow{values: values}}
	if stage == t.stage {
		r.failure = t.failure
		r.scan = t.scan
	} else if values == nil {
		r.delivered = true
	}
	return r, nil
}
func TestStructuredOperationalErrorsRetainIdentity(t *testing.T) {
	for _, stage := range []string{"metadata", "association", "querybytes", "queries", "originals"} {
		for _, scan := range []bool{false, true} {
			t.Run(stage+map[bool]string{false: "-rows-error", true: "-scan-error"}[scan], func(t *testing.T) {
				failure := errors.New("SYNTHETIC OPERATIONAL FAILURE")
				_, err := (&server{}).structuredResearchSnapshot(context.Background(), exportFaultTx{stage: stage, failure: failure, scan: scan}, "library", "", "", "plan")
				var data *exportDataError
				if !errors.Is(err, failure) || errors.As(err, &data) {
					t.Fatal("operational error reclassified as invalid data", err)
				}
			})
		}
	}
}
