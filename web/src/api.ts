export type Health = { status: string; service: string };
export type Meta = { api_version: string; environment: string; now: string };

export type StrategyStatus =
  | "draft" | "backtesting" | "review" | "paper" | "canary" | "live" | "paused" | "retired";

export type Strategy = {
  id: string;
  name: string;
  description?: string;
  status: StrategyStatus;
  created_at: string;
  updated_at: string;
};

export type StrategyVersion = {
  id: string;
  strategy_id: string;
  version: string;
  artifact_digest: string;
  python_version: string;
  created_at: string;
};

export type BacktestStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type EquityPoint = { date: string; equity_cents?: number; benchmark_cents?: number };

export type BacktestMetrics = {
  total_return_bps?: number;
  annualized_return_bps?: number;
  benchmark_return_bps?: number;
  alpha_bps?: number;
  max_drawdown_bps?: number;
  sharpe?: number;
  sortino?: number;
  calmar?: number;
  win_rate_bps?: number;
  turnover_bps?: number;
  trade_count?: number;
  volatility_bps?: number;
  equity_curve?: EquityPoint[];
  benchmark_curve?: EquityPoint[];
  error?: string;
  [key: string]: unknown;
};

export type BacktestRun = {
  id: string;
  strategy_id: string;
  strategy_version: string;
  data_snapshot_id: string;
  start_date: string;
  end_date: string;
  initial_cash_cents: number;
  benchmark: string;
  universe: string;
  frequency: string;
  params?: Record<string, unknown>;
  status: BacktestStatus;
  metrics?: BacktestMetrics;
  created_at: string;
  updated_at: string;
};

export type DeploymentMode = "paper" | "live";
export type DeploymentStatus = "created" | "running" | "paused" | "degraded" | "stopped";

export type LiveDeployment = {
  id: string;
  strategy_id: string;
  strategy_version: string;
  mode: DeploymentMode;
  account_id: string;
  status: DeploymentStatus;
  last_error?: string;
  created_at: string;
  updated_at: string;
};

export type OrderStatus = "accepted" | "rejected" | "partially_filled" | "filled" | "canceled";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export type Order = {
  id: string;
  client_order_id: string;
  deployment_id: string;
  account_id: string;
  symbol: string;
  side: OrderSide;
  order_type: OrderType;
  quantity: number;
  filled_quantity: number;
  price_cents: number;
  status: OrderStatus;
  reject_reason?: string;
  created_at: string;
  updated_at: string;
};

export type Position = {
  account_id: string;
  symbol: string;
  quantity: number;
  available_quantity: number;
  avg_cost_cents: number;
  market_price_cents: number;
};

export type Account = {
  id: string;
  name: string;
  cash_cents: number;
  equity_cents: number;
  currency: string;
};

export type RunLog = {
  id: string;
  level: "info" | "warn" | "error";
  source: string;
  resource_type: string;
  resource_id: string;
  message: string;
  created_at: string;
};

export type AccountEquityPoint = {
  date: string;
  equity_cents: number;
  market_value_cents: number;
  cash_cents: number;
  pnl_cents: number;
  pnl_bps: number;
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  detail?: string;
  created_at: string;
};

export type RiskLimits = {
  max_order_notional_cents: number;
  max_position_percent_bps: number;
  max_price_deviation_bps: number;
  max_order_quantity: number;
  lot_size: number;
  commission_bps: number;
  min_commission_cents: number;
  stamp_tax_bps: number;
  transfer_fee_bps: number;
};

export type GatewayHealth = {
  name: string;
  status: string;
  latency_ms: number;
  checked_at: string;
};

export type Instrument = {
  symbol: string;
  name: string;
  exchange: string;
  board: string;
  is_active: boolean;
  list_date?: string;
};

export type Quote = {
  symbol: string;
  name: string;
  exchange: string;
  close_cents: number;
  prev_close_cents: number;
  change_bps: number;
  volume: number;
  amount_cents: number;
  limit_up_cents: number;
  limit_down_cents: number;
  trade_date: string;
};

export type DatasetSummary = {
  key: string;
  label: string;
  frequency: string;
  interval: number | null;
  symbols: number;
  rows: number;
  start: string | null;
  end: string | null;
  updated_at: string | null;
};

export type SnapshotSummary = {
  snapshot_id: string;
  dataset: string;
  interval: number | null;
  rows: number;
  symbols: number;
  start: string | null;
  end: string | null;
  source: string;
  adjust: string;
  storage: string;
  created_at: string;
  quality: {
    checked: number;
    accepted: number;
    dropped: number;
    blockers: number;
    warnings: number;
    duplicates: number;
  };
};

export type QualitySummary = {
  source: string;
  total: number;
  blockers: number;
  warnings: number;
  by_code: { code: string; level: string; count: number }[];
  samples: { code: string; level: string; message: string }[];
  trading_calendar: { days: number; start: string | null; end: string | null };
  instrument_master_rows: number;
};

export type DataOverview = {
  available: boolean;
  reason?: string;
  generated_at?: string;
  datasets?: DatasetSummary[];
  snapshots?: SnapshotSummary[];
  quality?: QualitySummary;
  instruments?: { count: number; active: number; snapshot: string | null };
  quotes?: {
    count: number;
    trade_date: string | null;
    up: number;
    down: number;
    flat: number;
    limit_up: number;
    limit_down: number;
  };
};

export type ListResponse<T> = { items: T[]; count: number };

