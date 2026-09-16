/**
 * Small per-tab scratch space for things the server does not hold.
 *
 * Switching views unmounts the one you were on, so anything a component keeps
 * in `useState` and has not sent anywhere is gone the moment you look at
 * something else. A conversation lives in Postgres; a half-typed message, the
 * place you had reached in it, and a routing rule you have filled in but not
 * saved live nowhere else.
 *
 * READ THESE IN A `useState` INITIALISER, never restore them from an effect: a
 * persist effect fires on mount with the starting value, so a restore effect
 * races it and wipes exactly what it was meant to save. That is how the first
 * version of this failed its own test.
 *
 * Storage can be absent or throw (a private window, site data blocked), so
 * every access is guarded and the UI has to work without it.
 */
export function remember(key: string, value: string): void {
  try {
    if (value === "") sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* private window, or storage disabled: the feature is a convenience */
  }
}

export function recall(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
