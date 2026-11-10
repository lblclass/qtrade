// Package marketdata serves compact JSON exports written by the Python
// collector. The Go API never parses Parquet; it only exposes the small files
// produced by “qtrade-data export-ui“ so the console stays fast.
package marketdata

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Instrument struct {
	Symbol   string `json:"symbol"`
	Name     string `json:"name"`
	Exchange string `json:"exchange"`
	Board    string `json:"board"`
	IsActive bool   `json:"is_active"`
	ListDate string `json:"list_date,omitempty"`
}

type Quote struct {
	Symbol         string `json:"symbol"`
	Name           string `json:"name"`
	Exchange       string `json:"exchange"`
	CloseCents     int64  `json:"close_cents"`
	PrevCloseCents int64  `json:"prev_close_cents"`
	ChangeBPS      int64  `json:"change_bps"`
	Volume         int64  `json:"volume"`
	AmountCents    int64  `json:"amount_cents"`
	LimitUpCents   int64  `json:"limit_up_cents"`
	LimitDownCents int64  `json:"limit_down_cents"`
	TradeDate      string `json:"trade_date"`
}

type Provider struct {
	root string

	mu         sync.RWMutex
	overview   cachedJSON
	quotes     cachedQuotes
	instrument cachedInstruments
	series     cachedSeries
}

type cachedJSON struct {
	modTime time.Time
	data    json.RawMessage
	err     error
}

type cachedQuotes struct {
	modTime time.Time
	items   []Quote
	err     error
}

type cachedInstruments struct {
	path    string
	modTime time.Time
	items   []Instrument
	err     error
}

type cachedSeries struct {
	modTime time.Time
	data    *Series
	err     error
}

func New(root string) *Provider {
	return &Provider{root: strings.TrimSpace(root)}
}

func (p *Provider) Available() bool {
	if p == nil || p.root == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(p.root, "_ui_summary.json"))
	return err == nil
}

func (p *Provider) Overview() (json.RawMessage, error) {
	if p == nil || p.root == "" {
		return nil, errors.New("market data root is not configured")
	}
	path := filepath.Join(p.root, "_ui_summary.json")
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	p.mu.RLock()
	cached := p.overview
	p.mu.RUnlock()
	if cached.data != nil && cached.modTime.Equal(info.ModTime()) {
		return cached.data, cached.err
	}
	raw, readErr := os.ReadFile(path)
	p.mu.Lock()
	p.overview = cachedJSON{modTime: info.ModTime(), data: raw, err: readErr}
	p.mu.Unlock()
	return raw, readErr
}