export type Violation = { code: string; message: string };

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const body = payload as
      | { error?: { code?: string; message?: string; details?: unknown } }
      | undefined;
    throw new ApiError(
      response.status,
      body?.error?.code ?? `http_${response.status}`,
      body?.error?.message ?? `${path} returned ${response.status}`,
      body?.error?.details,
    );
  }
  return payload as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const api = {
  health: () => get<Health>("/healthz"),
  meta: () => get<Meta>("/api/v1/meta"),

  strategies: () => get<ListResponse<Strategy>>("/api/v1/strategies"),
  strategy: (id: string) => get<Strategy>(`/api/v1/strategies/${id}`),
  createStrategy: (body: { name: string; description?: string }) =>
    post<Strategy>("/api/v1/strategies", body),
  updateStrategy: (id: string, body: { name?: string; description?: string }) =>
    patch<Strategy>(`/api/v1/strategies/${id}`, body),
  updateStrategyStatus: (id: string, status: StrategyStatus) =>
    patch<Strategy>(`/api/v1/strategies/${id}/status`, { status }),
  simulateStrategy: (
    id: string,
    body: {
      start_date?: string;
      end_date?: string;
      initial_cash_cents?: number;
      params?: Record<string, unknown>;
    } = {},
  ) => post<BacktestRun>(`/api/v1/strategies/${id}/simulate`, body),
  deployStrategy: (id: string, body: { mode?: DeploymentMode; account_id?: string } = {}) =>
    post<LiveDeployment>(`/api/v1/strategies/${id}/deploy`, body),
  versions: (id: string) => get<ListResponse<StrategyVersion>>(`/api/v1/strategies/${id}/versions`),
  createVersion: (
    id: string,
    body: { version: string; artifact_digest: string; python_version?: string },
  ) => post<StrategyVersion>(`/api/v1/strategies/${id}/versions`, body),

  backtests: () => get<ListResponse<BacktestRun>>("/api/v1/backtests"),
  backtest: (id: string) => get<BacktestRun>(`/api/v1/backtests/${id}`),
  createBacktest: (body: {
    strategy_id: string;
    strategy_version: string;
    data_snapshot_id: string;
    start_date: string;
    end_date: string;
    initial_cash_cents: number;
    benchmark?: string;
    universe?: string;
    frequency?: string;
    params?: Record<string, unknown>;
  }) => post<BacktestRun>("/api/v1/backtests", body),
  cancelBacktest: (id: string) => post<BacktestRun>(`/api/v1/backtests/${id}/cancel`),

  deployments: () => get<ListResponse<LiveDeployment>>("/api/v1/live-deployments"),
  createDeployment: (body: {
    strategy_id: string;
    strategy_version: string;
    mode: DeploymentMode;
    account_id: string;
  }) => post<LiveDeployment>("/api/v1/live-deployments", body),
  deploymentAction: (id: string, action: string) =>
    post<LiveDeployment>(`/api/v1/live-deployments/${id}/${action}`),

  orders: (params?: { deployment_id?: string; account_id?: string }) => {
    const query = new URLSearchParams();
    if (params?.deployment_id) query.set("deployment_id", params.deployment_id);
    if (params?.account_id) query.set("account_id", params.account_id);
    const suffix = query.size ? `?${query.toString()}` : "";
    return get<ListResponse<Order>>(`/api/v1/orders${suffix}`);
  },
  createOrder: (body: {
    client_order_id: string;
    deployment_id: string;
    account_id: string;
    symbol: string;
    side: OrderSide;
    order_type: OrderType;
    quantity: number;
    price_cents: number;
    last_price_cents?: number;
    limit_up_cents?: number;
    limit_down_cents?: number;
  }) => post<Order>("/api/v1/orders", body),
  cancelOrder: (id: string) => post<Order>(`/api/v1/orders/${id}/cancel`),

  positions: (accountId?: string) =>
    get<ListResponse<Position>>(
      accountId ? `/api/v1/positions?account_id=${encodeURIComponent(accountId)}` : "/api/v1/positions",
    ),
  accounts: () => get<ListResponse<Account>>("/api/v1/accounts"),
  riskLimits: () => get<RiskLimits>("/api/v1/risk/rules"),
  auditLogs: (limit = 100) => get<ListResponse<AuditEvent>>(`/api/v1/audit-logs?limit=${limit}`),
  logs: (params: { resource_type?: string; resource_id?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.resource_type) query.set("resource_type", params.resource_type);
    if (params.resource_id) query.set("resource_id", params.resource_id);
    query.set("limit", String(params.limit ?? 100));
    return get<ListResponse<RunLog>>(`/api/v1/logs?${query.toString()}`);
  },
  accountEquity: (accountId: string, days = 60) =>
    get<{ account_id: string; available?: boolean; reason?: string; base?: string; points: AccountEquityPoint[] }>(
      `/api/v1/accounts/${accountId}/equity?days=${days}`,
    ),
  gateways: () => get<ListResponse<GatewayHealth>>("/api/v1/gateways"),

  dataOverview: () => get<DataOverview>("/api/v1/data/overview"),
  instruments: (q: string, limit = 30) =>
    get<ListResponse<Instrument> & { available: boolean }>(
      `/api/v1/market/instruments?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  quotes: (params: { q?: string; symbols?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.symbols) query.set("symbols", params.symbols);
    query.set("limit", String(params.limit ?? 30));
    return get<ListResponse<Quote> & { available: boolean }>(`/api/v1/market/quotes?${query}`);
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (Array.isArray(error.details)) {
      return error.details
        .map((item) => (typeof item === "object" && item && "message" in item
          ? String((item as { message: unknown }).message)
          : String(item)))
        .join("；");
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}