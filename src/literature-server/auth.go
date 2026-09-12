package main

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Identity V3 is decoded for compatibility; derivation uses Go's maintained PBKDF2 implementation.
func verifyPassword(encoded, password string) bool {
	if strings.HasPrefix(encoded, "pbkdf2-sha256$") {
		return verifyNative(encoded, password)
	}
	b, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(b) < 13 || b[0] != 1 {
		return false
	}
	prf, count, saltSize := binary.BigEndian.Uint32(b[1:5]), binary.BigEndian.Uint32(b[5:9]), binary.BigEndian.Uint32(b[9:13])
	if count < 1 || count > 2_000_000 || saltSize < 16 || saltSize > 128 || len(b) < 13+int(saltSize)+16 || len(b) > 269 {
		return false
	}
	var h func() hash.Hash
	switch prf {
	case 0:
		h = sha1.New
	case 1:
		h = sha256.New
	case 2:
		h = sha512.New
	default:
		return false
	}
	expected := b[13+saltSize:]
	key, err := pbkdf2.Key(h, password, b[13:13+saltSize], int(count), len(expected))
	return err == nil && subtle.ConstantTimeCompare(key, expected) == 1
}
func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("Random source unavailable")
	}
	return strings.ToUpper(hex.EncodeToString(b))
}
func digest(token string) string {
	b := sha256.Sum256([]byte(token))
	return strings.ToUpper(hex.EncodeToString(b[:]))
}
func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

type session struct{ Account, CSRF, Hash string }

func (s *server) login(ctx context.Context, login, password string) (string, *session, error) {
	// Native policy: valid Unicode, at most 120/256 code points; passwords are never normalized.
	if !utf8.ValidString(login) || !utf8.ValidString(password) || utf8.RuneCountInString(login) > 120 || utf8.RuneCountInString(password) > 256 {
		return "", nil, nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SET LOCAL lock_timeout='3s'"); err != nil {
		return "", nil, err
	}
	var account, encoded string
	var enabled bool
	err = tx.QueryRow(ctx, "SELECT account_id::text,password_hash,enabled FROM ld_accounts WHERE login=$1 FOR UPDATE", strings.ToLower(strings.TrimSpace(login))).Scan(&account, &encoded, &enabled)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !enabled {
		_, _ = pbkdf2.Key(sha512.New, password, []byte("synthetic-dummy-salt"), 100000, 32)
		return "", nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	if !verifyPassword(encoded, password) {
		return "", nil, nil
	}
	token := randomToken()
	sess := &session{account, randomToken(), digest(token)}
	_, err = tx.Exec(ctx, "INSERT INTO ld_sessions VALUES($1,$2,$3,now()+interval '8 hours')", sess.Hash, sess.Account, sess.CSRF)
	if err == nil {
		_, err = tx.Exec(ctx, "DELETE FROM ld_sessions WHERE account_id=$1 AND expires_at<now()", account)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		return "", nil, err
	}
	return token, sess, nil
}
func (s *server) authenticate(ctx context.Context, token string) (*session, error) {
	if len(token) != 64 {
		return nil, nil
	}
	var sess session
	sess.Hash = digest(token)
	err := s.db.QueryRow(ctx, "SELECT s.account_id::text,s.csrf FROM ld_sessions s JOIN ld_accounts a USING(account_id) WHERE token_hash=$1 AND expires_at>now() AND a.enabled", sess.Hash).Scan(&sess.Account, &sess.CSRF)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &sess, err
}
