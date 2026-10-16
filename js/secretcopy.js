// Copy a new wallet's secret to the clipboard, at the user's explicit
// request, and clear it again.
//
// The only place in the page that puts the secret on the clipboard (the
// backup step of a new wallet, after a warning and the password). The 64
// ASCII hex bytes come from the key worker's `reveal`, are turned into a
// string only for writeText, and the caller zeroes the bytes; the string
// itself cannot be zeroed in JavaScript: no reference to it is kept, and it
// waits for the garbage collector. There is no fallback through a text field
// or execCommand: that would put the secret in the page.
//
// The clipboard is cleared (an empty string written) when `seconds` have
// passed, or earlier on stop(). Best effort only: browsers let a page write
// the clipboard only while it has the focus, so if the page is in the
// background then, the clipboard is not cleared and onEnd says so. Clipboard
// managers and other apps may have read it in the meantime.

const HEX = /^[0-9a-f]{64}$/;

export function createSecretCopy({
  clipboard = globalThis.navigator ? globalThis.navigator.clipboard : undefined,
  secure = globalThis.isSecureContext === true,
  hasFocus = () => (typeof document !== "undefined" ? document.hasFocus() : false),
  now = () => Date.now(),
  every = (fn, ms) => setInterval(fn, ms),
  stopEvery = (id) => clearInterval(id),
  seconds = 30,
  onTick = () => {},
  onEnd = () => {},
} = {}) {
  let deadline = null;
  let timer = null;

  const available = () => Boolean(secure && clipboard && typeof clipboard.writeText === "function");

  function stopTimer() {
    if (timer !== null) stopEvery(timer);
    timer = null;
    deadline = null;
  }

  /** Write an empty string over the clipboard now; "cleared" or "not_cleared". */
  async function wipe() {
    if (!available() || !hasFocus()) return "not_cleared";
    try {
      await clipboard.writeText("");
      return "cleared";
    } catch (_) {
      return "not_cleared";
    }
  }

  async function end() {
    if (deadline === null) return null;
    stopTimer();
    const r = await wipe();
    onEnd(r);
    return r;
  }

  function tick() {
    if (deadline === null) return;
    const left = Math.ceil((deadline - now()) / 1000);
    if (left <= 0) end();
    else onTick(left);
  }

  return {
    available,
    get pending() { return deadline !== null; },
    /**
     * `ascii`: the 64 hex digits as ASCII bytes (from the key worker). The
     * caller zeroes them afterwards. Resolves true once written.
     */
    async copy(ascii) {
      if (!available()) return false;
      if (!(ascii instanceof Uint8Array) || ascii.length !== 64) throw new Error("bad secret bytes");
      let text = String.fromCharCode(...ascii);
      if (!HEX.test(text)) throw new Error("bad secret bytes");
      // Laid out as on screen: 4 lines of "01 abcd 02 efgh 03 ijkl 04 mnop".
      // The open form reads it back (plainSecretText).
      const groups = text.match(/.{4}/g).map((g, i) => String(i + 1).padStart(2, "0") + " " + g);
      text = [0, 4, 8, 12].map((r) => groups.slice(r, r + 4).join(" ")).join("\n");
      try {
        await clipboard.writeText(text);
      } finally {
        text = null;
      }
      stopTimer();
      deadline = now() + seconds * 1000;
      onTick(seconds);
      timer = every(tick, 1000);
      return true;
    },
    /** Leaving the step, the gate or the page: clear now if still pending. */
    stop: () => end(),
  };
}
