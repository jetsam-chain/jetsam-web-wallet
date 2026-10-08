// Draw the 64 hex digits of a secret on a canvas, never as page text.
//
// The digits arrive as ASCII bytes from the key worker. Drawing them one
// character at a time means no string with the whole secret is ever built in
// the page; text in a canvas cannot be selected, copied, found by the
// browser's search, read by a script that walks the page's text, or
// translated by a translation extension. The caller zeroes the bytes after.
// (Pixels can still be read back by code running in this page: that is the
// threat model's "malicious script" case, which no page-level measure stops.)

const COLS = 4; // groups per row
const GROUP = 4; // digits per group

export function drawSecret(canvas, ascii, { ink, faint, font }) {
  if (!(ascii instanceof Uint8Array) || ascii.length !== 64) throw new Error("bad secret bytes");
  for (const b of ascii) if (!((b >= 48 && b <= 57) || (b >= 97 && b <= 102))) throw new Error("bad secret bytes");
  const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  const cell = 15; // css px per digit
  const gap = 18;
  const label = 22;
  const rowH = 34;
  const w = COLS * (label + GROUP * cell + gap) - gap + 8;
  const h = (64 / GROUP / COLS) * rowH + 6;
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  for (let g = 0; g < 64 / GROUP; g++) {
    const row = Math.floor(g / COLS);
    const col = g % COLS;
    const x0 = 4 + col * (label + GROUP * cell + gap);
    const y = 4 + row * rowH + rowH / 2;
    ctx.fillStyle = faint;
    ctx.font = "11px " + font;
    ctx.fillText(String(g + 1).padStart(2, "0"), x0, y);
    ctx.fillStyle = ink;
    ctx.font = "600 19px " + font;
    for (let k = 0; k < GROUP; k++) {
      ctx.fillText(String.fromCharCode(ascii[g * GROUP + k]), x0 + label + k * cell, y);
    }
  }
}

export function clearCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 1;
  canvas.height = 1;
}
