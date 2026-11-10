SHELL := /bin/bash

PYTHON ?= python3
SYMBOLS ?= 600000.SH,000001.SZ
INTERVAL ?= 5
START ?= 2024-01-01
DATA_DIR ?= data

.PHONY: help dev api build test test-go test-python fmt demo web web-build proto migrate clean \
	data-instruments data-daily data-minute data-catalog data-verify data-load backtest

help:
	@echo "qtrade targets:"
	@echo "  make api        run Go API on :8080"
	@echo "  make demo       run Python backtest demo"
	@echo "  make web        run the web console dev server"
	@echo "  make test       run Go and Python tests"
	@echo "  make build      build all Go packages"
	@echo "  make dev        start Postgres/Redis/NATS/API with Docker Compose"
	@echo "  make proto      generate Go protobuf/grpc code"
	@echo "  make migrate    apply SQL schema (0001 + 0002) using DATABASE_URL"
	@echo "  make data-instruments   download the A-share instrument master"
	@echo "  make data-daily         collect daily bars for SYMBOLS since START"
	@echo "  make data-minute        collect INTERVAL-minute bars for SYMBOLS"
	@echo "  make data-catalog       show collected dataset coverage"

api:
	go run ./cmd/qtrade-api

build:
	go build ./...

test: test-go test-python

test-go:
	go test ./...

test-python:
	PYTHONPATH=python/src $(PYTHON) -m unittest discover -s python/tests -v

fmt:
	gofmt -w cmd internal

demo:
	PYTHONPATH=python/src $(PYTHON) -m qtrade_research.cli demo

web:
	cd web && npm install && npm run dev

web-build:
	cd web && npm install && npm run build

proto:
	protoc -I api/proto \
		--go_out=gen/go --go_opt=paths=source_relative \
		--go-grpc_out=gen/go --go-grpc_opt=paths=source_relative \
		api/proto/qtrade/v1/*.proto

migrate:
	psql "$$DATABASE_URL" -f migrations/0001_init.sql
	psql "$$DATABASE_URL" -f migrations/0002_market_data.sql

data-instruments:
	PYTHONPATH=python/src $(PYTHON) -m qtrade_research.data.cli instruments --out $(DATA_DIR)

data-daily:
	PYTHONPATH=python/src $(PYTHON) -m qtrade_research.data.cli daily \
		--symbols "$(SYMBOLS)" --start $(START) --out $(DATA_DIR) --incremental

data-minute:
	PYTHONPATH=python/src $(PYTHON) -m qtrade_research.data.cli minute \
		--symbols "$(SYMBOLS)" --interval $(INTERVAL) --start $(START) --out $(DATA_DIR) --incremental

data-catalog:
	PYTHONPATH=python/src $(PYTHON) -m qtrade_research.data.cli catalog --out $(DATA_DIR)

data-load:
	PYTHONPATH=python/src $(PYTHON) -m qtrade_research.data.cli load-postgres \
		--dataset all --out $(DATA_DIR)

backtest:
	PYTHONPATH=python/src $(PYTHON) -m qtrade_research.cli backtest \
		--snapshot $(DATA_DIR) --symbols "$(SYMBOLS)" --start $(START)

dev:
	docker compose up --build

clean:
	rm -rf bin gen