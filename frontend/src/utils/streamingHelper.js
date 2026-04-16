/**
 * Streaming helper utilities for token-by-token text responses like ChatGPT
 */

import { flushSync } from 'react-dom';

/**
 * Fetch and stream a response, calling a callback for each token/chunk
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options (method, headers, body, etc.)
 * @param {function} onChunk - Callback fired for each chunk: (chunk, fullText) => void
 * @param {function} onComplete - Callback fired when streaming completes: (fullText) => void
 * @param {function} onError - Callback fired on error: (error) => void
 * @returns {Promise<string>} - The full accumulated text
 */
export async function streamFetch(url, options = {}, onChunk, onComplete, onError) {
  try {
    const res = await fetch(url, {
      credentials: "include",
      ...options,
    });

    if (!res.ok || !res.body) {
      const errorMsg = `HTTP ${res.status}: ${res.statusText}`;
      onError?.(new Error(errorMsg));
      throw new Error(errorMsg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      
      // Force synchronous state update for immediate visual feedback
      // This prevents React 18+ batching from delaying the UI update
      onChunk?.(chunk, fullText);
    }

    onComplete?.(fullText);
    return fullText;
  } catch (error) {
    onError?.(error);
    throw error;
  }
}

/**
 * Parse JSON from streamed text response
 * Handles JSON blocks wrapped in code fences or raw JSON
 * @param {string} text - The accumulated text from streaming
 * @returns {object|null} - Parsed JSON object or null if parsing fails
 */
export function extractJSON(text) {
  // Try to find JSON within code fences first
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // Fall through to next attempt
    }
  }

  // Try to find any JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through
    }
  }

  return null;
}

/**
 * Create a streaming state manager for React components
 * Returns state and handlers for streaming responses
 * @param {function} setMessage - State setter for accumulating text: (text) => void
 * @returns {object} - Handlers for streaming lifecycle
 */
export function useStreamingState(setMessage) {
  return {
    handleChunk: (chunk) => {
      setMessage((prev) => prev + chunk);
    },
    handleError: (error) => {
      setMessage((prev) => prev + `\n[Error: ${error.message}]`);
    },
  };
}

/**
 * Stream from an endpoint and update React state
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @param {function} setMessage - React state setter
 * @param {object} callbacks - Optional {onComplete, onError}
 * @returns {Promise<string>} - Full text
 */
export async function streamToReactState(
  url,
  options = {},
  setMessage,
  callbacks = {}
) {
  const { onComplete, onError } = callbacks;
  return streamFetch(
    url,
    options,
    (chunk) => {
      setMessage((prev) => prev + chunk);
    },
    (fullText) => {
      onComplete?.(fullText);
    },
    (error) => {
      setMessage((prev) => prev + `\n[Error: ${error.message}]`);
      onError?.(error);
    }
  );
}

/**
 * Format streaming callback for displaying in UI
 * Removes extra whitespace, normalizes markdown
 * @param {string} text - Raw streamed text
 * @returns {string} - Formatted text
 */
export function formatStreamedText(text) {
  // Remove duplicate consecutive newlines
  return text
    .split(/\r?\n/)
    .reduce((acc, line) => {
      if (line.trim() || acc[acc.length - 1] !== "") {
        acc.push(line);
      }
      return acc;
    }, [])
    .join("\n")
    .trim();
}

export default {
  streamFetch,
  extractJSON,
  useStreamingState,
  streamToReactState,
  formatStreamedText,
};
