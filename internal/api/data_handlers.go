package api

import (
	"encoding/json"
	"net/http"
	"strconv"
)

func (s *Server) dataOverview(w http.ResponseWriter, _ *http.Request) {
	raw, err := s.market.Overview()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"available": false,
			"reason":    "market data export not found: " + err.Error(),
		})
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"available": false,
			"reason":    "market data export is not valid JSON",
		})
		return
	}
	payload["available"] = true
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) marketInstruments(w http.ResponseWriter, r *http.Request) {
	limit := queryLimit(r, 50, 500)
	items, err := s.market.Instruments(r.URL.Query().Get("q"), limit)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"items":     []any{},
			"count":     0,
			"available": false,
			"reason":    err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":     items,
		"count":     len(items),
		"available": true,
	})
}

func (s *Server) marketQuotes(w http.ResponseWriter, r *http.Request) {
	limit := queryLimit(r, 50, 5000)
	items, err := s.market.Quotes(r.URL.Query().Get("q"), r.URL.Query().Get("symbols"), limit)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"items":     []any{},
			"count":     0,
			"available": false,
			"reason":    err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":     items,
		"count":     len(items),
		"available": true,
	})
}

func queryLimit(r *http.Request, fallback, maximum int) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	if parsed > maximum {
		return maximum
	}
	return parsed
}
