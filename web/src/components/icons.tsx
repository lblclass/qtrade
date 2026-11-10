import type { SVGProps } from "react";

export type IconName =
  | "overview" | "data" | "strategy" | "backtest" | "deployment" | "trade"
  | "risk" | "audit" | "refresh" | "plus" | "search" | "chevron" | "play"
  | "pause" | "stop" | "kill" | "close" | "check" | "alert" | "arrowUp"
  | "arrowDown" | "clock" | "shield" | "activity" | "database" | "layers"
  | "menu" | "external" | "flask" | "pulse" | "server" | "sun" | "moon" | "edit"

const PATHS: Record<IconName, string> = {
  overview: "M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-11h6V4h-6v5Z",
  data: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  strategy: "M4 19V5m0 14h16M7 15l4-4 3 3 5-7",
  backtest: "M4 5h16M4 12h10M4 19h7M17 10v9m-3-3 3 3 3-3",
  deployment: "M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3",
  trade: "M4 7h14m0 0-4-4m4 4-4 4M20 17H6m0 0 4 4m-4-4 4-4",
  risk: "M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4Zm0 5v5m0 3v.01",
  audit: "M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h6M9 16h6",
  refresh: "M20 7v5h-5M4 17v-5h5M6.1 9a7 7 0 0 1 11.4-2.4L20 9M4 15l2.5 2.4A7 7 0 0 0 17.9 15",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2 4 4",
  chevron: "m9 6 6 6-6 6",
  play: "M7 4l13 8-13 8V4Z",
  pause: "M8 5v14M16 5v14",
  stop: "M6 6h12v12H6z",
  kill: "M6 6l12 12M18 6 6 18",
  close: "M6 6l12 12M18 6 6 18",
  check: "m5 13 4 4L19 7",
  alert: "M12 3 2 21h20L12 3Zm0 6v6m0 3v.01",
  arrowUp: "M12 19V5m0 0-6 6m6-6 6 6",
  arrowDown: "M12 5v14m0 0 6-6m-6 6-6-6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2",
  shield: "M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z",
  activity: "M3 12h4l2-6 4 12 2-6h6",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5",
  menu: "M4 6h16M4 12h16M4 18h16",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  flask: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7 15h10",
  pulse: "M3 12h4l2-5 4 10 2-5h6",
  server: "M4 4h16v6H4V4Zm0 10h16v6H4v-6Zm4-7h.01M8 17h.01",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-14v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z",
  edit: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM14 6l4 4",
};

type IconProps = SVGProps<SVGSVGElement> & { name: IconName; size?: number };

export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}