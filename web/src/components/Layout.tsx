import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { useRefresh } from "../lib/refresh";
import { Icon, type IconName } from "./icons";

type NavItem = { path: string; label: string; icon: IconName; hint?: string };
type NavGroup = { label: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    label: "工作台",
    items: [
      { path: "/overview", label: "驾驶舱", icon: "overview", hint: "全生命周期总览" },
      { path: "/data", label: "数据中心", icon: "data", hint: "行情与数据质量" },
    ],
  },
  {
    label: "策略研发",
    items: [
      { path: "/strategies", label: "策略库", icon: "strategy", hint: "版本与状态流转" },
      { path: "/backtests", label: "回测中心", icon: "backtest", hint: "任务与绩效归因" },
      { path: "/deployments", label: "部署管理", icon: "deployment", hint: "模拟盘 / 实盘" },
    ],
  },
  {
    label: "交易执行",
    items: [
      { path: "/trading", label: "交易台", icon: "trade", hint: "下单与持仓" },
      { path: "/ipo", label: "打新中心", icon: "flask", hint: "新股与新债申购" },
      { path: "/risk", label: "风险控制", icon: "risk", hint: "限额与拒单" },
    ],
  },
  {
    label: "系统",
    items: [
      { path: "/monitoring", label: "监控与审计", icon: "audit", hint: "日志与网关" },
    ],
  },
];

const TITLES: Record<string, string> = {
  overview: "驾驶舱",
  data: "数据中心",
  strategies: "策略库",
  backtests: "回测中心",
  deployments: "部署管理",
  trading: "交易台",
  ipo: "打新中心",
  risk: "风险控制",
  monitoring: "监控与审计",
};

function sectionOf(path: string): string {
  const key = path.split("/").filter(Boolean)[0] ?? "overview";
  return TITLES[key] ?? "驾驶舱";
}

export function Layout({
  path,
  onNavigate,
  children,
}: {
  path: string;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [health, setHealth] = useState<"ok" | "down" | "checking">("checking");
  const [clock, setClock] = useState(() => new Date());
  const [search, setSearch] = useState("");
  const [latency, setLatency] = useState<number | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = window.localStorage.getItem("qtrade-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const { refresh } = useRefresh();
  const lastPath = useRef(path);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      const started = performance.now();
      try {
        await api.health();
        if (active) {
          setHealth("ok");
          setLatency(Math.round(performance.now() - started));
        }
      } catch {
        if (active) setHealth("down");
      }
    };
    void poll();
    const timer = window.setInterval(poll, 20_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("qtrade-theme", theme);
  }, [theme]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (lastPath.current !== path) {
      setMenuOpen(false);
      lastPath.current = path;
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [path]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const query = search.trim();
    if (query) onNavigate(`/data?q=${encodeURIComponent(query)}`);
    setSearch("");
  };

  return (
    <div className="app">
      {menuOpen ? <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} /> : null}
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand" onClick={() => onNavigate("/overview")}>
          <span className="brand-mark">Q</span>
          <div>
            <strong>qtrade</strong>
            <small>quant trading desk</small>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map((item) => {
                const active = item.path === "/overview"
                  ? path === "/overview" || path === "/"
                  : path.startsWith(item.path);
                return (
                  <button
                    type="button"
                    key={item.path}
                    className={`nav-item ${active ? "active" : ""}`}
                    onClick={() => onNavigate(item.path)}
                    title={item.hint}
                  >
                    <Icon name={item.icon} size={17} />
                    <span>{item.label}</span>
                    {item.path === "/trading" ? <span className="nav-pulse" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="env-row">
            <span className={`status-dot status-${health}`} />
            <div>
              <strong>{health === "ok" ? "API 在线" : health === "down" ? "API 异常" : "连接中"}</strong>
              <small>{latency !== null ? `${latency} ms · 内存存储` : "control plane"}</small>
            </div>
          </div>
          <p className="side-note">行情数据 · {new Date().toLocaleDateString("zh-CN")} 17:30 日更</p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button type="button" className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="菜单">
              <Icon name="menu" size={19} />
            </button>
            <div className="crumb">
              <span>qtrade</span>
              <Icon name="chevron" size={13} />
              <strong>{sectionOf(path)}</strong>
            </div>
          </div>
          <div className="topbar-right">
            <form className="global-search" onSubmit={submitSearch}>
              <Icon name="search" size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索股票代码 / 名称"
                aria-label="全局搜索"
              />
              <kbd>↵</kbd>
            </form>
            <span className="clock">
              <Icon name="clock" size={14} />
              {clock.toLocaleTimeString("zh-CN", {
                timeZone: "Asia/Shanghai",
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
            <span className={`api-pill api-${health}`}>
              <span className={`status-dot status-${health}`} />
              {health === "ok" ? "LIVE" : health === "down" ? "DOWN" : "SYNC"}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              title={theme === "light" ? "切换到深色" : "切换到浅色"}
              aria-label="切换主题"
            >
              <Icon name={theme === "light" ? "moon" : "sun"} size={17} />
            </button>
            <button type="button" className="icon-btn" onClick={refresh} title="刷新数据" aria-label="刷新数据">
              <Icon name="refresh" size={17} />
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
