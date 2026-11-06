-- qtrade initial schema. All money values are integer cents.

CREATE TABLE IF NOT EXISTS strategies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_versions (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    artifact_digest TEXT NOT NULL,
    python_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (strategy_id, version)
);

CREATE TABLE IF NOT EXISTS dataset_snapshots (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'published',
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    quality_report JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_runs (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    strategy_version TEXT NOT NULL,
    data_snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    initial_cash_cents BIGINT NOT NULL CHECK (initial_cash_cents > 0),
    benchmark TEXT NOT NULL DEFAULT '000300.SH',
    universe TEXT NOT NULL DEFAULT '000300.SH',
    frequency TEXT NOT NULL DEFAULT '1d',
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'queued',
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy ON backtest_runs (strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cash_cents BIGINT NOT NULL DEFAULT 0,
    equity_cents BIGINT NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CNY',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_deployments (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    strategy_version TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    status TEXT NOT NULL DEFAULT 'created',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_deployments_status ON live_deployments (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    client_order_id TEXT NOT NULL UNIQUE,
    deployment_id TEXT NOT NULL REFERENCES live_deployments(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
    quantity BIGINT NOT NULL CHECK (quantity > 0),
    filled_quantity BIGINT NOT NULL DEFAULT 0,
    price_cents BIGINT NOT NULL CHECK (price_cents > 0),
    status TEXT NOT NULL DEFAULT 'accepted',
    reject_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_deployment ON orders (deployment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_account ON orders (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fills (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    quantity BIGINT NOT NULL CHECK (quantity > 0),
    price_cents BIGINT NOT NULL CHECK (price_cents > 0),
    commission_cents BIGINT NOT NULL DEFAULT 0,
    stamp_tax_cents BIGINT NOT NULL DEFAULT 0,
    transfer_fee_cents BIGINT NOT NULL DEFAULT 0,
    filled_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fills_order ON fills (order_id);

CREATE TABLE IF NOT EXISTS positions (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    symbol TEXT NOT NULL,
    quantity BIGINT NOT NULL DEFAULT 0,
    available_quantity BIGINT NOT NULL DEFAULT 0,
    avg_cost_cents BIGINT NOT NULL DEFAULT 0,
    market_price_cents BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, symbol)
);

CREATE TABLE IF NOT EXISTS risk_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    config JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_reports (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    business_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    breaks JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO accounts (id, name, cash_cents, equity_cents, currency)
VALUES ('acc_demo', 'Demo account', 100000000, 100000000, 'CNY')
ON CONFLICT (id) DO NOTHING;

INSERT INTO risk_rules (id, name, scope, config)
VALUES (
    'default',
    'Default risk limits',
    'global',
    '{"max_order_notional_cents":5000000,"max_position_percent_bps":1000,"max_price_deviation_bps":300,"max_order_quantity":1000000,"lot_size":100,"commission_bps":25,"min_commission_cents":500,"stamp_tax_bps":50,"transfer_fee_bps":1}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

