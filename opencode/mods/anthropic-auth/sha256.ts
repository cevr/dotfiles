// SHA-256 (FIPS 180-4) as a pure function. The plugin hashes small values on
// the request path (the billing stamp, the session id, long tool names, token
// keys), synchronously and deep inside the body rewrite, so the hash is
// arithmetic here rather than an outside system behind a contract.
import { Base64Url } from "effect/encoding"

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const encoder = new TextEncoder()

/** The SHA-256 digest of `input` (a string is hashed as its UTF-8 bytes). */
export function sha256(input: string | Uint8Array): Uint8Array {
  const data = typeof input === "string" ? encoder.encode(input) : input
  const bitLength = data.byteLength * 8
  const padded = new Uint8Array((((data.byteLength + 9 + 63) >> 6) << 6))
  padded.set(data)
  padded[data.byteLength] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(padded.byteLength - 4, bitLength >>> 0)

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0
      const b = w[i - 2] ?? 0
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0
    }
    let a = h[0] ?? 0
    let b = h[1] ?? 0
    let c = h[2] ?? 0
    let d = h[3] ?? 0
    let e = h[4] ?? 0
    let f = h[5] ?? 0
    let g = h[6] ?? 0
    let hh = h[7] ?? 0
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0
    h[1] = ((h[1] ?? 0) + b) >>> 0
    h[2] = ((h[2] ?? 0) + c) >>> 0
    h[3] = ((h[3] ?? 0) + d) >>> 0
    h[4] = ((h[4] ?? 0) + e) >>> 0
    h[5] = ((h[5] ?? 0) + f) >>> 0
    h[6] = ((h[6] ?? 0) + g) >>> 0
    h[7] = ((h[7] ?? 0) + hh) >>> 0
  }
  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)
  for (let i = 0; i < 8; i++) out.setUint32(i * 4, h[i] ?? 0)
  return digest
}

/** Lower-case hex of `bytes`. */
export function hex(bytes: Uint8Array): string {
  let text = ""
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0")
  return text
}

/** Unpadded base64url of `bytes`, as Node's `digest('base64url')` writes it. */
export const base64url = (bytes: Uint8Array): string => Base64Url.encode(bytes)

export const sha256Hex = (input: string | Uint8Array): string => hex(sha256(input))

export const sha256Base64url = (input: string | Uint8Array): string => base64url(sha256(input))
