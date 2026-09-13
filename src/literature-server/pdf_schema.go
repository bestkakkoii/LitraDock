package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

const pdfSchema = `
ALTER TABLE native_batches ADD COLUMN requested_format text NOT NULL DEFAULT 'xml' CHECK(requested_format IN ('xml','pdf'));
ALTER TABLE native_plans ADD COLUMN requested_format text NOT NULL DEFAULT 'xml' CHECK(requested_format IN ('xml','pdf'));
ALTER TABLE native_originals ADD COLUMN format text NOT NULL DEFAULT 'xml' CHECK(format IN ('xml','pdf'));
ALTER TABLE native_originals ADD COLUMN proof bytea NOT NULL DEFAULT ''::bytea CHECK(octet_length(proof)<=2097152);
INSERT INTO native_schema(version) VALUES(3);
`

// Stopped-service exclusive admission lock is owned by nativeOperator. No automatic startup DDL.
func migratePDF(ctx context.Context, tx pgx.Tx, rollback bool) error {
	var version int
	if e := tx.QueryRow(ctx, "SELECT max(version) FROM native_schema").Scan(&version); e != nil {
		return e
	}
	if !rollback {
		if version == 3 {
			return nil
		}
		if version != 2 {
			return errors.New("PDF migration requires native schema 2")
		}
		_, e := tx.Exec(ctx, pdfSchema)
		return e
	}
	if version != 3 {
		return errors.New("PDF rollback requires native schema 3")
	}
	var occupied bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM native_batches WHERE requested_format<>'xml') OR EXISTS(SELECT 1 FROM native_plans WHERE requested_format<>'xml') OR EXISTS(SELECT 1 FROM native_originals WHERE format<>'xml' OR octet_length(proof)>0)`).Scan(&occupied); e != nil {
		return e
	}
	if occupied {
		return errors.New("PDF work exists; retain schema 3 and a compatible binary with PDF disabled, without deleting user work")
	}
	_, e := tx.Exec(ctx, `ALTER TABLE native_batches DROP COLUMN requested_format; ALTER TABLE native_plans DROP COLUMN requested_format; ALTER TABLE native_originals DROP COLUMN format; ALTER TABLE native_originals DROP COLUMN proof; DELETE FROM native_schema WHERE version=3;`)
	return e
}

func requestedFormat(values []string) (string, error) {
	if len(values) > 1 {
		return "", errors.New("one original format required")
	}
	f := "xml"
	if len(values) == 1 && values[0] != "" {
		f = values[0]
	}
	if f != "xml" && f != "pdf" {
		return "", errors.New("supported original formats: xml, pdf")
	}
	return f, nil
}

func nonNilBytes(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}

func formatPolicy(format string) string {
	if format == "pdf" {
		return pdfPolicy
	}
	return acquisitionPolicy
}
