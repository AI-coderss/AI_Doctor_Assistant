# Token-by-Token Streaming Implementation Guide

## Overview
This guide documents the token-by-token streaming implementation for the DSAH Doctor AI application, enabling real-time text responses similar to ChatGPT.

## ✅ What's Been Implemented

### Backend Updates (app.py)
1. **New Streaming Endpoints Added:**
   - `/drg/validate-stream` - Real-time DRG validation feedback
   - `/drg/fix-stream` - Real-time DRG fix suggestions

2. **CORS Configuration Updated:**
   - Added CORS headers for new streaming endpoints
   - Proper cache-control headers set to prevent buffering

3. **Streaming Pattern Used:**
   ```python
   def generate():
       try:
           for chunk in conversation_rag_chain.stream({"chat_history": ..., "input": ...}):
               token = chunk.get("answer", "")
               if token:
                   yield token
       except Exception as e:
           yield f"\n[Error: {str(e)}]"

   return Response(stream_with_context(generate()), mimetype="text/plain; charset=utf-8")
   ```

### Frontend Updates

#### 1. New Streaming Helper Utility (`src/utils/streamingHelper.js`)
Created reusable utility functions:
- `streamFetch()` - Generic streaming with callbacks
- `extractJSON()` - Parse JSON from streamed responses
- `streamToReactState()` - Stream directly to React state
- `formatStreamedText()` - Normalize markdown

#### 2. Chat Component (`Chat.jsx`)
- Already implements token-by-token streaming for main chat
- Uses `res.body.getReader()` to consume stream
- Updates UI in real-time as tokens arrive
- Properly handles stream completion and normalization

#### 3. DRG Validator Component Updates
- **Store Update**: `useDRGValidatorStore.js` now uses `/drg/validate-stream`
- **Component Update**: `DRGValidator.jsx` now shows streaming feedback for fix suggestions
- Real-time parsing of JSON responses after stream completes

## 🚀 How to Use Streaming in Your Components

### Pattern 1: Simple Text Streaming with State Update
```javascript
import { streamToReactState } from '../utils/streamingHelper';

export default function MyComponent() {
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);

  const handleFetch = async () => {
    setLoading(true);
    setResponse("");
    
    try {
      await streamToReactState(
        `${BACKEND_BASE}/my-endpoint`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ /* payload */ })
        },
        setResponse,
        {
          onComplete: (fullText) => {
            setLoading(false);
            console.log("Stream complete:", fullText);
          },
          onError: (error) => {
            setLoading(false);
            console.error("Stream error:", error);
          }
        }
      );
    } catch (error) {
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={handleFetch} disabled={loading}>
        {loading ? "Loading..." : "Fetch"}
      </button>
      <p>{response}</p>
    </div>
  );
}
```

### Pattern 2: Manual Stream Handling with Callbacks
```javascript
import { streamFetch, formatStreamedText } from '../utils/streamingHelper';

async function handleCustomStream() {
  let fullText = "";
  
  await streamFetch(
    `${BACKEND_BASE}/endpoint`,
    { method: "POST", body: JSON.stringify({}) },
    (chunk, accumulated) => {
      // Called for each chunk
      fullText = accumulated;
      console.log("Current text:", accumulated);
      updateUI(accumulated);
    },
    (fullText) => {
      // Called when stream completes
      console.log("Final text:", fullText);
      const formatted = formatStreamedText(fullText);
      saveFinalResponse(formatted);
    },
    (error) => {
      // Called on error
      console.error("Stream failed:", error);
      showErrorMessage(error.message);
    }
  );
}
```

### Pattern 3: JSON Response Parsing from Stream
```javascript
import { streamFetch, extractJSON, formatStreamedText } from '../utils/streamingHelper';

async function handleJSONStream() {
  let fullText = "";
  
  await streamFetch(
    `${BACKEND_BASE}/json-endpoint`,
    { method: "POST", body: JSON.stringify({}) },
    (chunk) => {
      setStreamingText(prev => prev + chunk);
    },
    (fullText) => {
      // Parse JSON from the completed stream
      const jsonData = extractJSON(fullText);
      const markdown = formatStreamedText(fullText);
      
      if (jsonData) {
        console.log("Parsed data:", jsonData);
        updateTableFromJSON(jsonData);
      }
      setFinalMarkdown(markdown);
    }
  );
}
```

## 📊 Current Streaming Endpoints

### Main Chat
- **Endpoint**: `/stream`
- **Method**: POST
- **Input**: `{ message, session_id }`
- **Output**: Stream of text tokens
- **Component**: Chat.jsx
- **Status**: ✅ Implemented

### Second Opinion Analysis
- **Endpoint**: `/case_second_opinion_stream`
- **Method**: POST
- **Input**: `{ context, session_id }`
- **Output**: Stream of JSON followed by narrative
- **Component**: Chat.jsx
- **Status**: ✅ Implemented

