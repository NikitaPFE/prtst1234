import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  useDaily,
  DailyVideo,
  useParticipantIds,
  useLocalSessionId,
  useAudioTrack,
  DailyAudio,
  useDailyEvent,
} from "@daily-co/daily-react";
import { createConversation } from "./api/createConversation";
import type { IConversation } from "./types";
import { ReplicaRecording } from "./ReplicaRecording";

const vertexShaderSource = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0, 1);
    v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  uniform sampler2D u_image;
  varying vec2 v_texCoord;
  uniform vec3 u_keyColor;
  uniform float u_threshold;
  void main() {
    vec4 color = texture2D(u_image, v_texCoord);
    float diff = length(color.rgb - u_keyColor);
    gl_FragColor = diff < u_threshold ? vec4(0.0) : color;
  }
`;

const initShader = (
  gl: WebGLRenderingContext,
  type: number,
  source: string,
) => {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
};

const initWebGL = (gl: WebGLRenderingContext) => {
  const program = gl.createProgram()!;
  gl.attachShader(
    program,
    initShader(gl, gl.VERTEX_SHADER, vertexShaderSource),
  );
  gl.attachShader(
    program,
    initShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource),
  );
  gl.linkProgram(program);
  gl.useProgram(program);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const texCoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const positionLocation = gl.getAttribLocation(program, "a_position");
  const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");

  gl.enableVertexAttribArray(positionLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.enableVertexAttribArray(texCoordLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  return {
    program,
    texture,
    imageLocation: gl.getUniformLocation(program, "u_image"),
    keyColorLocation: gl.getUniformLocation(program, "u_keyColor"),
    thresholdLocation: gl.getUniformLocation(program, "u_threshold"),
  };
};

export const Video: React.FC<{ id: string }> = ({ id }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const glRef = useRef<WebGLRenderingContext | null>(null);

  const webGLContext = useMemo(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const gl = canvas.getContext("webgl", {
        premultipliedAlpha: false,
        alpha: true,
      });
      if (gl) {
        glRef.current = gl;
        return initWebGL(gl);
      }
    }
    return null;
  }, [canvasRef.current]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      const checkVideoReady = () => {
        if (video.readyState >= 2) {
          setIsVideoReady(true);
          video.removeEventListener("canplay", checkVideoReady);
        }
      };
      video.addEventListener("canplay", checkVideoReady);
      return () => video.removeEventListener("canplay", checkVideoReady);
    }
  }, []);

  useEffect(() => {
    if (!isVideoReady || !webGLContext) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const gl = glRef.current;
    if (!video || !canvas || !gl) return;

    const {
      program,
      texture,
      imageLocation,
      keyColorLocation,
      thresholdLocation,
    } = webGLContext;

    let animationFrameId: number;
    let lastFrameTime = 0;
    const targetFPS = 30;
    const frameInterval = 1000 / targetFPS;

    const applyChromaKey = (currentTime: number) => {
      if (currentTime - lastFrameTime < frameInterval) {
        animationFrameId = requestAnimationFrame(applyChromaKey);
        return;
      }

      lastFrameTime = currentTime;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          video,
        );

        gl.uniform1i(imageLocation, 0);
        gl.uniform3f(keyColorLocation, 3 / 255, 255 / 255, 156 / 255);
        gl.uniform1f(thresholdLocation, 0.3);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      animationFrameId = requestAnimationFrame(applyChromaKey);
    };

    applyChromaKey(0);

    return () => {
      cancelAnimationFrame(animationFrameId);
      if (gl && program && texture) {
        gl.deleteProgram(program);
        gl.deleteTexture(texture);
      }
    };
  }, [isVideoReady, webGLContext]);

  return (
    <div
      style={{ height: "13rem", position: "relative", aspectRatio: "16 / 9" }}
    >
      <DailyVideo
        sessionId={id}
        type="video"
        ref={videoRef}
        style={{ height: "13rem", display: "none" }}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
};

export const Call = () => {
  const remoteParticipantIds = useParticipantIds({ filter: "remote" });
  const localParticipantId = useLocalSessionId();
  const localAudio = useAudioTrack(localParticipantId);
  const daily = useDaily();
  const isMicEnabled = !localAudio.isOff;

  const toggleMicrophone = () => {
    daily?.setLocalAudio(!isMicEnabled);
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: "16px",
        right: "16px",
      }}
    >
      <div style={{ position: "relative" }}>
        {remoteParticipantIds.length > 0 ? (
          <Video id={remoteParticipantIds[0]} />
        ) : (
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "10rem",
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ animation: "spin 1s linear infinite" }}
              aria-label="Loading spinner"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              <title>Loading spinner</title>
            </svg>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={toggleMicrophone}
        style={{
          position: "absolute",
          top: "0",
          right: "2rem",
          zIndex: "50",
          padding: "0.25rem",
          height: "1.5rem",
        }}
      >
        {!isMicEnabled ? "Mic is Off" : "Mic is On"}
      </button>
      <DailyAudio />
    </div>
  );
};

const Chat = ({ conversationId }: { conversationId: string }) => {
  const daily = useDaily();
  const [userMessage, setUserMessage] = useState<string>("");
  const [messages, setMessages] = useState<{
    role: string;
    speech: string;
  }[]>([]);

  // {
  //   "message_type": "conversation",
  //   "event_type": "conversation.utterance",
  //   "conversation_id": "c123456",
  //   "properties": {
  //     "role": "<string>",
  //     "speech": "Hello, how are you?",
  //     "visual_context": "There is a man wearing over-ear headphones in a room that seems to be in an office setting, with monitors in the background. The man seems happy, and is looking at the screen."
  //   }
  // }
  useDailyEvent('app-message', useCallback((event) => {
    if (event.data?.event_type === 'conversation.utterance') {
      console.log('utterance', event)
      setMessages((messages) => [...messages, {
        role: event.data.properties.role,
        speech: event.data.properties.speech,
      }]);
    }
  }, []));

  const handleSendMessage = () => {
    if (!userMessage) return;
    daily?.sendAppMessage({
      "message_type": "conversation",
      "event_type": "conversation.respond",
      "conversation_id": conversationId,
      "properties": {
        "text": userMessage
      }
    });
    setUserMessage("");
  };

  const handleEchoMessage = () => {
    if (!userMessage) return;
    daily?.sendAppMessage({
      "message_type": "conversation",
      "event_type": "conversation.echo",
      "conversation_id": conversationId,
      "properties": {
        "text": userMessage
      }
    });
    setUserMessage("");
  };

  return (
    <div>
      {/* user, replica */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", height: "200px", overflowY: "auto", backgroundColor: "white" }}>
        {messages.map((message, index) => (
          <div
            key={`message-${index}`}
            style={{
              textAlign: message.role === 'replica' ? 'left' : 'right',
              marginBottom: '8px',
            }}
          >
            {message.speech}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <input type="text" onChange={(e) => setUserMessage(e.target.value)} />
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" onClick={handleSendMessage}>Send Message</button>
          <button type="button" onClick={handleEchoMessage}>Echo</button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [token, setToken] = useState("");
  const [conversation, setConversation] = useState<IConversation | null>(null);
  const [loading, setLoading] = useState(false);
  const DailyCall = useDaily();
  const [showRecording, setShowRecording] = useState(false);

  const handleStartCall = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (token && DailyCall) {
      setLoading(true);
      try {
        const conversation = await createConversation(token);
        await DailyCall.join({ url: conversation.conversation_url });
        setConversation(conversation);
      } catch (error) {
        alert(`Failed to join the call. ${error}`);
      }
      setLoading(false);
    } else {
      console.error("Token is required to start the call");
    }
  };

  const getDisplayToken = () => {
    return token.length > 4 ? `****${token.slice(-4)}` : token;
  };

  const handleSubmit = (blob: Blob) => {
    const ext = blob.type.split('/')[1];
    const fileName = `${Date.now()}test-video.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();

    URL.revokeObjectURL(url);
  };

  return (
    <main>
      <button type="button" onClick={() => setShowRecording(true)}>
        Show Recording Example
      </button>
      <form onSubmit={handleStartCall} className="token-form">
        <label htmlFor="token">
          Enter your Tavus API token to start, or{" "}
          <a
            href="https://platform.tavus.io/api-keys"
            target="_blank"
            rel="noopener noreferrer"
          >
            create a new one.
          </a>
        </label>
        <div>
          <input
            id="token"
            type="text"
            value={conversation ? getDisplayToken() : token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enter token"
            disabled={!!conversation}
          />
          <button disabled={!token || loading || !!conversation} type="submit">
            {loading ? "Loading..." : "Start Video Call"}
          </button>
        </div>
      </form>

      {conversation && <Call />}
      {conversation && <Chat conversationId={conversation.conversation_id} />}

      {showRecording && <ReplicaRecording onSubmit={handleSubmit} />}
    </main>
  );
}

export default App;
