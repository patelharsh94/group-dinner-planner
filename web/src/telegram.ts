export interface TelegramApp {
  initData: string;
  colorScheme?: "light" | "dark";
  themeParams?: Record<string, string>;
  initDataUnsafe?: { start_param?: string };
  ready(): void;
  expand(): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  onEvent?(event: string, callback: () => void): void;
  offEvent?(event: string, callback: () => void): void;
}
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramApp };
  }
}

export function getTelegram(): TelegramApp | undefined {
  const app = window.Telegram?.WebApp;
  return app?.initData?.trim() ? app : undefined;
}
export function invitationToken(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  // The token selects an invitation only. Authentication always comes from verified initData.
  return (
    params.get("invite") ??
    params.get("tgWebAppStartParam") ??
    window.Telegram?.WebApp?.initDataUnsafe?.start_param
  );
}
export function applyTelegramTheme(app: TelegramApp): void {
  document.documentElement.dataset.theme =
    app.colorScheme === "dark" ? "dark" : "light";
  const colors = app.themeParams ?? {};
  for (const [key, value] of Object.entries(colors)) {
    if (/^#[\da-f]{6}$/i.test(value))
      document.documentElement.style.setProperty(
        `--tg-${key.replaceAll("_", "-")}`,
        value,
      );
  }
}
