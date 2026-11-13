package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/qtrade/qtrade/internal/api"
	"github.com/qtrade/qtrade/internal/broker"
	"github.com/qtrade/qtrade/internal/config"
	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/risk"
	"github.com/qtrade/qtrade/internal/seed"
	"github.com/qtrade/qtrade/internal/store"
)

func main() {
	cfg := config.Load()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	memory := store.NewMemory()
	if cfg.SeedDemo {
		if err := seed.Demo(context.Background(), memory); err != nil {
			logger.Error("demo seed failed", "error", err)
		} else {
			logger.Info("demo lifecycle seeded")
		}
	}
	riskEngine := risk.NewEngine(domain.DefaultRiskLimits())
	gateway := broker.Mock{}
	ipoAdapter := broker.NewSandboxIPO(memory)
	handler := api.New(memory, riskEngine, gateway, ipoAdapter, logger, cfg)

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("qtrade api listening", "addr", cfg.Addr, "environment", cfg.Environment)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("qtrade api stopped")
}
