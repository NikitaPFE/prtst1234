import { useState, useEffect, useRef, useMemo } from "react";
import {
  useDaily,
  DailyVideo,
  useParticipantIds,
  useLocalSessionId,
  useAudioTrack,
  DailyAudio,
} from "@daily-co/daily-react";
import { createConversation } from "./api/createConversation";
import type { IConversation } from "./types";

const initWebGL = (gl: WebGLRenderingContext) => {
  const vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0, 1);
      v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y); // Flip the y-coordinate
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
      if (diff < u_threshold) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
      } else {
        gl_FragColor = color;
      }
    }
  `;

  // Create shader program
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vertexShader, vertexShaderSource);
  gl.compileShader(vertexShader);

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fragmentShader, fragmentShaderSource);
  gl.compileShader(fragmentShader);

  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.useProgram(program);

  // Set up buffers
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

  // Set up attributes and uniforms
  const positionLocation = gl.getAttribLocation(program, "a_position");
  const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");

  gl.enableVertexAttribArray(positionLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.enableVertexAttribArray(texCoordLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

  const imageLocation = gl.getUniformLocation(program, "u_image");
  const keyColorLocation = gl.getUniformLocation(program, "u_keyColor");
  const thresholdLocation = gl.getUniformLocation(program, "u_threshold");

  // Create a texture
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  return {
    program,
    texture,
    imageLocation,
    keyColorLocation,
    thresholdLocation,
  };
};

export const Video = ({ id }: { id: string }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const webGLContext = useMemo(() => {
    if (canvasRef.current) {
      console.log("initWebGL");
      const gl = canvasRef.current.getContext("webgl", {
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
          // HAVE_CURRENT_DATA or higher
          setIsVideoReady(true);
          video.removeEventListener("canplay", checkVideoReady);
        }
      };
      video.addEventListener("canplay", checkVideoReady);
      return () => video.removeEventListener("canplay", checkVideoReady);
    }
  }, []);

  useEffect(() => {
    console.log("isVideoReady", isVideoReady, webGLContext);
    if (!isVideoReady || !webGLContext) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const gl = glRef.current;
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

      if (
        video &&
        canvas &&
        gl &&
        video.readyState === video.HAVE_ENOUGH_DATA
      ) {
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
        // 3 255 156
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
      style={{
        height: "13rem",
        position: "relative",
        // width: "100%",
        aspectRatio: "16 / 9",
      }}
    >
      <DailyVideo
        sessionId={id}
        type="video"
        ref={videoRef}
        style={{
          height: "13rem",
          display: "none",
        }}
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
          width: "1.5rem",
          height: "1.5rem",
        }}
      >
        {!isMicEnabled ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
            <title>Mic off</title>
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
            <title>Mic on</title>
          </svg>
        )}
      </button>
      <DailyAudio />
    </div>
  );
};

function App() {
  const [token, setToken] = useState("");
  const [isTokenSubmitted, setIsTokenSubmitted] = useState(false);
  const [conversation, setConversation] = useState<IConversation | null>(null);
  const [loading, setLoading] = useState(false);
  const DailyCall = useDaily();

  const handleTokenSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsTokenSubmitted(true);
  };

  const startVideoCall = async () => {
    if (token && DailyCall) {
      setLoading(true);
      try {
        const conversation = await createConversation(token);
        await DailyCall.join({ url: conversation.conversation_url });
        setConversation(conversation);
      } catch (error) {
        console.error("Failed to join the call:", error);
      }
      setLoading(false);
    } else {
      console.error("Token is required to start the call");
    }
  };

  const getDisplayToken = () => {
    return token.length > 4 ? `****${token.slice(-4)}` : token;
  };

  return (
    <main>
      <form onSubmit={handleTokenSubmit}>
        <input
          type="text"
          value={isTokenSubmitted ? getDisplayToken() : token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Enter token"
          disabled={isTokenSubmitted}
        />
        <button type="submit" disabled={isTokenSubmitted}>
          Submit Token
        </button>
      </form>
      {isTokenSubmitted && !conversation && (
        <button
          onClick={startVideoCall}
          disabled={!isTokenSubmitted || loading}
          type="button"
        >
          {loading ? "Loading..." : "Start Video Call"}
        </button>
      )}

      {conversation && <Call />}
    </main>
  );
}

export default App;