func (p *Provider) Instruments(query string, limit int) ([]Instrument, error) {
	items, err := p.loadInstruments()
	if err != nil {
		return nil, err
	}
	query = strings.ToLower(strings.TrimSpace(query))
	out := make([]Instrument, 0, limit)
	for _, item := range items {
		if query != "" &&
			!strings.Contains(strings.ToLower(item.Symbol), query) &&
			!strings.Contains(strings.ToLower(item.Name), query) &&
			!strings.Contains(strings.ToLower(item.Exchange), query) {
			continue
		}
		out = append(out, item)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (p *Provider) Quotes(query, symbols string, limit int) ([]Quote, error) {
	if p == nil || p.root == "" {
		return nil, errors.New("market data root is not configured")
	}
	path := filepath.Join(p.root, "_quotes.json")
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	p.mu.RLock()
	cached := p.quotes
	p.mu.RUnlock()
	if cached.items == nil || !cached.modTime.Equal(info.ModTime()) {
		raw, readErr := os.ReadFile(path)
		items := []Quote{}
		if readErr == nil {
			var payload struct {
				Items []Quote `json:"items"`
			}
			if decodeErr := json.Unmarshal(raw, &payload); decodeErr != nil {
				readErr = decodeErr
			} else {
				items = payload.Items
			}
		}
		p.mu.Lock()
		p.quotes = cachedQuotes{modTime: info.ModTime(), items: items, err: readErr}
		p.mu.Unlock()
		cached = p.quotes
	}
	if cached.err != nil {
		return nil, cached.err
	}

	wanted := map[string]struct{}{}
	for _, symbol := range strings.Split(symbols, ",") {
		symbol = strings.TrimSpace(strings.ToUpper(symbol))
		if symbol != "" {
			wanted[symbol] = struct{}{}
		}
	}
	query = strings.ToLower(strings.TrimSpace(query))
	out := make([]Quote, 0, limit)
	for _, item := range cached.items {
		if len(wanted) > 0 {
			if _, ok := wanted[item.Symbol]; !ok {
				continue
			}
		}
		if query != "" &&
			!strings.Contains(strings.ToLower(item.Symbol), query) &&
			!strings.Contains(strings.ToLower(item.Name), query) {
			continue
		}
		out = append(out, item)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (p *Provider) loadInstruments() ([]Instrument, error) {
	if p == nil || p.root == "" {
		return nil, errors.New("market data root is not configured")
	}
	root := filepath.Join(p.root, "instruments")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	dirs := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, entry.Name())
		}
	}
	if len(dirs) == 0 {
		return nil, os.ErrNotExist
	}
	sort.Strings(dirs)
	path := filepath.Join(root, dirs[len(dirs)-1], "instruments.json")
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	p.mu.RLock()
	cached := p.instrument
	p.mu.RUnlock()
	if cached.items != nil && cached.path == path && cached.modTime.Equal(info.ModTime()) {
		return cached.items, cached.err
	}
	raw, readErr := os.ReadFile(path)
	items := []Instrument{}
	if readErr == nil {
		readErr = json.Unmarshal(raw, &items)
	}
	p.mu.Lock()
	p.instrument = cachedInstruments{path: path, modTime: info.ModTime(), items: items, err: readErr}
	p.mu.Unlock()
	return items, readErr
}

// SeriesSymbol is one symbol sliced to a recent trading window. Prices are
// integer cents so the Go side never introduces float drift.
type SeriesSymbol struct {
	Name      string   `json:"name"`
	Dates     []string `json:"dates"`
	Open      []int64  `json:"open"`
	High      []int64  `json:"high"`
	Low       []int64  `json:"low"`
	Close     []int64  `json:"close"`
	Volume    []int64  `json:"volume"`
	LimitUp   []int64  `json:"limit_up"`
	LimitDown []int64  `json:"limit_down"`
}

// Series is the rolling window exported by “qtrade-data export-ui”. The worker
// runs backtests against it and the API marks accounts to market with it.
type Series struct {
	GeneratedAt string                  `json:"generated_at"`
	End         string                  `json:"end"`
	Days        int                     `json:"days"`
	Symbols     map[string]SeriesSymbol `json:"symbols"`
	Benchmark   *SeriesBenchmark        `json:"benchmark,omitempty"`
}

type SeriesBenchmark struct {
	Label  string    `json:"label"`
	Dates  []string  `json:"dates"`
	Values []float64 `json:"values"`
}

func (p *Provider) Series() (*Series, error) {
	if p == nil || p.root == "" {
		return nil, errors.New("market data root is not configured")
	}
	path := filepath.Join(p.root, "_series.json")
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	p.mu.RLock()
	cached := p.series
	p.mu.RUnlock()
	if cached.data != nil && cached.modTime.Equal(info.ModTime()) {
		return cached.data, cached.err
	}
	raw, readErr := os.ReadFile(path)
	var data *Series
	if readErr == nil {
		data = &Series{}
		if decodeErr := json.Unmarshal(raw, data); decodeErr != nil {
			readErr = decodeErr
			data = nil
		}
	}
	p.mu.Lock()
	p.series = cachedSeries{modTime: info.ModTime(), data: data, err: readErr}
	p.mu.Unlock()
	return data, readErr
}

// LatestDailySnapshot returns the newest bars_1d snapshot id from the summary
// export, used as the default data version for one-click simulations.
func (p *Provider) LatestDailySnapshot() string {
	raw, err := p.Overview()
	if err != nil {
		return ""
	}
	var summary struct {
		Snapshots []struct {
			SnapshotID string `json:"snapshot_id"`
			Dataset    string `json:"dataset"`
			End        string `json:"end"`
		} `json:"snapshots"`
	}
	if err := json.Unmarshal(raw, &summary); err != nil {
		return ""
	}
	for _, item := range summary.Snapshots {
		if item.Dataset == "bars_1d" {
			return item.SnapshotID
		}
	}
	return ""
}