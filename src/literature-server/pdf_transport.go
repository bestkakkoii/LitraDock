package main

import (
	"io"
	"mime"
	"net/http"
	"net/url"
)

func cloudTarget(q url.Values) (string, string, error) {
	kind, id := q.Get("kind"), q.Get("id")
	if len(q) != 2 || len(q["kind"]) != 1 || len(q["id"]) != 1 {
		return "", "", pdfHeld("Invalid source request.")
	}
	if kind == "list" && pmcidPattern.MatchString(id) {
		args := url.Values{"list-type": {"2"}, "prefix": {id + "."}, "delimiter": {"/"}, "max-keys": {"3"}}
		return cloudBase + "/?" + args.Encode(), kind, nil
	}
	if !depositPattern.MatchString(id) {
		return "", "", pdfHeld("Invalid deposit version.")
	}
	if kind == "json" {
		return cloudBase + "/metadata/" + id + ".json", kind, nil
	}
	if kind == "xml" || kind == "pdf" {
		return cloudBase + "/" + id + "/" + id + "." + kind, kind, nil
	}
	return "", "", pdfHeld("Unsupported source format.")
}
func readCloudBody(r *http.Response, kind string) ([]byte, error) {
	ct, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	wanted := map[string]string{"list": "application/xml", "xml": "application/xml", "json": "application/json", "pdf": "application/pdf"}[kind]
	// The qualified S3 deposit objects use binary/octet-stream. Checksums and strict format parsers bind their contents; HTML is never accepted.
	if e != nil || wanted == "" || (ct != wanted && !(wanted == "application/xml" && ct == "text/xml") && !(kind != "list" && ct == "binary/octet-stream")) {
		return nil, pdfHeld("Source returned an unexpected media type.")
	}
	if enc := r.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		return nil, pdfHeld("Cloud content encoding is unsupported.")
	}
	limit := originalLimit
	if kind == "list" || kind == "json" {
		limit = 64 * 1024
	}
	if r.ContentLength > int64(limit) {
		return nil, pdfHeld("Source object exceeds the supported bound.")
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, int64(limit)+1))
	if e != nil || len(b) > limit || r.ContentLength >= 0 && int64(len(b)) != r.ContentLength {
		return nil, pdfHeld("Source body is incomplete or exceeds its bound.")
	}
	return b, nil
}
