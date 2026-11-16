package marketdata

import (
	"os"
	"path/filepath"
	"testing"
)

func writeSymbolSeries(t *testing.T, root, symbol, body string) {
	t.Helper()
	dir := filepath.Join(root, "ui", "series")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, symbol+".json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

const sampleSeries = `{"symbol":"600519.SH","name":"贵州茅台","days":3,"dates":["2026-11-11","2026-11-12","2026-11-13"],"open":[141000,141500,142000],"high":[142000,142500,143000],"low":[140000,140500,141000],"close":[141500,142000,142795],"volume":[100,200,300]}`

func TestSymbolSeriesTrimsToRequestedDays(t *testing.T) {
	root := t.TempDir()
	writeSymbolSeries(t, root, "600519.SH", sampleSeries)

	provider := New(root)
	series, err := provider.SymbolSeries("600519.sh", 2)
	if err != nil {
		t.Fatalf("SymbolSeries: %v", err)
	}
	if series.Days != 2 || len(series.Dates) != 2 {
		t.Fatalf("expected 2 bars, got days=%d dates=%d", series.Days, len(series.Dates))
	}
	if series.Dates[1] != "2026-11-13" || series.Close[1] != 142795 {
		t.Fatalf("unexpected last bar: %v %v", series.Dates, series.Close)
	}
}

func TestSymbolSeriesRejectsInvalidSymbol(t *testing.T) {
	provider := New(t.TempDir())
	if _, err := provider.SymbolSeries("../../etc/passwd", 10); err != ErrInvalidSymbol {
		t.Fatalf("expected ErrInvalidSymbol, got %v", err)
	}
}

func TestSymbolSeriesMissingFile(t *testing.T) {
	provider := New(t.TempDir())
	if _, err := provider.SymbolSeries("000001.SZ", 10); !os.IsNotExist(err) {
		t.Fatalf("expected not-exist error, got %v", err)
	}
}
