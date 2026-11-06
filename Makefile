SHELL := /bin/bash

.PHONY: help dev api build test test-go test-python fmt demo web web-build proto migrate clean

help:
	@echo "qtrade targets:"
	@echo "  make api        run Go API on :8080"
	@echo "  make demo       run Python backtest demo"
	@echo "  make web        run the web console dev server"
	@echo "  make test       run Go and Python tests"
	@echo "  make build      build all Go packages"
	@echo "  make dev        start Postgres/Redis/NATS/API with Docker Compose"
	@echo "  make proto      generate Go protobuf/grpc code"
	@echo "  make migrate    apply SQL schema using DATABASE_URL"

api:
	go run ./cmd/qtrade-api

build:
	go build ./...

test: test-go test-python

test-go:
	go test ./...

test-python:
	PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v

fmt:
	gofmt -w cmd internal

demo:
	PYTHONPATH=python/src python3 -m qtrade_research.cli demo

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

dev:
	docker compose up --build

clean:
	rm -rf bin gen
