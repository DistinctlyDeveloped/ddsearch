#!/usr/bin/env node
import { estimateTokens } from './utils.js';

const TARGET_CHUNK_SIZE = 300; // tokens
const MIN_CHUNK_SIZE = 100; // tokens

/**
 * Split markdown content into semantic chunks
 * Returns array of { text, startLine, endLine, tokenCount }
 */
export function chunkMarkdown(content) {
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  let chunkStartLine = 1;

  function flushChunk(nextStartLine = null) {
    if (currentChunk.length === 0) return;

    const text = currentChunk.join('\n').trim();
    if (text.length === 0) {
      currentChunk = [];
      currentTokens = 0;
      return;
    }

    const endLine = chunkStartLine + currentChunk.length - 1;

    chunks.push({
      text,
      startLine: chunkStartLine,
      endLine,
      tokenCount: estimateTokens(text)
    });

    currentChunk = [];
    currentTokens = 0;
    chunkStartLine = nextStartLine ?? endLine + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line);

    // Check if this is a heading or significant boundary
    const isHeading = /^#{1,6}\s/.test(line);
    const isCodeFence = /^```/.test(line);
    const isHorizontalRule = /^(-{3,}|\*{3,}|_{3,})$/.test(line);
    const isBlankLine = line.trim().length === 0;

    // If we hit a heading and we have content, flush the current chunk
    if (isHeading && currentChunk.length > 0 && currentTokens >= MIN_CHUNK_SIZE) {
      flushChunk(i + 1);
    }

    // Add line to current chunk
    currentChunk.push(line);
    currentTokens += lineTokens;

    // Handle code blocks - keep them together
    if (isCodeFence) {
      let j = i + 1;
      while (j < lines.length && !/^```/.test(lines[j])) {
        currentChunk.push(lines[j]);
        currentTokens += estimateTokens(lines[j]);
        j++;
      }
      if (j < lines.length) {
        currentChunk.push(lines[j]); // closing fence
        currentTokens += estimateTokens(lines[j]);
        i = j;
      }

      // If code block is large, flush it
      if (currentTokens >= TARGET_CHUNK_SIZE) {
        flushChunk(i + 2);
      }
      continue;
    }

    // If we've exceeded target size and hit a natural boundary, flush
    if (currentTokens >= TARGET_CHUNK_SIZE) {
      if (isBlankLine || isHorizontalRule || i === lines.length - 1) {
        flushChunk(i + 2);
      }
    }
  }

  // Flush any remaining content
  flushChunk();

  return chunks;
}

/**
 * Chunk a file and return chunks with metadata
 */
export function chunkFile(filePath, content) {
  const rawChunks = chunkMarkdown(content);

  return rawChunks.map((chunk, index) => ({
    ...chunk,
    filePath,
    chunkIndex: index
  }));
}
