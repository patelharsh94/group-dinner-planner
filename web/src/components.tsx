import { useEffect, useRef, type ReactNode } from "react";

export function Icon({
  name,
  size = 20,
}: {
  name:
    | "arrow"
    | "back"
    | "check"
    | "close"
    | "plus"
    | "settings"
    | "calendar"
    | "people"
    | "share"
    | "leaf"
    | "clock"
    | "chevron";
  size?: number;
}) {
  const paths = {
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    back: (
      <>
        <path d="M19 12H5m6-6-6 6 6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16M9 4v6m6 4v6" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v5m10-5v5M3 11h18" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m3 10v-3a5 5 0 0 0-2-4" />
      </>
    ),
    share: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
      </>
    ),
    leaf: (
      <>
        <path d="M20 4C6 2 2 8 5 15s16 5 15-11Z" />
        <path d="m4 21 11-11" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Button({
  children,
  onClick,
  type = "button",
  busy,
  disabled,
  variant = "primary",
  className = "",
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      {...rest}
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={`button button-${variant} ${className}`}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
export function Notice({
  children,
  kind = "info",
}: {
  children: ReactNode;
  kind?: "info" | "error" | "success";
}) {
  return (
    <div
      className={`notice notice-${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
  optional,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {optional && <span className="optional">Optional</span>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Sheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="sheet"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet-content">
        <div className="sheet-handle" />
        <div className="section-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function Brand({
  back,
  settings,
}: {
  back?: () => void;
  settings?: () => void;
}) {
  return (
    <header className="app-header">
      <div className="header-side">
        {back ? (
          <button className="icon-button" onClick={back} aria-label="Back">
            <Icon name="back" />
          </button>
        ) : (
          <span className="brand-mark" aria-hidden="true">
            m
          </span>
        )}
      </div>
      <span className="wordmark">
        muse<span className="brand-dot">.</span>
      </span>
      <div className="header-side">
        {settings && (
          <button
            className="icon-button"
            aria-label="Settings"
            onClick={settings}
          >
            <Icon name="settings" />
          </button>
        )}
      </div>
    </header>
  );
}
