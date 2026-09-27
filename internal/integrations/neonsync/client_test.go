package neonsync

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

func TestGetEntriesByIDsBatchesLongIDLists(t *testing.T) {
	ids := make([]string, 250)
	for i := range ids {
		ids[i] = fmt.Sprintf("%064x", i)
	}

	var batchSizes []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.RequestURI()) > 8*1024 {
			t.Errorf("request line is %d bytes", len(r.URL.RequestURI()))
		}
		requested := inParam(r, "id")
		batchSizes = append(batchSizes, len(requested))
		rows := make([]sharedEntryRow, 0, len(requested))
		for id := range requested {
			rows = append(rows, sharedEntryRow{ID: id})
		}
		_ = json.NewEncoder(w).Encode(rows)
	}))
	defer srv.Close()

	rows, err := getEntriesByIDs(t.Context(), srv.Client(), srv.URL, "token", ids)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(batchSizes) != "[100 100 50]" {
		t.Fatalf("unexpected batches %v", batchSizes)
	}
	got := make([]string, len(rows))
	for i, row := range rows {
		got[i] = row.ID
	}
	sort.Strings(got)
	if fmt.Sprint(got) != fmt.Sprint(ids) {
		t.Fatalf("merged rows don't match requested ids")
	}
}

func TestMarkDeletedStopsAtFirstFailedBatch(t *testing.T) {
	ids := make([]string, 250)
	for i := range ids {
		ids[i] = fmt.Sprintf("%064x", i)
	}

	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	if err := markDeleted(t.Context(), srv.Client(), srv.URL, "token", ids); err == nil {
		t.Fatal("want error from failed batch")
	}
	if calls != 2 {
		t.Fatalf("want 2 requests, got %d", calls)
	}
}
