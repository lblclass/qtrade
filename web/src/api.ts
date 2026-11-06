export type Health = {
  status: string;
  service: string;
};

export type Strategy = {
  id: string;
  name: string;
  description?: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type Deployment = {
  id: string;
  strategy_id: string;
  strategy_version: string;
  mode: string;
  account_id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type Account = {
  id: string;
  name: string;
  cash_cents: number;
  equity_cents: number;
  currency: string;
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

type ListResponse<T> = {
  items: T[];
  count: number;
};

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchDashboard() {
  const [health, strategies, deployments, accounts, risk] = await Promise.all([
    getJSON<Health>("/healthz"),
    getJSON<ListResponse<Strategy>>("/api/v1/strategies"),
    getJSON<ListResponse<Deployment>>("/api/v1/live-deployments"),
    getJSON<ListResponse<Account>>("/api/v1/accounts"),
    getJSON<RiskLimits>("/api/v1/risk/rules"),
  ]);
  return { health, strategies, deployments, accounts, risk };
}

export async function createDemoStrategy(name: string): Promise<Strategy> {
  const response = await fetch("/api/v1/strategies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: "Created from the web console skeleton",
    }),
  });
  if (!response.ok) {
    throw new Error(`create strategy returned ${response.status}`);
  }
  return (await response.json()) as Strategy;
}

export function formatCNY(cents: number): string {
  return (cents / 100).toLocaleString("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 2,
  });
}

