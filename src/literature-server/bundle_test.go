package main

import (
	"context"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestBundlePartitionBoundaries(t *testing.T) {
	file := func(name string, n int64, ids ...string) bundleFile {
		return bundleFile{File: name, SHA256: name, Format: "pdf", Bytes: n, SearchIDs: ids}
	}
	in := []bundleFile{file("a", 3<<20, "one", "alias"), file("b", 5<<20, "two"), file("c", 1, "three"), file("d", 8<<20, "four")}
	parts, e := partitionBundle(in)
	if e != nil {
		t.Fatal(e)
	}
	if len(parts) != 3 || parts[0].OriginalBytes != 8<<20 || parts[1].OriginalBytes != 1 || parts[2].OriginalBytes != 8<<20 {
		t.Fatalf("file boundary lost: %+v", parts)
	}
	var flattened []bundleFile
	for n, p := range parts {
		if p.Number != n+1 {
			t.Fatal("part ordering")
		}
		flattened = append(flattened, p.Files...)
	}
	if !reflect.DeepEqual(in, flattened) {
		t.Fatal("partition lost or duplicated an original/association")
	}
	for _, bad := range []int64{-1, 0, (8 << 20) + 1} {
		if _, e = partitionBundle([]bundleFile{file("bad", bad, "id")}); e == nil {
			t.Fatalf("accepted size%d", bad)
		}
	}
	large := []bundleFile{}
	for n := 0; n < 16; n++ {
		large = append(large, file(fmt.Sprint(n), 8<<20, fmt.Sprint(n)))
	}
	if p, e := partitionBundle(large); e != nil || len(p) != 16 {
		t.Fatal("128MiB boundary rejected", e)
	}
	large = append(large, file("overflow", 1, "overflow"))
	if _, e = partitionBundle(large); e == nil {
		t.Fatal("128MiB+1 silently admitted")
	}
	if p, e := partitionBundle(nil); e != nil || len(p) != 0 {
		t.Fatal("held-only snapshot needs empty parts")
	}
}

func TestBundleResumeRanges(t *testing.T) {
	for _, c := range []struct {
		header, match      string
		start, end, status int
	}{
		{"", "", 0, 100, 200}, {"bytes=0-49", "\"hash\"", 0, 50, 206}, {"bytes=50-99", "\"hash\"", 50, 100, 206},
		{"bytes=0-1", "", 0, 0, 412}, {"", "\"other\"", 0, 0, 412}, {"bytes=0-99", "\"other\"", 0, 0, 412},
		{"bytes=+0-1", "\"hash\"", 0, 0, 416}, {"bytes=0-+1", "\"hash\"", 0, 0, 416},
		{"bytes=-10", "\"hash\"", 0, 0, 416}, {"bytes=90-", "\"hash\"", 0, 0, 416}, {"bytes=0-1,4-5", "\"hash\"", 0, 0, 416},
		{"bytes=100-100", "\"hash\"", 0, 0, 416}, {"bytes=90-100", "\"hash\"", 0, 0, 416}, {"bytes=50-49", "\"hash\"", 0, 0, 416},
		{"bytes=999999999999999999999999999-2", "\"hash\"", 0, 0, 416},
	} {
		a, b, status := bundleRange(c.header, c.match, "\"hash\"", 100)
		if a != c.start || b != c.end || status != c.status {
			t.Fatalf("range%q match%q: %d,%d,%d", c.header, c.match, a, b, status)
		}
	}
}

func TestBundleRepeatedHeadersRejectedBeforeDataRead(t *testing.T) {
	for _, entry := range []struct {
		name string
		want int
	}{{"Range", 416}, {"If-Match", 412}} {
		s := &server{bundles: true}
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Add(entry.name, "first")
		r.Header.Add(entry.name, "second")
		w := httptest.NewRecorder()
		parts := strings.Split("api/libraries/"+newUUID()+"/plans/"+newID("PLN-")+"/bundles/"+newID("BND-")+"/parts/1", "/")
		s.bundleRoutes(w, r, context.Background(), parts[2], parts[4], parts)
		if w.Code != entry.want || s.bundleBusy.Load() {
			t.Fatal("repeated header escaped before data access", entry.name, w.Code)
		}
	}
}
