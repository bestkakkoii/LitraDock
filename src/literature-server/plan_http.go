package main

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
)

func planReply(w http.ResponseWriter, value any, err error) {
	if err == nil {
		reply(w, 200, value)
		return
	}
	var pe *planError
	if errors.As(err, &pe) {
		reply(w, pe.Status, map[string]string{"error": pe.Message})
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		reply(w, 404, map[string]string{"error": "Plan is unavailable in this library."})
		return
	}
	reply(w, 503, map[string]string{"error": "Plan operation could not be confirmed; refresh saved work before retrying the same request."})
}
func (s *server) planRoutes(w http.ResponseWriter, r *http.Request, ctx context.Context, library string, parts []string) bool {
	if len(parts) < 4 || parts[3] != "plans" {
		return false
	}
	if len(parts) > 4 && !planIDPattern.MatchString(parts[4]) {
		reply(w, 404, nil)
		return true
	}
	if len(parts) == 4 && r.Method == "POST" {
		var input struct {
			RequestID, RunID string
			SearchIDs        []string
		}
		if decode(w, r, &input) {
			v, e := s.queuePlan(ctx, library, input.RequestID, input.RunID, input.SearchIDs)
			planReply(w, v, e)
		}
		return true
	}
	if r.Method == "GET" && (len(parts) == 4 || len(parts) == 5) {
		offset, limit := 0, 25
		var err error
		if r.URL.Query().Has("offset") {
			offset, err = strconv.Atoi(r.URL.Query().Get("offset"))
			if err != nil || offset < 0 || offset > 1000000 {
				reply(w, 400, nil)
				return true
			}
		}
		if r.URL.Query().Has("limit") {
			limit, err = strconv.Atoi(r.URL.Query().Get("limit"))
			if err != nil || limit < 1 || limit > 100 {
				reply(w, 400, nil)
				return true
			}
		}
		var v any
		if len(parts) == 4 {
			v, err = s.listPlans(ctx, library, offset, limit)
		} else {
			v, err = s.planDetail(ctx, library, parts[4], offset, limit)
		}
		planReply(w, v, err)
		return true
	}
	if len(parts) == 6 && parts[5] == "control" && r.Method == "POST" {
		var input struct {
			RequestID, Value string
			ExpectedRevision int64
		}
		if decode(w, r, &input) {
			v, e := s.controlPlan(ctx, library, parts[4], input.RequestID, input.Value, input.ExpectedRevision)
			planReply(w, v, e)
		}
		return true
	}
	reply(w, 404, nil)
	return true
}
