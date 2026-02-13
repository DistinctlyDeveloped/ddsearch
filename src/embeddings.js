#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;

/**
 * Get OpenAI API key from env or secrets
 */
function getApiKey() {
  // Try env var first
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  // Try secrets directory
  const secretsDir = join(homedir(), '.openclaw', 'secrets');
  const keyFiles = ['openai-api-key.txt', 'openai.txt'];
  
  for (const filename of keyFiles) {
    const path = join(secretsDir, filename);
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8').trim();
    }
  }

  throw new Error('OpenAI API key not found. Set OPENAI_API_KEY env var or create ~/.openclaw/secrets/openai-api-key.txt');
}

/**
 * Generate embeddings for a batch of texts
 * Returns array of Float32Array embeddings
 */
export async function generateEmbeddings(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const apiKey = getApiKey();
  const batches = [];
  
  // Split into batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const allEmbeddings = [];

  for (const batch of batches) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: batch
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      // Extract embeddings and convert to Float32Array
      const embeddings = data.data.map(item => new Float32Array(item.embedding));
      allEmbeddings.push(...embeddings);
      
      // Rate limiting courtesy delay
      if (batches.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error('Error generating embeddings:', error.message);
      throw error;
    }
  }

  return allEmbeddings;
}

/**
 * Generate embedding for a single query
 */
export async function generateQueryEmbedding(query) {
  const embeddings = await generateEmbeddings([query]);
  return embeddings[0];
}
