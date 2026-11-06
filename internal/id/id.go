package id

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// New returns a sortable, prefixed identifier suitable for API resources.
func New(prefix string) string {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("generate id: %v", err))
	}
	return fmt.Sprintf("%s_%s_%s", prefix, time.Now().UTC().Format("20060102T150405"), hex.EncodeToString(buf))
}