### DRG Validation
- **Endpoint**: `/drg/validate-stream`
- **Method**: POST
- **Input**: `{ session_id, patient_id, second_opinion_json }`
- **Output**: Stream of JSON validation response
- **Component**: DRGValidator, useDRGValidatorStore
- **Status**: ✅ Implemented

### DRG Fix Suggestions
- **Endpoint**: `/drg/fix-stream`
- **Method**: POST
- **Input**: `{ session_id, row }`
- **Output**: Stream of fix suggestions
- **Component**: DRGValidator
- **Status**: ✅ Implemented

## 🔧 Adding Streaming to a New Component

### Step 1: Create Backend Endpoint
```python
@app.route("/my-endpoint-stream", methods=["POST"])
def my_endpoint_stream():
    if request.method == "OPTIONS":
        return make_response(("", 204))
    
    data = request.get_json(silent=True) or {}
    # ... process input ...
    
    def generate():
        try:
            for chunk in your_chain.stream({"input": ...}):
                token = chunk.get("answer", "")
                if token:
                    yield token
        except Exception as e:
            yield f"\n[Error: {str(e)}]"
    
    resp = Response(stream_with_context(generate()), 
                   mimetype="text/plain; charset=utf-8")
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-store"
    return resp
```

### Step 2: Add CORS Configuration
```python
r"/my-endpoint-stream": {
    "origins": [
        "https://ai-doctor-assistant-app-dev.onrender.com",
        "http://localhost:3000",
    ],
    "methods": ["POST", "OPTIONS"],
    "allow_headers": ["Content-Type", "Authorization", "Accept", "X-Requested-With", "X-Session-Id"],
    "expose_headers": ["Content-Type"],
    "supports_credentials": True,
    "max_age": 86400,
},
```

### Step 3: Update Frontend Component
```javascript
import { streamToReactState } from '../utils/streamingHelper';

// In your component
const [text, setText] = useState("");

const handleStream = async () => {
  await streamToReactState(
    `${BACKEND_BASE}/my-endpoint-stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ /* data */ })
    },
    setText
  );
};
```

## 🎨 UI Patterns for Streaming

### Pattern 1: Real-time Text Display with Loading Indicator
```jsx
<div>
  {loading && <LoadingSpinner />}
  <div className={`streaming-text ${loading ? 'streaming' : ''}`}>
    <ReactMarkdown>{message}</ReactMarkdown>
  </div>
</div>
```

### Pattern 2: Progressive Disclosure
```jsx
// Show message as it streams, with typing effect
<div className="message-bubble">
  <div className="message-content">
    {message}
    {isStreaming && <span className="cursor">▌</span>}
  </div>
</div>
```

### Pattern 3: Multiple Concurrent Streams
```jsx
// Track multiple streaming operations
const [streams, setStreams] = useState({});

const startStream = (key) => {
  setStreams(prev => ({ ...prev, [key]: "" }));
  streamToReactState(url, opts, (text) => {
    setStreams(prev => ({ ...prev, [key]: text }));
  });
};
```

## ⚙️ Configuration Tips

### Buffering Control
The following headers prevent buffering in reverse proxies:
```python
resp.headers["X-Accel-Buffering"] = "no"      # nginx
resp.headers["Cache-Control"] = "no-store"    # HTTP caching
```

### Charset Specification
Always specify UTF-8 for text streams:
```python
mimetype="text/plain; charset=utf-8"
```

### Timeout Handling
Clients should handle timeouts gracefully:
```javascript
const timeout = setTimeout(() => {
  reader.cancel();
  setError("Stream timeout");
}, 30000); // 30 second timeout

// Clear timeout when stream completes
onComplete(() => clearTimeout(timeout));
```

## 🐛 Debugging

### Check if stream is being sent:
```javascript
// In browser DevTools > Network tab
// Look for request with "text/plain; charset=utf-8" content-type
// Response should show streaming data
```

### Debug token-by-token:
```javascript
streamFetch(url, opts, 
  (chunk) => console.log("Chunk:", chunk),
  (full) => console.log("Complete:", full),
  (err) => console.error("Error:", err)
);
```

### Verify endpoint returns streaming:
```bash
curl -X POST https://your-backend/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"test","session_id":"123"}'
```

## 📚 Related Files
- Backend streaming logic: `backend/app.py` (lines 841+, 710+, 4040+)
- Frontend utilities: `frontend/src/utils/streamingHelper.js`
- Main chat component: `frontend/src/components/Chat.jsx` (lines 1200+)
- DRG validator: `frontend/src/store/useDRGValidatorStore.js`, `frontend/src/components/DRGValidator.jsx`

## 🎯 Next Steps for Full Implementation
1. Apply streaming pattern to medical image analysis components
2. Add streaming to clinical notes generation
3. Implement streaming for symptoms triage/refining
4. Add streaming to lab agent operations
5. Create streaming UI components for consistent UX
