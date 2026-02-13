#!/usr/bin/env node

/**
 * Estimate token count (simple approximation: 1 token ≈ 4 chars)
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Convert Float32Array to Buffer for SQLite BLOB storage
 */
export function float32ArrayToBuffer(arr) {
  const buffer = Buffer.allocUnsafe(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buffer.writeFloatLE(arr[i], i * 4);
  }
  return buffer;
}

/**
 * Convert Buffer to Float32Array
 */
export function bufferToFloat32Array(buffer) {
  const arr = new Float32Array(buffer.length / 4);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = buffer.readFloatLE(i * 4);
  }
  return arr;
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Normalize score to 0-1 range
 */
export function normalizeScore(score, min, max) {
  if (max === min) return 0;
  return (score - min) / (max - min);
}

/**
 * Detect if a buffer is likely binary
 */
export function isProbablyBinary(buffer) {
  const sampleSize = Math.min(buffer.length, 8000);
  let nonPrintable = 0;

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    if (byte === 0) return true; // null byte

    const isPrintable =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);

    if (!isPrintable) nonPrintable++;
  }

  return nonPrintable / sampleSize > 0.3;
}

/**
 * Compute file hash (sha256) from string or buffer
 */
import { createHash } from 'crypto';

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}
