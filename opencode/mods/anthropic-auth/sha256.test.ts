import { describe, expect, test } from "bun:test"
import { base64url, sha256, sha256Hex } from "./sha256.ts"

const webDigest = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))

describe("sha256", () => {
  test("matches the published vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("agrees with WebCrypto across block boundaries and multi-byte text", async () => {
    const encoder = new TextEncoder()
    for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff)
      expect(Array.from(sha256(bytes))).toEqual(Array.from(await webDigest(bytes)))
    }
    const text = "Привет 🚀 ".repeat(20)
    expect(Array.from(sha256(text))).toEqual(Array.from(await webDigest(encoder.encode(text))))
  })

  test("base64url carries no padding or unsafe characters", () => {
    expect(base64url(Uint8Array.of(0xfb, 0xff, 0xbf))).toBe("-_-_")
    expect(base64url(Uint8Array.of(1))).toBe("AQ")
  })
})
