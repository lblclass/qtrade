-- Market data schema. Prices use NUMERIC; trading/accounting paths use integer cents.

CREATE TABLE IF NOT EXISTS instrument_master (
    symbol TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    exchange TEXT NOT NULL,
    board TEXT NOT NULL DEFAULT '',
    list_date DATE,
    delist_date DATE,
    lot_size INTEGER NOT NULL DEFAULT 100 CHECK (lot_size > 0),
    price_limit_rule TEXT NOT NULL DEFAULT 'default',
    is_active BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trading_calendar (
    exchange TEXT NOT NULL,
    trade_date DATE NOT NULL,
    is_open BOOLEAN NOT NULL DEFAULT true,
    session TEXT NOT NULL DEFAULT 'regular',
    PRIMARY KEY (exchange, trade_date)
);

CREATE TABLE IF NOT EXISTS bar_1d (
    symbol TEXT NOT NULL REFERENCES instrument_master(symbol),
    trade_date DATE NOT NULL,
    open NUMERIC(18, 4) NOT NULL CHECK (open > 0),
    high NUMERIC(18, 4) NOT NULL CHECK (high > 0),
    low NUMERIC(18, 4) NOT NULL CHECK (low > 0),
    close NUMERIC(18, 4) NOT NULL CHECK (close > 0),
    volume BIGINT NOT NULL CHECK (volume >= 0),
    amount NUMERIC(20, 2) NOT NULL DEFAULT 0,
    adj_factor NUMERIC(18, 8) NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT '',
    snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
    PRIMARY KEY (snapshot_id, symbol, trade_date),
    CHECK (high >= low),
    CHECK (open BETWEEN low AND high),
    CHECK (close BETWEEN low AND high)
);

CREATE INDEX IF NOT EXISTS idx_bar_1d_trade_date ON bar_1d (trade_date);
CREATE INDEX IF NOT EXISTS idx_bar_1d_snapshot ON bar_1d (snapshot_id);

CREATE TABLE IF NOT EXISTS bar_1m (
    symbol TEXT NOT NULL REFERENCES instrument_master(symbol),
    ts TIMESTAMPTZ NOT NULL,
    open NUMERIC(18, 4) NOT NULL CHECK (open > 0),
    high NUMERIC(18, 4) NOT NULL CHECK (high > 0),
    low NUMERIC(18, 4) NOT NULL CHECK (low > 0),
    close NUMERIC(18, 4) NOT NULL CHECK (close > 0),
    volume BIGINT NOT NULL CHECK (volume >= 0),
    amount NUMERIC(20, 2) NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '',
    snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
    PRIMARY KEY (snapshot_id, symbol, ts),
    CHECK (high >= low),
    CHECK (open BETWEEN low AND high),
    CHECK (close BETWEEN low AND high)
);

CREATE INDEX IF NOT EXISTS idx_bar_1m_ts ON bar_1m (ts);
CREATE INDEX IF NOT EXISTS idx_bar_1m_snapshot ON bar_1m (snapshot_id);

CREATE TABLE IF NOT EXISTS corporate_action (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL REFERENCES instrument_master(symbol),
    ex_date DATE NOT NULL,
    action_type TEXT NOT NULL,
    cash_per_share NUMERIC(18, 6) NOT NULL DEFAULT 0,
    ratio NUMERIC(18, 8) NOT NULL DEFAULT 0,
    adj_factor NUMERIC(18, 8) NOT NULL DEFAULT 1,
    announce_date DATE,
    source TEXT NOT NULL DEFAULT '',
    snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
    UNIQUE (snapshot_id, symbol, ex_date, action_type)
);

CREATE INDEX IF NOT EXISTS idx_corporate_action_symbol_ex_date ON corporate_action (symbol, ex_date);

CREATE TABLE IF NOT EXISTS suspension (
    symbol TEXT NOT NULL REFERENCES instrument_master(symbol),
    start_date DATE NOT NULL,
    end_date DATE,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
    PRIMARY KEY (snapshot_id, symbol, start_date)
);

CREATE TABLE IF NOT EXISTS risk_flag (
    symbol TEXT NOT NULL REFERENCES instrument_master(symbol),
    trade_date DATE NOT NULL,
    is_st BOOLEAN NOT NULL DEFAULT false,
    is_delisting BOOLEAN NOT NULL DEFAULT false,
    limit_up NUMERIC(18, 4),
    limit_down NUMERIC(18, 4),
    source TEXT NOT NULL DEFAULT '',
    snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
    PRIMARY KEY (snapshot_id, symbol, trade_date)
);

CREATE TABLE IF NOT EXISTS index_constituent (
    index_code TEXT NOT NULL,
    symbol TEXT NOT NULL REFERENCES instrument_master(symbol),
    effective_date DATE NOT NULL,
    weight NUMERIC(12, 8) NOT NULL DEFAULT 0,
    snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
    PRIMARY KEY (snapshot_id, index_code, symbol, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_index_constituent_date ON index_constituent (index_code, effective_date);

CREATE TABLE IF NOT EXISTS financial_report (
    symbol TEXT NOT NULL REFERENCES instrument_master(symbol),
    report_period DATE NOT NULL,
    announce_date DATE NOT NULL,
    metric TEXT NOT NULL,
    value NUMERIC(24, 4) NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
    PRIMARY KEY (snapshot_id, symbol, report_period, metric, announce_date)
);

CREATE INDEX IF NOT EXISTS idx_financial_report_pit ON financial_report (symbol, announce_date);

CREATE TABLE IF NOT EXISTS dataset_snapshot_items (
    snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id) ON DELETE CASCADE,
    dataset TEXT NOT NULL,
    partition TEXT NOT NULL,
    object_uri TEXT NOT NULL,
    checksum TEXT NOT NULL DEFAULT '',
    row_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (snapshot_id, dataset, partition)
);

CREATE TABLE IF NOT EXISTS data_quality_issues (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT REFERENCES dataset_snapshots(id) ON DELETE CASCADE,
    dataset TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('blocker', 'warning', 'info')),
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_quality_issues_snapshot ON data_quality_issues (snapshot_id, level);
