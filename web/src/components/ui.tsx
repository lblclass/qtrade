import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";
import { statusMeta, type Tone } from "../lib/format";

export function Badge({
  value,
  label,
  tone,
  dot = false,
}: {
  value: string;
  label?: string;
  tone?: Tone;
  dot?: boolean;
}) {
  const meta = statusMeta(value);
  return (
    <span className={`badge badge-${tone ?? meta.tone}`}>
      {dot ? <span className="badge-dot" /> : null}
      {label ?? meta.label}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  flush = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`panel ${flush ? "panel-flush" : ""} ${className}`}>
      {title || actions ? (
        <header className="panel-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Stat({
  label,
  value,
  hint,
  delta,
  deltaTone = "flat",
  icon,
  accent = "blue",
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: ReactNode;
  deltaTone?: "positive" | "negative" | "flat";
  icon?: IconName;
  accent?: "blue" | "green" | "amber" | "violet";
  onClick?: () => void;
}) {
  return (
    <article className={`kpi kpi-${accent} ${onClick ? "kpi-clickable" : ""}`} onClick={onClick}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {icon ? (
          <span className="kpi-icon">
            <Icon name={icon} size={16} />
          </span>
        ) : null}
      </div>
      <strong className="kpi-value">{value}</strong>
      <div className="kpi-foot">
        {delta ? <span className={`kpi-delta ${deltaTone}`}>{delta}</span> : null}
        {hint ? <span className="kpi-hint">{hint}</span> : null}
      </div>
    </article>
  );
}

export function EmptyState({
  icon = "layers",
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action ? <div className="empty-actions">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label = "加载中" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-block">
      <Icon name="alert" size={18} />
      <div>
        <strong>请求失败</strong>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required ? <em>*</em> : null}
      </span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={option.value === value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined ? <span className="seg-count">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

export function Progress({
  value,
  max = 100,
  tone = "blue",
  label,
}: {
  value: number;
  max?: number;
  tone?: "blue" | "green" | "amber" | "red";
  label?: ReactNode;
}) {
  const percent = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="progress-wrap">
      {label ? <div className="progress-label">{label}</div> : null}
      <div className="progress">
        <span className={`progress-fill progress-${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="key-values">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type ToastTone = "good" | "bad" | "info";
type ToastItem = { id: number; message: string; tone: ToastTone };
type ToastContextValue = { push: (message: string, tone?: ToastTone) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const push = useCallback((message: string, tone: ToastTone = "info") => {
    counter.current += 1;
    const id = counter.current;
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4200);
  }, []);
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-stack">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <Icon name={item.tone === "bad" ? "alert" : item.tone === "good" ? "check" : "activity"} size={16} />
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}