package config

import (
	"os"
	"strings"
	"time"
)

type Config struct {
	Addr            string
	Environment     string
	ShutdownTimeout time.Duration
	CORSOrigins     []string
	DataRoot        string
	SeedDemo        bool
}

func Load() Config {
	return Config{
		Addr:            env("QTRADE_ADDR", ":8080"),
		Environment:     env("QTRADE_ENV", "dev"),
		ShutdownTimeout: durationEnv("QTRADE_SHUTDOWN_TIMEOUT", 10*time.Second),
		CORSOrigins:     splitEnv("QTRADE_CORS_ORIGINS", "http://localhost:5173"),
		DataRoot:        env("QTRADE_DATA_ROOT", "data"),
		SeedDemo:        boolEnv("QTRADE_SEED_DEMO", false),
	}
}

func boolEnv(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func splitEnv(key, fallback string) []string {
	value := env(key, fallback)
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
