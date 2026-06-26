/** VIP theme toggle. The app's default look (authentic WhatsApp white-green —
 *  the `:root` light palette) stays exactly as-is; turning VIP on adds a premium
 *  gold/emerald skin by putting a `vip` class on <html>. Choice is remembered
 *  in localStorage and applies to BOTH the user panel and the admin dashboard. */
const KEY = "wa_theme_vip";

export function isVip(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function applyTheme(): void {
  const el = document.documentElement;
  if (isVip()) el.classList.add("vip");
  else el.classList.remove("vip");
}

export function setVip(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* ignore storage errors (private mode) */
  }
  applyTheme();
}
