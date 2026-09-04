/**
 * BLAKE2b-256 (RFC 7693) — equivalent to libsodium crypto_generichash(32, msg).
 *
 * NovelAI derives the keystore's secretbox key as BLAKE2b-256 of the account's
 * encryption_key string. The Scripting Crypto module has no BLAKE2b, so this is
 * the reference 32-bit-word implementation. Verified against the RFC 7693 test
 * vectors by dev/test_crypto.mjs.
 */
/* eslint-disable */

const B2B_IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85,
  0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19
]);
const SIGMA82 = new Uint8Array([
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3,
  11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4,
  7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8,
  9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13,
  2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9,
  12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11,
  13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10,
  6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5,
  10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0,
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3
].map(x => x * 2));
const _v = new Uint32Array(32);
const _m = new Uint32Array(32);

function ADD64AA(a, b) {
  const o0 = _v[a] + _v[b];
  let o1 = _v[a + 1] + _v[b + 1];
  if (o0 >= 0x100000000) o1++;
  _v[a] = o0; _v[a + 1] = o1;
}
function ADD64AC(a, b0, b1) {
  let o0 = _v[a] + b0;
  if (b0 < 0) o0 += 0x100000000;
  let o1 = _v[a + 1] + b1;
  if (o0 >= 0x100000000) o1++;
  _v[a] = o0; _v[a + 1] = o1;
}
function GET32(arr, i) {
  return arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24);
}
function G(a, b, c, d, ix, iy) {
  const x0 = _m[ix], x1 = _m[ix + 1], y0 = _m[iy], y1 = _m[iy + 1];
  ADD64AA(a, b); ADD64AC(a, x0, x1);
  let xor0 = _v[d] ^ _v[a], xor1 = _v[d + 1] ^ _v[a + 1];
  _v[d] = xor1; _v[d + 1] = xor0;
  ADD64AA(c, d);
  xor0 = _v[b] ^ _v[c]; xor1 = _v[b + 1] ^ _v[c + 1];
  _v[b] = (xor0 >>> 24) ^ (xor1 << 8); _v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);
  ADD64AA(a, b); ADD64AC(a, y0, y1);
  xor0 = _v[d] ^ _v[a]; xor1 = _v[d + 1] ^ _v[a + 1];
  _v[d] = (xor0 >>> 16) ^ (xor1 << 16); _v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);
  ADD64AA(c, d);
  xor0 = _v[b] ^ _v[c]; xor1 = _v[b + 1] ^ _v[c + 1];
  _v[b] = (xor1 >>> 31) ^ (xor0 << 1); _v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}
function b2bCompress(ctx, last) {
  let i;
  for (i = 0; i < 16; i++) { _v[i] = ctx.h[i]; _v[i + 16] = B2B_IV32[i]; }
  _v[24] ^= ctx.t; _v[25] ^= (ctx.t / 0x100000000);
  if (last) { _v[28] = ~_v[28]; _v[29] = ~_v[29]; }
  for (i = 0; i < 32; i++) _m[i] = GET32(ctx.b, 4 * i);
  for (i = 0; i < 12; i++) {
    G(0, 8, 16, 24, SIGMA82[i * 16 + 0], SIGMA82[i * 16 + 1]);
    G(2, 10, 18, 26, SIGMA82[i * 16 + 2], SIGMA82[i * 16 + 3]);
    G(4, 12, 20, 28, SIGMA82[i * 16 + 4], SIGMA82[i * 16 + 5]);
    G(6, 14, 22, 30, SIGMA82[i * 16 + 6], SIGMA82[i * 16 + 7]);
    G(0, 10, 20, 30, SIGMA82[i * 16 + 8], SIGMA82[i * 16 + 9]);
    G(2, 12, 22, 24, SIGMA82[i * 16 + 10], SIGMA82[i * 16 + 11]);
    G(4, 14, 16, 26, SIGMA82[i * 16 + 12], SIGMA82[i * 16 + 13]);
    G(6, 8, 18, 28, SIGMA82[i * 16 + 14], SIGMA82[i * 16 + 15]);
  }
  for (i = 0; i < 16; i++) ctx.h[i] = ctx.h[i] ^ _v[i] ^ _v[i + 16];
}
function blake2b256(input) {
  const outlen = 32;
  const ctx = { b: new Uint8Array(128), h: new Uint32Array(16), t: 0, c: 0 };
  for (let i = 0; i < 16; i++) ctx.h[i] = B2B_IV32[i];
  ctx.h[0] ^= 0x01010000 ^ outlen;
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) { ctx.t += ctx.c; b2bCompress(ctx, false); ctx.c = 0; }
    ctx.b[ctx.c++] = input[i];
  }
  ctx.t += ctx.c;
  while (ctx.c < 128) ctx.b[ctx.c++] = 0;
  b2bCompress(ctx, true);
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = ctx.h[i >> 2] >> (8 * (i & 3));
  return out;
}

export { blake2b256 }
