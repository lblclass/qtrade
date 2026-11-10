import { useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type ChartSeries = {
  name: string;
  color: string;
  points: { label: string; value: number }[];
};

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

export function LineChart({
  series,
  height = 260,
  formatValue = (value) => value.toLocaleString("zh-CN"),
  showLegend = true,
}: {
  series: ChartSeries[];
  height?: number;
  formatValue?: (value: number) => string;
  showLegend?: boolean;
}) {
  const gradientId = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const width = 820;
  const padding = { left: 64, right: 18, top: 18, bottom: 28 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const active = series.filter((item) => item.points.length > 0);
  if (active.length === 0) return <div className="chart-empty">暂无数据</div>;

  const labels = active.reduce((best, item) => (item.points.length > best.length ? item.points : best), active[0].points)
    .map((point) => point.label);
  const count = labels.length;
  const values = active.flatMap((item) => item.points.map((point) => point.value));
  let min = Math.min(...values);
  let max = Math.max(...values);
  const pad = (max - min) * 0.06 || Math.abs(max) * 0.02 || 1;
  min -= pad;
  max += pad;
  const ticks = niceTicks(min, max, 4);
  const xFor = (index: number) => padding.left + (count <= 1 ? 0 : (plotWidth * index) / (count - 1));
  const yFor = (value: number) => padding.top + plotHeight - ((value - min) / (max - min)) * plotHeight;

  const pathFor = (points: { value: number }[]) =>
    points
      .map((point, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(2)},${yFor(point.value).toFixed(2)}`)
      .join(" ");

  const first = active[0];
  const areaPath = `${pathFor(first.points)} L${xFor(first.points.length - 1).toFixed(2)},${padding.top + plotHeight} L${padding.left},${padding.top + plotHeight} Z`;
  const xTickIndexes = Array.from(new Set([0, Math.floor((count - 1) / 4), Math.floor((count - 1) / 2), Math.floor(((count - 1) * 3) / 4), count - 1]));

  const handleMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = Math.min(1, Math.max(0, (x - padding.left) / plotWidth));
    setHover(Math.round(ratio * (count - 1)));
  };

  const hoverLabel = hover !== null ? labels[hover] : null;
  const hoverLeft = hover !== null ? (xFor(hover) / width) * 100 : 0;

  return (
    <div className="chart">
      {showLegend ? (
        <div className="chart-legend">
          {active.map((item) => (
            <span key={item.name}>
              <i style={{ background: item.color }} />
              {item.name}
            </span>
          ))}
        </div>
      ) : null}
      <div className="chart-canvas">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          onPointerMove={handleMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`area-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={first.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={first.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={yFor(tick)}
                y2={yFor(tick)}
                stroke="rgba(126, 154, 186, 0.14)"
                strokeDasharray="3 5"
              />
              <text x={padding.left - 10} y={yFor(tick) + 4} textAnchor="end" className="chart-axis">
                {formatValue(tick)}
              </text>
            </g>
          ))}
          <path d={areaPath} fill={`url(#area-${gradientId})`} />
          {active.map((item) => (
            <path
              key={item.name}
              d={pathFor(item.points)}
              fill="none"
              stroke={item.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {xTickIndexes.map((index) => (
            <text key={index} x={xFor(index)} y={height - 8} textAnchor="middle" className="chart-axis">
              {labels[index]?.slice(2) ?? ""}
            </text>
          ))}
          {hover !== null ? (
            <g>
              <line
                x1={xFor(hover)}
                x2={xFor(hover)}
                y1={padding.top}
                y2={padding.top + plotHeight}
                stroke="rgba(180, 205, 235, 0.45)"
              />
              {active.map((item) => {
                const point = item.points[hover];
                if (!point) return null;
                return <circle key={item.name} cx={xFor(hover)} cy={yFor(point.value)} r={3.6} fill={item.color} stroke="#0b1119" strokeWidth={2} />;
              })}
            </g>
          ) : null}
        </svg>
        {hover !== null ? (
          <div
            className="chart-tooltip"
            style={{
              left: `${Math.min(88, Math.max(12, hoverLeft))}%`,
            }}
          >
            <strong>{hoverLabel}</strong>
            {active.map((item) => {
              const point = item.points[hover];
              if (!point) return null;
              return (
                <span key={item.name}>
                  <i style={{ background: item.color }} />
                  {item.name}
                  <b>{formatValue(point.value)}</b>
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Donut({
  segments,
  centerLabel,
  centerValue,
  size = 148,
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel?: string;
  centerValue?: string;
  size?: number;
}) {
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox="0 0 140 140" className="donut">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="rgba(120, 145, 175, 0.12)" strokeWidth="14" />
        <g transform="rotate(-90 70 70)">
          {segments.map((segment) => {
            const length = total > 0 ? (segment.value / total) * circumference : 0;
            const element = (
              <circle
                key={segment.label}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth="14"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += length;
            return element;
          })}
        </g>
        <text x="70" y="66" textAnchor="middle" className="donut-value">
          {centerValue ?? total}
        </text>
        <text x="70" y="84" textAnchor="middle" className="donut-label">
          {centerLabel ?? "合计"}
        </text>
      </svg>
      <ul className="donut-legend">
        {segments.map((segment) => (
          <li key={segment.label}>
            <i style={{ background: segment.color }} />
            <span>{segment.label}</span>
            <b>{segment.value}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Sparkline({
  values,
  color = "#4f8cff",
  width = 120,
  height = 34,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 4) - 2;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="sparkline">
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
