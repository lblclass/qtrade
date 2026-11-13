import { useCallback, useEffect, useState } from "react";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/ui";
import { RefreshContext } from "./lib/refresh";
import { OverviewPage } from "./pages/Overview";
import { DataCenterPage } from "./pages/DataCenter";
import { StrategiesPage, StrategyDetailPage } from "./pages/Strategies";
import { BacktestsPage, BacktestDetailPage } from "./pages/Backtests";
import { DeploymentsPage } from "./pages/Deployments";
import { TradingPage } from "./pages/Trading";
import { IPOPage } from "./pages/IPO";
import { RiskPage } from "./pages/Risk";
import { MonitoringPage } from "./pages/Monitoring";

type Route = { path: string; query: URLSearchParams };

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/overview";
  const [path, queryString] = raw.split("?");
  return {
    path: path || "/overview",
    query: new URLSearchParams(queryString ?? ""),
  };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [token, setToken] = useState(0);

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((path: string) => {
    window.location.hash = path.startsWith("/") ? path : `/${path}`;
    setRoute(parseHash());
  }, []);

  const refresh = useCallback(() => setToken((value) => value + 1), []);
  const segments = route.path.split("/").filter(Boolean);
  const section = segments[0] ?? "overview";

  let page = <OverviewPage onNavigate={navigate} />;
  if (section === "data") {
    page = <DataCenterPage initialQuery={route.query.get("q") ?? ""} onNavigate={navigate} />;
  } else if (section === "strategies") {
    page = segments[1]
      ? <StrategyDetailPage strategyId={segments[1]} onNavigate={navigate} />
      : <StrategiesPage onCreate={route.query.get("create") === "1"} onNavigate={navigate} />;
  } else if (section === "backtests") {
    page = segments[1]
      ? <BacktestDetailPage backtestId={segments[1]} onNavigate={navigate} />
      : <BacktestsPage onCreate={route.query.get("create") === "1"} onNavigate={navigate} />;
  } else if (section === "deployments") {
    page = (
      <DeploymentsPage
        create={route.query.get("create") === "1"}
        focus={route.query.get("focus") ?? ""}
        onNavigate={navigate}
      />
    );
  } else if (section === "trading") {
    page = (
      <TradingPage
        initialSymbol={route.query.get("symbol") ?? ""}
        initialDeployment={route.query.get("deployment") ?? ""}
        onNavigate={navigate}
      />
    );
  } else if (section === "ipo") {
    page = <IPOPage onNavigate={navigate} />;
  } else if (section === "risk") {
    page = <RiskPage onNavigate={navigate} />;
  } else if (section === "monitoring") {
    page = <MonitoringPage />;
  }

  return (
    <RefreshContext.Provider value={{ token, refresh }}>
      <ToastProvider>
        <Layout path={route.path} onNavigate={navigate}>
          {page}
        </Layout>
      </ToastProvider>
    </RefreshContext.Provider>
  );
}