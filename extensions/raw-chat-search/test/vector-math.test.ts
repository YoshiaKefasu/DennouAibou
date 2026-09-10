import { describe, expect, it } from "vitest";
import {
  blobToVector,
  cosineSimilarity,
  cosineSimilarityBatch,
  EMBEDDING_DIMENSIONS,
  normalizeL2,
  vectorToBlob,
} from "../src/vector-math.js";

/** Deterministic pseudo-random unit vector builder (no RNG dependency in tests). */
function makeVector(dim: number, seed: number): Float32Array {
  const vec = new Float32Array(dim);
  let state = seed >>> 0;
  for (let i = 0; i < dim; i++) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    vec[i] = (state / 0xffff_ffff) * 2 - 1;
  }
  return vec;
}

function unitAxis(dim: number, axis: number): Float32Array {
  const vec = new Float32Array(dim);
  vec[axis] = 1;
  return vec;
}

describe("vector-math: cosineSimilarity", () => {
  it("uses 1280 dimensions as the production embedding size", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1280);
    expect(EMBEDDING_DIMENSIONS % 4).toBe(0);
  });

  it("returns 1.0 for a vector against itself", () => {
    const vec = makeVector(EMBEDDING_DIMENSIONS, 42);
    const normalized = normalizeL2(vec);
    expect(cosineSimilarity(normalized, normalized)).toBeCloseTo(1, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = unitAxis(EMBEDDING_DIMENSIONS, 0);
    const b = unitAxis(EMBEDDING_DIMENSIONS, 637);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it("returns -1.0 for an inverted vector", () => {
    const a = unitAxis(EMBEDDING_DIMENSIONS, 12);
    const b = new Float32Array(EMBEDDING_DIMENSIONS);
    b[12] = -1;
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it("matches a scalar reference implementation on random normalized vectors", () => {
    const a = normalizeL2(makeVector(EMBEDDING_DIMENSIONS, 7));
    const b = normalizeL2(makeVector(EMBEDDING_DIMENSIONS, 99));
    let expected = 0;
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      expected += a[i] * b[i];
    }
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 4);
  });

  it("handles dimensions that are not a multiple of 4 via the remainder loop", () => {
    const a = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]); // dim 7
    const b = new Float32Array([1, 1, 1, 1, 1, 1, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(3.5, 6);
  });

  it("throws on dimension mismatch and empty input", () => {
    expect(() => cosineSimilarity(new Float32Array(4), new Float32Array(8))).toThrow(
      /dimension mismatch/,
    );
    expect(() => cosineSimilarity(new Float32Array(0), new Float32Array(0))).toThrow(/non-empty/);
  });
});

describe("vector-math: cosineSimilarityBatch", () => {
  it("scores every row of a flat buffer", () => {
    const dim = 4;
    const query = new Float32Array([1, 0, 0, 0]);
    const dbVectors = new Float32Array([
      1,
      0,
      0,
      0, // identical -> 1.0
      0,
      1,
      0,
      0, // orthogonal -> 0.0
      -1,
      0,
      0,
      0, // inverted -> -1.0
      0.5,
      0.5,
      0.5,
      0.5, // 0.5
    ]);
    const scores = new Float32Array(4);

    cosineSimilarityBatch(query, dbVectors, 4, dim, scores);

    expect(Array.from(scores)).toEqual([1, 0, -1, 0.5]);
  });

  it("matches per-vector cosineSimilarity for 1280-dimensional rows", () => {
    const count = 8;
    const dim = EMBEDDING_DIMENSIONS;
    const query = normalizeL2(makeVector(dim, 3));
    const flat = new Float32Array(count * dim);
    const expected: number[] = [];

    for (let j = 0; j < count; j++) {
      const row = normalizeL2(makeVector(dim, 100 + j));
      flat.set(row, j * dim);
      expected.push(cosineSimilarity(query, row));
    }

    const scores = new Float32Array(count);
    cosineSimilarityBatch(query, flat, count, dim, scores);

    for (let j = 0; j < count; j++) {
      expect(scores[j]).toBeCloseTo(expected[j]!, 5);
    }
  });

  it("ranks the most similar row first on a larger synthetic corpus", () => {
    const count = 500;
    const dim = EMBEDDING_DIMENSIONS;
    const targetIndex = 317;
    const flat = new Float32Array(count * dim);
    for (let j = 0; j < count; j++) {
      flat.set(normalizeL2(makeVector(dim, 1 + j)), j * dim);
    }
    // Plant a near-duplicate of the query at a known offset.
    const query = normalizeL2(makeVector(dim, 1 + targetIndex));
    flat.set(query, targetIndex * dim);

    const scores = new Float32Array(count);
    cosineSimilarityBatch(query, flat, count, dim, scores);

    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < count; j++) {
      if (scores[j]! > bestScore) {
        bestScore = scores[j]!;
        bestIndex = j;
      }
    }
    expect(bestIndex).toBe(targetIndex);
    expect(bestScore).toBeCloseTo(1, 5);
  });

  it("supports an empty batch and a zero-count no-op", () => {
    const scores = new Float32Array(0);
    expect(() =>
      cosineSimilarityBatch(new Float32Array(4), new Float32Array(0), 0, 4, scores),
    ).not.toThrow();
  });

  it("rejects undersized buffers", () => {
    const query = new Float32Array(4);
    expect(() =>
      cosineSimilarityBatch(query, new Float32Array(4), 2, 4, new Float32Array(2)),
    ).toThrow(/db vector buffer too short/);
    expect(() =>
      cosineSimilarityBatch(query, new Float32Array(8), 2, 4, new Float32Array(1)),
    ).toThrow(/score buffer too short/);
    expect(() =>
      cosineSimilarityBatch(new Float32Array(2), new Float32Array(8), 2, 4, new Float32Array(2)),
    ).toThrow(/query vector too short/);
  });

  it("stays within the latency budget for 1000 rows", () => {
    const count = 1000;
    const dim = EMBEDDING_DIMENSIONS;
    const query = normalizeL2(makeVector(dim, 5));
    const flat = new Float32Array(count * dim);
    for (let j = 0; j < count; j++) {
      flat.set(normalizeL2(makeVector(dim, 500 + j)), j * dim);
    }
    const scores = new Float32Array(count);

    const startedAt = performance.now();
    cosineSimilarityBatch(query, flat, count, dim, scores);
    const elapsedMs = performance.now() - startedAt;

    // Budget is intentionally generous (CI machines vary); the KASOU reference
    // measurement for 1000 rows is ~3.5ms against a 15ms SLO.
    expect(elapsedMs).toBeLessThan(500);
    expect(scores[0]).toBeGreaterThanOrEqual(-1);
    expect(scores[count - 1]).toBeLessThanOrEqual(1);
  });
});

