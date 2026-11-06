import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "../lib/types"

/** The re-walk's diagonal AM3352 placement (ram rel ~(-11.4, -26)), the
 * composed 22-net byte shape on outer carriers with rotated package fields.
 * Fixture for the diagonal / outer-carrier native path. */
export const am3352DiagonalOuterInputSha256 =
  "16d1f2e6b73757e1e8c1a329e78f95fd59afdc2f46591640d917049f92de7ece"

export function loadAm3352DiagonalOuterInput(): SimpleRouteJson {
  const compressed = readFileSync(
    new URL(
      "../tests/fixtures/am3352-diagonal-outer/composed-bytes.simple-route.json.gz",
      import.meta.url,
    ),
  )
  const bytes = gunzipSync(compressed)
  const sha256 = (data: Uint8Array) =>
    createHash("sha256").update(data).digest("hex")
  if (
    sha256(compressed) !==
      "60cd72f8639d890c03decc89f87ad7b3570810fd2276b3ea066515872f997939" ||
    sha256(bytes) !== am3352DiagonalOuterInputSha256
  )
    throw Error("am3352-diagonal-outer fixture does not match its pinned sha256")
  return JSON.parse(bytes.toString()) as SimpleRouteJson
}

/** The same composed byte shape as two whole-byte buses (B0/B1, length
 * windows, both DQS pairs declared) — the lanes-path branch shape. */
export const am3352ComposedTwoBusSha256 =
  "858e66599aa9f1a478fce2f6b773176c797170a6d95cdb4525813bf32762bc51"

export function loadAm3352ComposedTwoBusInput(): SimpleRouteJson {
  const compressed = readFileSync(
    new URL(
      "../tests/fixtures/am3352-diagonal-outer/composed-2bus.simple-route.json.gz",
      import.meta.url,
    ),
  )
  const bytes = gunzipSync(compressed)
  const sha256 = (data: Uint8Array) =>
    createHash("sha256").update(data).digest("hex")
  if (
    sha256(compressed) !==
      "2628c9edddf2d5976952a72a2a588b2886c88a55cb40115120e9e73b55048b98" ||
    sha256(bytes) !== am3352ComposedTwoBusSha256
  )
    throw Error("am3352 composed-2bus fixture does not match its pinned sha256")
  return JSON.parse(bytes.toString()) as SimpleRouteJson
}
