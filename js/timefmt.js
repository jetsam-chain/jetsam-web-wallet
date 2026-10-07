// Times are shown in UTC, always, and formatted by hand: no locale APIs.

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** "2026-10-07 05:16:30 UTC" from unix seconds (Number or BigInt). */
export function formatUtc(seconds) {
  const d = new Date(Number(seconds) * 1000);
  return (
    d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " +
    pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + " UTC"
  );
}

/** "12:03:04 UTC" from a millisecond timestamp. */
export function formatUtcClock(ms) {
  const d = new Date(ms);
  return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + " UTC";
}

/** Coarse age: "30 s", "1 min", "2 h", "3 d". */
export function formatAge(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " min";
  if (s < 86400) return Math.floor(s / 3600) + " h";
  return Math.floor(s / 86400) + " d";
}
