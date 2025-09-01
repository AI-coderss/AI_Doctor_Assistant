import React, { useState, useCallback, useRef, useEffect } from "react";
import { useReactMediaRecorder } from "react-media-recorder";
import SendIcon from "@mui/icons-material/Send";
import MicIcon from "@mui/icons-material/Mic";
import StopIcon from "@mui/icons-material/Stop";
import "../styles/ChatInputWidget.css";

const ChatInputWidget = ({ onSendMessage }) => {
  const [inputText, setInputText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const textAreaRef = useRef(null);
  const recognitionRef = useRef(null);

  const { startRecording, stopRecording, mediaBlobUrl } = useReactMediaRecorder({ audio: true });

  const sendAudioBlobAsBytes = useCallback(
    async (audioBlob) => {
      try {
        const buffer = await audioBlob.arrayBuffer();
        const audioArray = Array.from(new Uint8Array(buffer));
        onSendMessage({ audioFile: audioArray });
      } catch (error) {
        console.error("Error sending audio blob:", error);
      }
    },
    [onSendMessage]
  );

  const handleRecordingStop = useCallback(async () => {
    if (mediaBlobUrl) {
      try {
        const response = await fetch(mediaBlobUrl);
        const audioBlob = await response.blob();
        await sendAudioBlobAsBytes(audioBlob);
      } catch (error) {
        console.error("Error handling audio recording:", error);
      } finally {
        setIsRecording(false);
      }
    }
  }, [mediaBlobUrl, sendAudioBlobAsBytes]);

  const startTranscription = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error("SpeechRecognition not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interimTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          setInputText((prevText) => {
            const newText = prevText + event.results[i][0].transcript;
            adjustTextAreaHeight();
            return newText;
          });
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      if (textAreaRef.current) {
        textAreaRef.current.value = interimTranscript;
        adjustTextAreaHeight();
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  };

  const stopTranscription = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
  };

  const adjustTextAreaHeight = (reset = false) => {
    if (textAreaRef.current) {
      textAreaRef.current.style.height = "auto";
      if (!reset) {
        textAreaRef.current.style.height = `${textAreaRef.current.scrollHeight}px`;
      }
    }
  };

  useEffect(() => {
    adjustTextAreaHeight();
  }, []);

  const handleInputChange = (event) => {
    const newValue = event.target.value;
    setInputText(newValue);
    adjustTextAreaHeight();
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (inputText.trim().length > 0) {
        handleSendMessage();
      }
    }
  };

  const handleSendMessage = () => {
    if (inputText.trim().length > 0) {
      onSendMessage({ text: inputText });
      setInputText("");
      adjustTextAreaHeight(true);
    }

    if (isRecording) {
      stopRecording();
      stopTranscription();
      setIsRecording(false);
    }
  };

  const handleIconClick = () => {
    if (inputText.trim().length > 0) {
      handleSendMessage();
    } else {
      if (isRecording) {
        stopRecording();
        stopTranscription();
        handleRecordingStop();
      } else {
        startRecording();
        startTranscription();
      }
    }
  };

  return (
    <div className="chat-container">
      <textarea
        ref={textAreaRef}
        className="chat-input"
        placeholder="Chat in text or start speaking..."
        value={inputText}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        rows={1}
        style={{ resize: "none", overflow: "hidden" }}
      />
      <button className="icon-btn" onClick={handleIconClick}>
        {inputText.trim().length > 0 ? (
          <SendIcon />
        ) : isRecording ? (
          <StopIcon />
        ) : (
          <MicIcon />
        )}
      </button>
    </div>
  );
};

export default ChatInputWidget;