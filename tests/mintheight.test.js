import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMintHeights } from "../js/mintheight.js";

// A fake chain: alloc[h] is the allocation counter recorded in header h,
// i.e. the counter as it stands after block h. Block h minted the ids
// alloc[h-1]+1 .. alloc[h].
function fakeChain(mintsPerBlock) {
  const alloc = [];
  let c = 0n;
  for (const m of mintsPerBlock) {
    c += BigInt(m);
    alloc.push(c);
  }
  let reads = 0;
  const allocAt = async (h) => {
    reads++;
    if (h < 0 || h >= alloc.length) throw new Error("no header " + h);
    return alloc[h];
  };
  const brute = (id) => {
    const h = alloc.findIndex((a) => a >= id);
    return h === -1 ? null : h;
  };
  return { alloc, allocAt, brute, reads: () => reads, tip: alloc.length - 1 };
}

test("each id resolves to the lowest height whose counter reaches it", async () => {
  // Some blocks mint nothing, some mint several.
  const chain = fakeChain([3, 0, 0, 2, 1, 0, 5, 1, 1, 0, 4]);
  const ids = [];
  for (let id = 1n; id <= chain.alloc.at(-1); id++) ids.push(id);
  const got = await resolveMintHeights(ids, chain.tip, chain.allocAt);
  for (const id of ids) assert.equal(got.get(id), chain.brute(id), "id " + id);
});

test("ids beyond the tip's counter resolve to null", async () => {
  const chain = fakeChain([1, 1, 1]);
  const got = await resolveMintHeights([2n, 99n], chain.tip, chain.allocAt);
  assert.equal(got.get(2n), 1);
  assert.equal(got.get(99n), null);
});

test("duplicates and unsorted input are fine; empty input reads nothing", async () => {
  const chain = fakeChain([1, 2, 3, 4]);
  const got = await resolveMintHeights([7n, 1n, 7n, 4n], chain.tip, chain.allocAt);
  assert.equal(got.get(7n), 3);
  assert.equal(got.get(1n), 0);
  assert.equal(got.get(4n), 2);
  const empty = fakeChain([1]);
  assert.equal((await resolveMintHeights([], empty.tip, empty.allocAt)).size, 0);
  assert.equal(empty.reads(), 0);
});

test("shared search reads far fewer headers than one search per id", async () => {
  // ~32 500 blocks, ~1.4 mints per block, 33 scattered ids (the fund-network shape).
  const per = [];
  for (let h = 0; h < 32_545; h++) per.push(h % 5 === 0 ? 3 : 1);
  const chain = fakeChain(per);
  const ids = [];
  for (let i = 0; i < 33; i++) ids.push(BigInt(900 + i * 1380));
  const got = await resolveMintHeights(ids, chain.tip, chain.allocAt);
  for (const id of ids) assert.equal(got.get(id), chain.brute(id));
  const naive = 33 * Math.ceil(Math.log2(32_545) + 1);
  assert.ok(chain.reads() < naive, chain.reads() + " reads vs naive " + naive);
});

test("each height is read at most once", async () => {
  const chain = fakeChain(Array.from({ length: 1000 }, () => 1));
  const seen = new Map();
  const allocAt = async (h) => {
    seen.set(h, (seen.get(h) || 0) + 1);
    return chain.alloc[h];
  };
  const ids = Array.from({ length: 200 }, (_, i) => BigInt(1 + i * 5));
  await resolveMintHeights(ids, chain.tip, allocAt);
  for (const [h, n] of seen) assert.equal(n, 1, "height " + h);
});

test("a failing header read leaves the affected ids null instead of throwing", async () => {
  const chain = fakeChain([1, 1, 1, 1, 1, 1, 1, 1]);
  const allocAt = async (h) => {
    if (h === 3) throw new Error("boom");
    return chain.alloc[h];
  };
  const got = await resolveMintHeights([1n, 8n], chain.tip, allocAt);
  assert.equal(got.size, 2);
  for (const v of got.values()) assert.ok(v === null || Number.isInteger(v));
});

test("progress callback reports resolved ids", async () => {
  const chain = fakeChain([2, 2, 2]);
  const seen = [];
  await resolveMintHeights([1n, 6n], chain.tip, chain.allocAt, {
    onResolved: (id, h) => seen.push([id, h]),
  });
  assert.deepEqual(seen.sort((a, b) => Number(a[0] - b[0])), [[1n, 0], [6n, 2]]);
});

// Deterministic pseudo-random generator for the chain shapes below.
function lcg(seed) {
  let x = seed >>> 0;
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

test("near-linear chain: a handful of header reads per id, not a full bisection", async () => {
  // Mostly 1-2 mints per block, with bursts: the shape of the real chain
  // (~1.4 outputs per block on mainnet at 32 545).
  const rnd = lcg(7);
  const per = [];
  for (let h = 0; h < 32_545; h++) per.push(rnd() < 0.02 ? 5 + Math.floor(rnd() * 40) : 1 + (rnd() < 0.3 ? 1 : 0));
  const chain = fakeChain(per);
  const top = chain.alloc.at(-1);
  const ids = [];
  for (let i = 0; i < 33; i++) ids.push(1n + (top * BigInt(i * 29 + 3)) / 1000n);
  const got = await resolveMintHeights(ids, chain.tip, chain.allocAt);
  for (const id of ids) assert.equal(got.get(id), chain.brute(id), "id " + id);
  assert.ok(chain.reads() <= 33 * 7, chain.reads() + " reads for 33 ids");
});

test("skewed chain (everything minted in a few blocks) stays correct and bounded", async () => {
  const per = new Array(20_000).fill(0);
  per[0] = 3; per[17] = 500; per[19_990] = 2000; per[19_999] = 1;
  const chain = fakeChain(per);
  const ids = [1n, 3n, 4n, 250n, 503n, 504n, 1500n, 2503n, 2504n];
  const got = await resolveMintHeights(ids, chain.tip, chain.allocAt);
  for (const id of ids) assert.equal(got.get(id), chain.brute(id), "id " + id);
  const bound = ids.length * 3 * Math.ceil(Math.log2(20_000)) + 1;
  assert.ok(chain.reads() <= bound, chain.reads() + " reads > " + bound);
});

test("random chains: always the same answer as a linear scan", async () => {
  const rnd = lcg(42);
  for (let round = 0; round < 40; round++) {
    const n = 1 + Math.floor(rnd() * 3000);
    const per = Array.from({ length: n }, () => (rnd() < 0.5 ? 0 : Math.floor(rnd() * 6)));
    const chain = fakeChain(per);
    const top = chain.alloc.at(-1);
    const ids = Array.from({ length: 1 + Math.floor(rnd() * 30) }, () => BigInt(Math.floor(rnd() * (Number(top) + 5))));
    const got = await resolveMintHeights(ids, chain.tip, chain.allocAt);
    for (const id of ids) assert.equal(got.get(id), chain.brute(id), "round " + round + " id " + id);
  }
});
