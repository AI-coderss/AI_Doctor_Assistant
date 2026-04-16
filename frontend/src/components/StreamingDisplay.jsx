import React, { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { streamToReactState, formatStreamedText } from "../utils/streamingHelper";
import "../styles/StreamingDisplay.css";

/**
 * Reusable component for displaying streaming text responses
 * with loading indicator and markdown rendering
 */
export default function StreamingDisplay({
  isStreaming = false,
  content = "",
  onComplete = null,
  onError = null,
  showLoadingIndicator = true,
  className = "",
}) {
  const [displayCursor, setDisplayCursor] = useState(isStreaming);

  useEffect(() => {
    if (!isStreaming) {
      setDisplayCursor(false);
    } else {
      setDisplayCursor(true);
      const interval = setInterval(() => {
        setDisplayCursor((prev) => !prev);
      }, 500);
      return () => clearInterval(interval);
    }
  }, [isStreaming]);

  const displayContent = formatStreamedText(content);

  return (
    <div className={`streaming-display ${className} ${isStreaming ? "streaming" : ""}`}>
      {showLoadingIndicator && isStreaming && (
        <div className="streaming-indicator">
          <div className="spinner" />
          <span className="text">Generating response...</span>
        </div>
      )}

      <div className="streaming-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {displayContent}
        </ReactMarkdown>
        {displayCursor && <span className="cursor">▌</span>}
      </div>

      {!isStreaming && displayContent && (
        <div className="streaming-complete-indicator">✓ Complete</div>
      )}
    </div>
  );
}

/**
 * Hook for managing streaming state in components
 */
export function useStreaming(endpoint, options = {}) {
  const [content, setContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);

  const startStream = async (payload) => {
    setContent("");
    setError(null);
    setIsStreaming(true);

    try {
      await streamToReactState(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          ...options,
        },
        setContent,
        {
          onComplete: (fullText) => {
            setIsStreaming(false);
            options.onComplete?.(fullText);
          },
          onError: (err) => {
            setIsStreaming(false);
            setError(err.message);
            options.onError?.(err);
          },
        }
      );
    } catch (err) {
      setIsStreaming(false);
      setError(err.message);
      options.onError?.(err);
    }
  };

  return {
    content,
    isStreaming,
    error,
    startStream,
    reset: () => {
      setContent("");
      setError(null);
      setIsStreaming(false);
    },
  };
}

/**
 * Example usage:
 *
 * export function MyComponent() {
 *   const { content, isStreaming, error, startStream } = useStreaming(
 *     `${BACKEND_BASE}/my-endpoint-stream`
 *   );
 *
 *   return (
 *     <div>
 *       <button onClick={() => startStream({ data: "..." })}>
 *         Start
 *       </button>
 *       <StreamingDisplay
 *         content={content}
 *         isStreaming={isStreaming}
 *       />
 *       {error && <div className="error">{error}</div>}
 *     </div>
 *   );
 * }
 */
