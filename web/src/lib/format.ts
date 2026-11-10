export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const STATUS_LABELS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "草稿", tone: "neutral" },
  backtesting: { label: "回测中", tone: "info" },
  review: { label: "评审中", tone: "warn" },
  paper: { label: "模拟盘", tone: "info" },
  canary: { label: "灰度", tone: "warn" },
  live: { label: "实盘", tone: "good" },
  paused: { label: "已暂停", tone: "warn" },
  retired: { label: "已退役", tone: "neutral" },

  queued: { label: "排队中", tone: "warn" },
  running: { label: "运行中", tone: "good" },
  succeeded: { label: "已完成", tone: "good" },
  failed: { label: "失败", tone: "bad" },
  canceled: { label: "已取消", tone: "neutral" },

  created: { label: "已创建", tone: "neutral" },
  degraded: { label: "降级", tone: "bad" },
  stopped: { label: "已停止", tone: "neutral" },

  accepted: { label: "已受理", tone: "info" },
  rejected: { label: "风控拒绝", tone: "bad" },
  partially_filled: { label: "部分成交", tone: "warn" },
  filled: { label: "已成交", tone: "good" },

  ok: { label: "正常", tone: "good" },
  down: { label: "异常", tone: "bad" },
  blocker: { label: "阻塞", tone: "bad" },
  warning: { label: "警告", tone: "warn" },
  info: { label: "提示", tone: "info" },
  buy: { label: "买入", tone: "bad" },
  sell: { label: "卖出", tone: "good" },
  market: { label: "市价", tone: "neutral" },
  limit: { label: "限价", tone: "neutral" },
  paper_mode: { label: "模拟", tone: "info" },
};

export function statusMeta(value: string): { label: string; tone: Tone } {
  return STATUS_LABELS[value] ?? { label: value || "-", tone: "neutral" };
}

const cny = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integer = new Intl.NumberFormat("zh-CN");

export function formatCNY(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "-";
  return cny.format(cents / 100);
}

export function formatCompactCNY(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "-";
  const yuan = cents / 100;
  const absolute = Math.abs(yuan);
  if (absolute >= 100_000_000) return `${(yuan / 100_000_000).toFixed(2)} 亿`;
  if (absolute >= 10_000) return `${(yuan / 10_000).toFixed(1)} 万`;
  return yuan.toFixed(2);
}

export function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "-";
  return `¥${(cents / 100).toFixed(2)}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return integer.format(value);
}

export function formatBPS(bps: number | null | undefined, digits = 2): string {
  if (bps === null || bps === undefined || Number.isNaN(bps)) return "-";
  return `${(bps / 100).toFixed(digits)}%`;
}

export function formatSignedBPS(bps: number | null | undefined, digits = 2): string {
  if (bps === null || bps === undefined || Number.isNaN(bps)) return "-";
  const value = (bps / 100).toFixed(digits);
  return `${bps > 0 ? "+" : ""}${value}%`;
}

export function trendClass(bps: number | null | undefined): string {
  if (!bps) return "flat";
  return bps > 0 ? "positive" : "negative";
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)} 天前`;
  return formatDate(value);
}

export function shortId(value: string, length = 14): string {
  if (!value) return "-";
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function toCents(yuan: number): number {
  return Math.round(yuan * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgoISO(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}