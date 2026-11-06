package store

import (
	"context"
	"sync"
	"time"

	"github.com/qtrade/qtrade/internal/domain"
	"github.com/qtrade/qtrade/internal/id"
)

type Memory struct {
	mu sync.RWMutex

	strategies    map[string]domain.Strategy
	strategyOrder []string
	versions      map[string]domain.StrategyVersion

	backtests     map[string]domain.BacktestRun
	backtestOrder []string

	deployments     map[string]domain.LiveDeployment
	deploymentOrder []string

	orders         map[string]domain.Order
	orderOrder     []string
	clientOrderIDs map[string]struct{}

	accounts     map[string]domain.Account
	accountOrder []string
	positions    map[string][]domain.Position

	audits []domain.AuditEvent
}

func NewMemory() *Memory {
	account := domain.Account{
		ID:          "acc_demo",
		Name:        "Demo account",
		CashCents:   100_000_000,
		EquityCents: 100_000_000,
		Currency:    "CNY",
	}
	return &Memory{
		strategies:     make(map[string]domain.Strategy),
		versions:       make(map[string]domain.StrategyVersion),
		backtests:      make(map[string]domain.BacktestRun),
		deployments:    make(map[string]domain.LiveDeployment),
		orders:         make(map[string]domain.Order),
		clientOrderIDs: make(map[string]struct{}),
		accounts:       map[string]domain.Account{account.ID: account},
		accountOrder:   []string{account.ID},
		positions:      make(map[string][]domain.Position),
	}
}

func (m *Memory) CreateStrategy(_ context.Context, strategy domain.Strategy) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.strategies[strategy.ID]; exists {
		return ErrConflict
	}
	m.strategies[strategy.ID] = strategy
	m.strategyOrder = append(m.strategyOrder, strategy.ID)
	return nil
}

func (m *Memory) ListStrategies(_ context.Context) ([]domain.Strategy, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]domain.Strategy, 0, len(m.strategyOrder))
	for _, itemID := range m.strategyOrder {
		out = append(out, m.strategies[itemID])
	}
	return out, nil
}

func (m *Memory) GetStrategy(_ context.Context, strategyID string) (domain.Strategy, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	strategy, ok := m.strategies[strategyID]
	if !ok {
		return domain.Strategy{}, ErrNotFound
	}
	return strategy, nil
}

func (m *Memory) CreateStrategyVersion(_ context.Context, version domain.StrategyVersion) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.strategies[version.StrategyID]; !ok {
		return ErrNotFound
	}
	key := versionKey(version.StrategyID, version.Version)
	if _, exists := m.versions[key]; exists {
		return ErrConflict
	}
	m.versions[key] = version
	return nil
}

func (m *Memory) GetStrategyVersion(_ context.Context, strategyID, version string) (domain.StrategyVersion, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	item, ok := m.versions[versionKey(strategyID, version)]
	if !ok {
		return domain.StrategyVersion{}, ErrNotFound
	}
	return item, nil
}

func (m *Memory) CreateBacktest(_ context.Context, run domain.BacktestRun) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.backtests[run.ID]; exists {
		return ErrConflict
	}
	m.backtests[run.ID] = run
	m.backtestOrder = append(m.backtestOrder, run.ID)
	return nil
}

func (m *Memory) GetBacktest(_ context.Context, backtestID string) (domain.BacktestRun, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	run, ok := m.backtests[backtestID]
	if !ok {
		return domain.BacktestRun{}, ErrNotFound
	}
	return run, nil
}

func (m *Memory) ListBacktests(_ context.Context) ([]domain.BacktestRun, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]domain.BacktestRun, 0, len(m.backtestOrder))
	for _, runID := range m.backtestOrder {
		out = append(out, m.backtests[runID])
	}
	return out, nil
}

func (m *Memory) CreateDeployment(_ context.Context, deployment domain.LiveDeployment) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.deployments[deployment.ID]; exists {
		return ErrConflict
	}
	m.deployments[deployment.ID] = deployment
	m.deploymentOrder = append(m.deploymentOrder, deployment.ID)
	return nil
}

func (m *Memory) GetDeployment(_ context.Context, deploymentID string) (domain.LiveDeployment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	deployment, ok := m.deployments[deploymentID]
	if !ok {
		return domain.LiveDeployment{}, ErrNotFound
	}
	return deployment, nil
}

func (m *Memory) UpdateDeployment(_ context.Context, deployment domain.LiveDeployment) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.deployments[deployment.ID]; !ok {
		return ErrNotFound
	}
	m.deployments[deployment.ID] = deployment
	return nil
}

func (m *Memory) ListDeployments(_ context.Context) ([]domain.LiveDeployment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]domain.LiveDeployment, 0, len(m.deploymentOrder))
	for _, deploymentID := range m.deploymentOrder {
		out = append(out, m.deployments[deploymentID])
	}
	return out, nil
}

func (m *Memory) CreateOrder(_ context.Context, order domain.Order) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.clientOrderIDs[order.ClientOrderID]; exists {
		return ErrConflict
	}
	m.orders[order.ID] = order
	m.orderOrder = append(m.orderOrder, order.ID)
	m.clientOrderIDs[order.ClientOrderID] = struct{}{}
	return nil
}

func (m *Memory) ListOrders(_ context.Context, deploymentID, accountID string) ([]domain.Order, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]domain.Order, 0, len(m.orderOrder))
	for _, orderID := range m.orderOrder {
		order := m.orders[orderID]
		if deploymentID != "" && order.DeploymentID != deploymentID {
			continue
		}
		if accountID != "" && order.AccountID != accountID {
			continue
		}
		out = append(out, order)
	}
	return out, nil
}

func (m *Memory) HasClientOrderID(_ context.Context, clientOrderID string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.clientOrderIDs[clientOrderID]
	return ok, nil
}

func (m *Memory) GetAccount(_ context.Context, accountID string) (domain.Account, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	account, ok := m.accounts[accountID]
	if !ok {
		return domain.Account{}, ErrNotFound
	}
	return account, nil
}

func (m *Memory) ListAccounts(_ context.Context) ([]domain.Account, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]domain.Account, 0, len(m.accountOrder))
	for _, accountID := range m.accountOrder {
		out = append(out, m.accounts[accountID])
	}
	return out, nil
}

func (m *Memory) ListPositions(_ context.Context, accountID string) ([]domain.Position, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if accountID == "" {
		out := make([]domain.Position, 0)
		for _, items := range m.positions {
			out = append(out, items...)
		}
		return out, nil
	}
	return append([]domain.Position(nil), m.positions[accountID]...), nil
}

func (m *Memory) AddAudit(_ context.Context, event domain.AuditEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if event.ID == "" {
		event.ID = id.New("audit")
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	m.audits = append(m.audits, event)
	return nil
}

func (m *Memory) ListAudit(_ context.Context, limit int) ([]domain.AuditEvent, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if limit <= 0 || limit > len(m.audits) {
		limit = len(m.audits)
	}
	start := len(m.audits) - limit
	out := make([]domain.AuditEvent, 0, limit)
	for i := len(m.audits) - 1; i >= start; i-- {
		out = append(out, m.audits[i])
	}
	return out, nil
}

func versionKey(strategyID, version string) string {
	return strategyID + "@" + version
}