describe("vector-math: normalizeL2", () => {
  it("produces a unit vector", () => {
    const normalized = normalizeL2(makeVector(EMBEDDING_DIMENSIONS, 11));
    let sumSquares = 0;
    for (const value of normalized) {
      sumSquares += value * value;
    }
    expect(Math.sqrt(sumSquares)).toBeCloseTo(1, 5);
  });

  it("preserves direction", () => {
    const normalized = normalizeL2(new Float32Array([3, 4]));
    expect(normalized[0]).toBeCloseTo(0.6, 6);
    expect(normalized[1]).toBeCloseTo(0.8, 6);
  });

  it("returns zeros instead of NaN for a zero vector", () => {
    const normalized = normalizeL2(new Float32Array(4));
    expect(Array.from(normalized)).toEqual([0, 0, 0, 0]);
  });

  it("treats non-finite entries as zero", () => {
    const normalized = normalizeL2(new Float32Array([Number.NaN, 0, Number.POSITIVE_INFINITY, 4]));
    expect(normalized[3]).toBeCloseTo(1, 6);
    expect(normalized[0]).toBe(0);
    expect(normalized[2]).toBe(0);
  });

  it("does not mutate the input vector", () => {
    const input = new Float32Array([3, 4]);
    normalizeL2(input);
    expect(Array.from(input)).toEqual([3, 4]);
  });
});

describe("vector-math: BLOB round-trip", () => {
  it("round-trips a 1280-dimensional vector", () => {
    const original = normalizeL2(makeVector(EMBEDDING_DIMENSIONS, 2024));
    const blob = vectorToBlob(original);

    expect(blob.byteLength).toBe(EMBEDDING_DIMENSIONS * 4);

    const restored = blobToVector(blob, EMBEDDING_DIMENSIONS);
    expect(restored.length).toBe(EMBEDDING_DIMENSIONS);
    expect(Array.from(restored)).toEqual(Array.from(original));
    expect(cosineSimilarity(original, restored)).toBeCloseTo(1, 6);
  });

  it("reinterprets aligned blobs without copying", () => {
    const original = new Float32Array([1, 2, 3, 4]);
    const blob = vectorToBlob(original);
    const restored = blobToVector(blob, 4);
    expect(restored.buffer).toBe(original.buffer);
  });

  it("copies from an unaligned blob view", () => {
    const source = new Float32Array([1.5, -2.5, 3.5]);
    const padded = new Uint8Array(source.byteLength + 1);
    padded.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), 1);
    const unaligned = padded.subarray(1);

    expect(unaligned.byteOffset % 4).not.toBe(0);
    const restored = blobToVector(unaligned, 3);
    expect(Array.from(restored)).toEqual([1.5, -2.5, 3.5]);
  });

  it("infers the dimension when dim is omitted", () => {
    const blob = vectorToBlob(new Float32Array([9, 8, 7]));
    const restored = blobToVector(blob);
    expect(restored.length).toBe(3);
    expect(Array.from(restored)).toEqual([9, 8, 7]);
  });

  it("rejects malformed blobs", () => {
    expect(() => vectorToBlob(new Float32Array(0))).toThrow(/empty vector/);
    expect(() => blobToVector(new Uint8Array(0))).toThrow(/empty blob/);
    expect(() => blobToVector(new Uint8Array(7))).toThrow(/multiple of 4/);
    expect(() => blobToVector(new Uint8Array(8), 4)).toThrow(/does not match 4 float32/);
  });
});
