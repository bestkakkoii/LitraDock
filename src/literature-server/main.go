package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type config struct {
	FrontendDirectory                                                string
	Database, Origin, Listen, Operator, Contact, Retention, Revision string
	Expires                                                          time.Time
	LocalTest                                                        bool
	SearchEnabled                                                    bool
	AcquisitionEnabled                                               bool
	BlockedPMCIDs                                                    []string
}
type server struct {
	native     bool
	db         *pgxpool.Pool
	cfg        config
	provider   *http.Client
	slots      chan struct{}
	loginGate  chan struct{}
	loginMu    sync.Mutex
	loginTimes []time.Time
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	action := run
	if len(os.Args) > 1 {
		action = func() error {
			if len(os.Args) != 2 {
				return errors.New("one operator verb required")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			return nativeOperator(ctx, os.Args[1])
		}
	}
	if err := action(); err != nil {
		log.Print("Candidate startup or service failure; review protected configuration and operator status.")
		os.Exit(1)
	}
}
func run() error {
	b, err := os.ReadFile(os.Getenv("LITRADOCK_GO_CONFIG"))
	if err != nil {
		return err
	}
	var cfg config
	if err = json.Unmarshal(b, &cfg); err != nil {
		return errors.New("invalid configuration")
	}
	u, err := url.Parse(cfg.Origin)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Host == "" {
		return errors.New("exact origin required")
	}
	h, _, err := net.SplitHostPort(cfg.Listen)
	if err != nil || h != "127.0.0.1" {
		return errors.New("loopback ingress required")
	}
	if cfg.LocalTest {
		if u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
			return errors.New("local origin required")
		}
	} else if u.Scheme != "https" {
		return errors.New("HTTPS required")
	}
	if cfg.Operator == "" || cfg.Contact == "" || cfg.Retention == "" || cfg.Expires.Before(time.Now()) {
		return errors.New("truthful operator and expiry required")
	}
	pc, err := pgxpool.ParseConfig(cfg.Database)
	if err != nil {
		return errors.New("database configuration invalid")
	}
	if !strings.HasPrefix(pc.ConnConfig.Database, "litradock_migration_") && !strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_") {
		return errors.New("isolated migration database required; no live database admission")
	}
	pc.MaxConns = 8
	pc.ConnConfig.ConnectTimeout = 5 * time.Second
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return err
	}
	defer db.Close()
	var version int
	schemaQuery, want := "SELECT max(version) FROM ld_schema", 4
	if strings.HasPrefix(pc.ConnConfig.Database, "litradock_native_") {
		schemaQuery, want = "SELECT max(version) FROM native_schema", 1
	}
	if err = db.QueryRow(ctx, schemaQuery).Scan(&version); err != nil || version != want {
		return errors.New("restored schema4 required")
	}
	s := &server{native: want == 1, db: db, cfg: cfg, provider: providerClient(), slots: make(chan struct{}, 2), loginGate: make(chan struct{}, 1)}
	service := &http.Server{Addr: cfg.Listen, Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
	go s.worker(ctx)
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = service.Shutdown(shutdown)
	}()
	log.Print("Go service started; isolated account, search and native schema capabilities follow the configured policy.")
	err = service.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		log.Print("Go migration candidate stopped.")
		return nil
	}
	return err
}
