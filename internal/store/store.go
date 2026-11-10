package store

import (
	"context"
	"errors"

	"github.com/qtrade/qtrade/internal/domain"
)

var (
	ErrNotFound = errors.New("resource not found")
	ErrConflict = errors.New("resource conflict")
)

type Store interface {
	CreateStrategy(ctx context.Context, strategy domain.Strategy) error
	ListStrategies(ctx context.Context) ([]domain.Strategy, error)
	GetStrategy(ctx context.Context, id string) (domain.Strategy, error)
	UpdateStrategy(ctx context.Context, strategy domain.Strategy) error

	CreateStrategyVersion(ctx context.Context, version domain.StrategyVersion) error
	GetStrategyVersion(ctx context.Context, strategyID, version string) (domain.StrategyVersion, error)
	ListStrategyVersions(ctx context.Context, strategyID string) ([]domain.StrategyVersion, error)

	CreateBacktest(ctx context.Context, run domain.BacktestRun) error
	GetBacktest(ctx context.Context, id string) (domain.BacktestRun, error)
	ListBacktests(ctx context.Context) ([]domain.BacktestRun, error)
	UpdateBacktest(ctx context.Context, run domain.BacktestRun) error

	CreateDeployment(ctx context.Context, deployment domain.LiveDeployment) error
	GetDeployment(ctx context.Context, id string) (domain.LiveDeployment, error)
	UpdateDeployment(ctx context.Context, deployment domain.LiveDeployment) error
	ListDeployments(ctx context.Context) ([]domain.LiveDeployment, error)

	CreateOrder(ctx context.Context, order domain.Order) error
	GetOrder(ctx context.Context, id string) (domain.Order, error)
	UpdateOrder(ctx context.Context, order domain.Order) error
	ListOrders(ctx context.Context, deploymentID, accountID string) ([]domain.Order, error)
	HasClientOrderID(ctx context.Context, clientOrderID string) (bool, error)

	GetAccount(ctx context.Context, id string) (domain.Account, error)
	ListAccounts(ctx context.Context) ([]domain.Account, error)
	UpdateAccount(ctx context.Context, account domain.Account) error
	ListPositions(ctx context.Context, accountID string) ([]domain.Position, error)
	ReplacePositions(ctx context.Context, accountID string, positions []domain.Position) error

	AddAudit(ctx context.Context, event domain.AuditEvent) error
	ListAudit(ctx context.Context, limit int) ([]domain.AuditEvent, error)

	AddLog(ctx context.Context, entry domain.LogEntry) error
	ListLogs(ctx context.Context, resourceType, resourceID string, limit int) ([]domain.LogEntry, error)
}
