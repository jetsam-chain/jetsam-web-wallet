// localStorage wrapper. Storage can be missing or throw (private windows,
// blocked site data, previews): every access is guarded and the page works
// without it — it just forgets the address list on reload.

const PREFIX = "jww.v1.";

export function createStore(backing) {
  let available = false;
  try {
    if (backing) {
      backing.setItem(PREFIX + "probe", "1");
      backing.removeItem(PREFIX + "probe");
      available = true;
    }
  } catch (_) {
    available = false;
  }
  return {
    available,
    get(key, fallback) {
      if (!available) return fallback;
      try {
        const raw = backing.getItem(PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      if (!available) return false;
      try {
        backing.setItem(PREFIX + key, JSON.stringify(value));
        return true;
      } catch (_) {
        return false;
      }
    },
    remove(key) {
      if (!available) return;
      try {
        backing.removeItem(PREFIX + key);
      } catch (_) {
        /* nothing to do */
      }
    },
  };
}
