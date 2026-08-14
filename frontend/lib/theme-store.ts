"use client";

export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "support-console-theme";

/**
 * Tiny external store for the theme preference.
 *
 * An external store rather than `useState` + `useEffect`, because the theme
 * genuinely lives outside React: an inline script in <head> reads localStorage
 * and stamps `data-theme` before React ever mounts. Syncing that back with an
 * effect means rendering once with the wrong value and then correcting it,
 * which is both a cascading render and a visible flicker.
 *
 * `useSyncExternalStore` reads the real value on the first client render
 * instead, and the server snapshot is "system" — which is what the server
 * genuinely knows, since it cannot see localStorage.
 */

const listeners = new Set<() => void>();

// Cached so getSnapshot returns a stable value; useSyncExternalStore treats a
// changing return as a change and would loop otherwise.
let snapshot: Theme = "system";
let hydrated = false;

function read(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    // Private browsing or blocked storage: fall back to following the OS.
    return "system";
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Keep other tabs in step.
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) {
      snapshot = read();
      listeners.forEach((fn) => fn());
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function getSnapshot(): Theme {
  if (!hydrated) {
    snapshot = read();
    hydrated = true;
  }
  return snapshot;
}

export function getServerSnapshot(): Theme {
  return "system";
}

export function setTheme(next: Theme): void {
  snapshot = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Preference will not persist, but the current session still applies it.
  }
  // Only an explicit choice sets the attribute; "system" removes it so the
  // `prefers-color-scheme` rules in globals.css take over again.
  if (next === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", next);
  }
  listeners.forEach((fn) => fn());
}

/**
 * Applies the stored theme before first paint.
 *
 * Inlined in <head> deliberately: doing this after hydration renders one frame
 * of the wrong theme, which reads as a flash of white on every navigation for
 * dark-mode users.
 */
export const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
`;
