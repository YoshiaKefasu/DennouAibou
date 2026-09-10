/**
 * Vector math for RAW_CHAT_SEARCH (design doc §4.2).
 *
 * Stored vectors are L2-normalized (unit vectors), so the inner product of a
 * query vector and a stored vector is the cosine similarity in the -1.0 - 1.0
 * range. Both operands are unit vectors, so a query can also point away from a
 * stored vector; only the practical ranking band (unrelated text lands near 0, a
 * paraphrase near 1) lives in the positive half. The inner loops are unrolled
 * 4-way: production vectors are 1280 dimensions, which divides evenly by 4.
 */
import { Buffer } from "node:buffer";

/** Embedding dimension produced by `gemini-embedding-2` with `outputDimensionality: 1280`. */
export const EMBEDDING_DIMENSIONS = 1280;

/**
 * Cosine similarity of two equal-length L2-normalized vectors.
 *
 * Range is -1.0 (opposite) to 1.0 (identical) for non-zero inputs.
 *
 * `vecA` and `vecB` must both be non-empty and have the same dimension.
 */
export function cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
  const dim = vecA.length;
  if (dim !== vecB.length) {
    throw new Error(`raw-chat-search: vector dimension mismatch (${dim} vs ${vecB.length})`);
  }
  if (dim === 0) {
    throw new Error("raw-chat-search: cosineSimilarity requires non-empty vectors");
  }

  const unrolledLength = dim - (dim % 4);
  let dot0 = 0;
  let dot1 = 0;
  let dot2 = 0;
  let dot3 = 0;
  for (let k = 0; k < unrolledLength; k += 4) {
    dot0 += vecA[k] * vecB[k];
    dot1 += vecA[k + 1] * vecB[k + 1];
    dot2 += vecA[k + 2] * vecB[k + 2];
    dot3 += vecA[k + 3] * vecB[k + 3];
  }
  for (let k = unrolledLength; k < dim; k++) {
    dot0 += vecA[k] * vecB[k];
  }
  return dot0 + dot1 + dot2 + dot3;
}

/**
 * Batch cosine similarity (inner product) of one query vector against `count`
 * vectors concatenated in a single flat `dbVectors` buffer.
 *
 * Layout: row `j` occupies `dbVectors[j * dim ... (j + 1) * dim - 1]`.
 * Scores are written to `scoresOut[0 ... count - 1]`.
 */
export function cosineSimilarityBatch(
  queryVec: Float32Array,
  dbVectors: Float32Array,
  count: number,
  dim: number,
  scoresOut: Float32Array,
): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`raw-chat-search: invalid vector count (${count})`);
  }
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`raw-chat-search: invalid vector dimension (${dim})`);
  }
  if (queryVec.length < dim) {
    throw new Error(
      `raw-chat-search: query vector too short (${queryVec.length} < ${dim} dimensions)`,
    );
  }
  if (dbVectors.length < count * dim) {
    throw new Error(
      `raw-chat-search: db vector buffer too short (${dbVectors.length} < ${count * dim})`,
    );
  }
  if (scoresOut.length < count) {
    throw new Error(`raw-chat-search: score buffer too short (${scoresOut.length} < ${count})`);
  }

  const unrolledLength = dim - (dim % 4);
  for (let j = 0; j < count; j++) {
    let dot0 = 0;
    let dot1 = 0;
    let dot2 = 0;
    let dot3 = 0;
    const offset = j * dim;
    for (let k = 0; k < unrolledLength; k += 4) {
      dot0 += dbVectors[offset + k] * queryVec[k];
      dot1 += dbVectors[offset + k + 1] * queryVec[k + 1];
      dot2 += dbVectors[offset + k + 2] * queryVec[k + 2];
      dot3 += dbVectors[offset + k + 3] * queryVec[k + 3];
    }
    for (let k = unrolledLength; k < dim; k++) {
      dot0 += dbVectors[offset + k] * queryVec[k];
    }
    scoresOut[j] = dot0 + dot1 + dot2 + dot3;
  }
}

/**
 * Returns a copy of `vec` scaled to an L2 norm of 1.0.
 *
 * Non-finite entries are treated as 0 so a corrupted value can never poison the
 * similarity math. An all-zero (or all non-finite) vector is returned as zeros
 * rather than NaN.
 */
export function normalizeL2(vec: Float32Array): Float32Array {
  const out = new Float32Array(vec.length);
  let sumSquares = 0;
  for (let i = 0; i < vec.length; i++) {
    const raw = vec[i];
    const value = Number.isFinite(raw) ? raw : 0;
    out[i] = value;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm < 1e-10) {
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    out[i] /= norm;
  }
  return out;
}

/**
 * Wraps a vector as a SQLite BLOB `Buffer` without copying (`Buffer.from` on an
 * ArrayBuffer creates a view). SQLite copies the bytes on write.
 */
export function vectorToBlob(vec: Float32Array): Buffer {
  if (vec.length === 0) {
    throw new Error("raw-chat-search: cannot serialize an empty vector");
  }
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Reinterprets a SQLite BLOB as a `Float32Array`. Returns a view over the input
 * buffer when it is 4-byte aligned, otherwise falls back to an aligned copy.
 *
 * `dim` is optional: when given, the BLOB must hold exactly `dim` float32
 * values, otherwise the call throws instead of silently truncating.
 */
export function blobToVector(blob: Buffer | Uint8Array, dim?: number): Float32Array {
  const byteLength = blob.byteLength;
  if (byteLength === 0) {
    throw new Error("raw-chat-search: cannot deserialize an empty blob");
  }
  if (byteLength % 4 !== 0) {
    throw new Error(`raw-chat-search: blob length ${byteLength} is not a multiple of 4 bytes`);
  }
  if (dim !== undefined && dim * 4 !== byteLength) {
    throw new Error(
      `raw-chat-search: blob length ${byteLength} does not match ${dim} float32 dimensions`,
    );
  }

  const length = byteLength / 4;
  if (blob.byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, length);
  }
  const aligned = new Uint8Array(byteLength);
  aligned.set(new Uint8Array(blob.buffer, blob.byteOffset, byteLength));
  return new Float32Array(aligned.buffer, 0, length);
}
