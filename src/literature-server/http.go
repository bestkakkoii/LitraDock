package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeBounded(w, r, v, 16384)
}
func decodeBounded(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		reply(w, 400, map[string]string{"error": "Invalid or excessive request body."})
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		reply(w, 400, map[string]string{"error": "Expected one JSON value."})
		return false
	}
	return true
}
func (s *server) cookieName() string {
	if s.cfg.LocalTest {
		return "LitraDockTest"
	}
	return "__Host-LitraDock"
}
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	origin, e := url.Parse(s.cfg.Origin)
	if e != nil || origin.Host == "" || r.Host != origin.Host {
		reply(w, 403, nil)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'")
	if s.cfg.FrontendDirectory != "" && r.Method == "GET" && (r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/assets/")) {
		name := "index.html"
		if r.URL.Path != "/" {
			name = strings.TrimPrefix(r.URL.Path, "/")
			if path.Clean(name) != name || strings.Contains(strings.TrimPrefix(name, "assets/"), "/") {
				reply(w, 404, nil)
				return
			}
		}
		extension := path.Ext(name)
		kind := map[string]string{".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}[extension]
		if kind == "" {
			reply(w, 404, nil)
			return
		}
		b, e := os.ReadFile(s.cfg.FrontendDirectory + "/" + name)
		if e != nil || len(b) > 4*1024*1024 {
			reply(w, 404, nil)
			return
		}
		w.Header().Set("Content-Type", kind)
		_, _ = w.Write(b)
		return
	}
	if r.URL.Path == "/" && r.Method == "GET" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page))
		return
	}
	if r.URL.Path == "/app.js" && r.Method == "GET" {
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = w.Write([]byte(script))
		return
	}
	if r.URL.Path == "/app.css" && r.Method == "GET" {
		w.Header().Set("Content-Type", "text/css")
		_, _ = w.Write([]byte(styles))
		return
	}
	if r.URL.Path == "/service-info" && r.Method == "GET" {
		reply(w, 200, map[string]any{"demo": true, "candidate": true, "backend": "Go", "operatorName": s.cfg.Operator, "contact": s.cfg.Contact, "retention": s.cfg.Retention, "expiresAt": s.cfg.Expires, "searchLimit": 100, "searchEnabled": s.cfg.SearchEnabled, "batchLimit": func() int {
			if s.native {
				return 10
			}
			return 0
		}(), "searchContinuationEnabled": s.continuation && s.cfg.SearchContinuationEnabled && s.cfg.SearchEnabled, "searchWindowLimit": searchWindowLimit,
			"durableSelectionEnabled": s.runSelection, "selectionWriteEnabled": s.runSelection && s.cfg.SelectionWriteEnabled, "selectionRecordLimit": runSelectionLimit,
			"bundleDeliveryEnabled": s.bundles && s.cfg.BundleDeliveryEnabled, "bundleOriginalLimitBytes": bundleOriginalLimit, "bundlePartOriginalLimitBytes": bundlePartOriginalLimit, "pdfEnabled": s.native && s.cfg.PDFEnabled && s.cfg.AcquisitionEnabled, "pdfPolicySummary": pdfPolicySummary, "planEnabled": s.native && s.cfg.PlanEnabled, "savedSnapshotEnabled": s.native && s.savedSnapshots && s.cfg.SavedSetEnabled, "savedSetEnabled": s.native && s.cfg.PlanEnabled && s.cfg.SavedSetEnabled, "planSelectionLimit": 100, "planGroupLimit": 10, "acquisitionEnabled": s.cfg.AcquisitionEnabled, "source": s.cfg.Revision})
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		reply(w, 404, nil)
		return
	}
	if time.Now().After(s.cfg.Expires) {
		reply(w, 409, map[string]string{"error": "Candidate expired; contact the operator."})
		return
	}
	if r.Method != "GET" && (r.Header.Get("Origin") != s.cfg.Origin || strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json") {
		reply(w, 403, nil)
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		w.Header().Set("Retry-After", "2")
		reply(w, 429, map[string]string{"code": "admission_not_started"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		reply(w, 503, nil)
		return
	}
	defer conn.Release()
	var admitted bool
	err = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock_shared(724913010)").Scan(&admitted)
	if err != nil || !admitted {
		w.Header().Set("Retry-After", "2")
		reply(w, 429, map[string]string{"code": "admission_not_started"})
		return
	}
	defer func() {
		c, done := context.WithTimeout(context.Background(), 2*time.Second)
		defer done()
		if _, e := conn.Exec(c, "SELECT pg_advisory_unlock_all()"); e != nil {
			_ = conn.Conn().Close(c)
		}
	}()
	var recoveryRequired bool
	if conn.QueryRow(ctx, "SELECT required FROM ld_recovery_guard WHERE singleton=true").Scan(&recoveryRequired) != nil || recoveryRequired {
		reply(w, 503, map[string]string{"error": "Repository recovery is required; request not admitted."})
		return
	}
	if r.URL.Path == "/api/login" && r.Method == "POST" {
		s.loginMu.Lock()
		now := time.Now()
		for len(s.loginTimes) > 0 && now.Sub(s.loginTimes[0]) >= time.Minute {
			s.loginTimes = s.loginTimes[1:]
		}
		limited := len(s.loginTimes) >= 10
		if !limited {
			s.loginTimes = append(s.loginTimes, now)
		}
		s.loginMu.Unlock()
		if limited {
			w.Header().Set("Retry-After", "60")
			reply(w, 429, nil)
			return
		}
		select {
		case s.loginGate <- struct{}{}:
			defer func() { time.AfterFunc(time.Second, func() { <-s.loginGate }) }()
		default:
			w.Header().Set("Retry-After", "1")
			reply(w, 429, nil)
			return
		}
		var input struct{ Login, Password string }
		if !decode(w, r, &input) {
			return
		}
		token, sess, e := s.login(ctx, input.Login, input.Password)
		if e != nil {
			reply(w, 503, nil)
			return
		}
		if sess == nil {
			reply(w, 401, nil)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: s.cookieName(), Value: token, Path: "/", HttpOnly: true, Secure: !s.cfg.LocalTest, SameSite: http.SameSiteStrictMode, MaxAge: 28800})
		reply(w, 200, map[string]string{"csrf": sess.CSRF})
		return
	}
	cookie, e := r.Cookie(s.cookieName())
	if e != nil {
		reply(w, 401, nil)
		return
	}
	sess, e := s.authenticate(ctx, cookie.Value)
	if e != nil {
		reply(w, 503, nil)
		return
	}
	if sess == nil {
		reply(w, 401, nil)
		return
	}
	if r.Method != "GET" && !same(r.Header.Get("X-CSRF"), sess.CSRF) {
		reply(w, 403, nil)
		return
	}
	ctx = context.WithValue(ctx, snapshotSessionKey{}, sess)
	if r.URL.Path == "/api/session" && r.Method == "GET" {
		reply(w, 200, map[string]string{"csrf": sess.CSRF})
		return
	}
	if r.URL.Path == "/api/logout" && r.Method == "POST" {
		_, e = s.db.Exec(ctx, "DELETE FROM ld_sessions WHERE token_hash=$1", sess.Hash)
		if e != nil {
			reply(w, 503, nil)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: s.cookieName(), Value: "", Path: "/", HttpOnly: true, Secure: !s.cfg.LocalTest, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		reply(w, 200, nil)
		return
	}
	offset := 0
	if value := r.URL.Query().Get("offset"); value != "" {
		offset, e = strconv.Atoi(value)
		if e != nil || offset < 0 || offset > 1000000 {
			reply(w, 400, nil)
			return
		}
	}
	if r.URL.Path == "/api/libraries" {
		if r.Method == "GET" {
			rows, err := s.rows(ctx, "SELECT library_id::text,name FROM ld_libraries WHERE owner_id=$1 AND ready ORDER BY library_id LIMIT 100 OFFSET $2", sess.Account, offset)
			if err != nil {
				reply(w, 503, nil)
				return
			}
			var total int
			if s.db.QueryRow(ctx, "SELECT count(*) FROM ld_libraries WHERE owner_id=$1 AND ready", sess.Account).Scan(&total) != nil {
				reply(w, 503, nil)
				return
			}
			reply(w, 200, map[string]any{"items": rows, "total": total, "offset": offset, "limit": 100})
			return
		}
		if r.Method == "POST" {
			var input struct{ Value string }
			if !decode(w, r, &input) {
				return
			}
			id, err := s.createLibrary(ctx, sess.Account, input.Value)
			if err != nil {
				reply(w, 409, map[string]string{"error": "Library limit or input validation failed."})
				return
			}
			reply(w, 200, map[string]string{"id": id})
			return
		}
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || parts[1] != "libraries" || !uuidPattern.MatchString(parts[2]) {
		reply(w, 404, nil)
		return
	}
	library := parts[2]
	var owns bool
	e = s.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM ld_libraries WHERE library_id=$1 AND owner_id=$2 AND ready)", library, sess.Account).Scan(&owns)
	if e != nil {
		reply(w, 503, nil)
		return
	}
	if !owns {
		reply(w, 404, nil)
		return
	}
	if s.native && s.runSelectionRoute(w, r, ctx, library, parts) {
		return
	}
	if s.native && s.nativeRoutes(w, r, ctx, library, parts) {
		return
	}
	if s.native && s.continuationRoute(w, r, ctx, library, parts) {
		return
	}
	if len(parts) == 3 && r.Method == "GET" {
		v, e := s.catalog(ctx, library, offset)
		if e != nil {
			reply(w, 503, nil)
			return
		}
		reply(w, 200, v)
		return
	}
	if len(parts) == 4 && parts[3] == "search" && r.Method == "POST" {
		var input struct {
			Query     string
			Limit     int
			RequestID string
		}
		if !decode(w, r, &input) {
			return
		}
		if !s.cfg.SearchEnabled && !(s.continuation && input.RequestID != "") {
			reply(w, 409, map[string]string{"error": "New searches are disabled; saved results remain available."})
			return
		}
		id, e := s.queueSearch(ctx, library, input.Query, input.Limit, input.RequestID)
		if e != nil {
			if s.continuation && (s.cfg.SearchContinuationEnabled || input.RequestID != "") {
				planReply(w, nil, e)
				return
			}
			reply(w, 409, map[string]string{"error": "Search needs a query up to 2000 characters, limit 1–100, and available candidate capacity."})
			return
		}
		reply(w, 200, map[string]string{"id": id})
		return
	}
	if len(parts) == 5 && parts[3] == "runs" && r.Method == "GET" {
		pageLimit := 100
		if r.URL.Query().Has("limit") {
			pageLimit, e = strconv.Atoi(r.URL.Query().Get("limit"))
			if e != nil || pageLimit < 1 || pageLimit > 100 {
				reply(w, 400, map[string]string{"error": "Saved-record page limit must be 1–100."})
				return
			}
		}
		page, e := s.savedRunPage(ctx, library, parts[4], offset, pageLimit)
		planReply(w, page, e)
		return
	}
	reply(w, 501, map[string]string{"error": "This isolated Go migration slice supports login, libraries and search only; acquisition, original download, exports and recovery remain on the current pilot."})
}
func (s *server) rows(ctx context.Context, sql string, args ...any) ([]map[string]any, error) {
	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, pgx.RowToMap)
}
