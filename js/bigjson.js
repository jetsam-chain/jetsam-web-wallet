// JSON parser that keeps every integer exact.
//
// A coinbase output's creation_id is 2^63 | height (about 9.22e18). JSON.parse
// turns it into a double and silently destroys the low bits that hold the
// height. So responses are read as text and parsed here: every integer literal
// becomes a BigInt, fractions and exponents stay Numbers. Callers convert the
// small fields they need (heights, slot indexes) explicitly.

/** Nesting deeper than this is refused (a hostile answer cannot blow the stack). */
export const MAX_DEPTH = 64;

export function parseJson(text) {
  if (typeof text !== "string") throw new SyntaxError("JSON text must be a string");
  let i = 0;
  let depth = 0;
  const n = text.length;

  const fail = (what) => {
    throw new SyntaxError("Invalid JSON at offset " + i + ": " + what);
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };

  function value() {
    ws();
    if (i >= n) fail("unexpected end");
    const c = text[i];
    if (c === "{" || c === "[") {
      if (++depth > MAX_DEPTH) fail("nested too deep");
      const v = c === "{" ? object() : array();
      depth--;
      return v;
    }
    if (c === '"') return string();
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    return fail("unexpected character " + JSON.stringify(c));
  }

  function object() {
    const out = {};
    i++; // {
    ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail("expected a key");
      const key = string();
      ws();
      if (text[i] !== ":") fail("expected ':'");
      i++;
      const v = value();
      // defineProperty: a "__proto__" key becomes an ordinary own property
      // instead of replacing the object's prototype.
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      fail("expected ',' or '}'");
    }
  }

  function array() {
    const out = [];
    i++; // [
    ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value());
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      fail("expected ',' or ']'");
    }
  }

  function string() {
    i++; // opening quote
    let out = "";
    let start = i;
    for (;;) {
      if (i >= n) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) { out += text.slice(start, i); i++; return out; }
      if (c < 0x20) fail("control character in string");
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default: fail("bad escape");
        }
        start = i;
        continue;
      }
      i++;
    }
  }

  function number() {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) fail("bad number");
    i += m[0].length;
    // A leading zero followed by more digits ("01") is not JSON.
    if (i < n && text[i] >= "0" && text[i] <= "9") fail("bad number");
    if (m[2] === undefined && m[3] === undefined) return BigInt(m[0]);
    return Number(m[0]);
  }

  const result = value();
  ws();
  if (i !== n) fail("trailing characters");
  return result;
}
