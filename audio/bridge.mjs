import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { WebSocketServer } from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.VOICE_TOKEN;
const port = Number(process.env.VOICE_PORT || 18764);
if (!token) throw new Error("VOICE_TOKEN is required");
const origin = `http://127.0.0.1:${port}`;
let browser;
let sessionEpoch = 0;
let draftEpoch = 0;
let utteranceId = 0;
let playbackId = "";
let sequence = 0;
let tts;
let asrWorker;
let asrBusy = false;
let pendingTranscription;

function report(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function send(message) {
  if (browser?.readyState === 1)
    browser.send(JSON.stringify({ v: 1, ...message }));
}
function error(message) {
  report({ type: "error", message: String(message) });
  send({ type: "state", value: "音频错误，请查看 pi 状态" });
}

function transcribe(message) {
  if (
    message.sessionEpoch !== sessionEpoch ||
    message.draftEpoch !== draftEpoch ||
    message.utteranceId <= utteranceId
  )
    return;
  if (asrBusy) {
    pendingTranscription = message;
    return;
  }
  utteranceId = message.utteranceId;
  const pcm = Buffer.from(message.pcm || "", "base64");
  if (!pcm.length || pcm.length > 60 * 16000 * 2)
    return error("ASR segment empty or over 60 seconds");
  const snapshot = { sessionEpoch, draftEpoch, utteranceId, seq: ++sequence };
  asrBusy = true;
  const worker =
    asrWorker || new Worker(new URL("./asr-worker.mjs", import.meta.url));
  asrWorker = worker;
  const finish = () => {
    clearTimeout(timer);
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
    asrBusy = false;
    const next = pendingTranscription;
    pendingTranscription = undefined;
    if (next) queueMicrotask(() => transcribe(next));
  };
  const onMessage = (result) => {
    if (result.id !== snapshot.seq) return;
    finish();
    if (result.error) return error(result.error);
    send({ type: "state", value: "录音" });
    if (
      snapshot.sessionEpoch === sessionEpoch &&
      snapshot.draftEpoch === draftEpoch &&
      result.text
    )
      report({
        type: "transcript",
        ...snapshot,
        text: result.text,
        final: true,
      });
  };
  const onError = (cause) => {
    finish();
    asrWorker = undefined;
    error(cause.message);
  };
  const onExit = (code) => {
    finish();
    asrWorker = undefined;
    if (code) error(`ASR worker exited: ${code}`);
  };
  const timer = setTimeout(() => {
    finish();
    asrWorker = undefined;
    void worker.terminate();
    error("ASR timeout");
  }, 15000);
  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("exit", onExit);
  worker.postMessage({ pcm, id: snapshot.seq });
}

function stopPlayback() {
  playbackId = "";
  tts?.kill();
  tts = undefined;
  send({ type: "stop" });
}

function resamplePcm16(input, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) return input;
  const sourceLength = Math.floor(input.length / 2);
  const outputLength = Math.ceil((sourceLength * targetRate) / sourceRate);
  const output = Buffer.allocUnsafe(outputLength * 2);
  for (let i = 0; i < outputLength; i++) {
    const position = (i * sourceRate) / targetRate;
    const first = Math.min(Math.floor(position), sourceLength - 1);
    const second = Math.min(first + 1, sourceLength - 1);
    const value =
      input.readInt16LE(first * 2) * (1 - (position - first)) +
      input.readInt16LE(second * 2) * (position - first);
    output.writeInt16LE(Math.round(value), i * 2);
  }
  return output;
}

function speak(message) {
  stopPlayback();
  if (
    message.sessionEpoch !== sessionEpoch ||
    !message.text ||
    !message.playbackId
  )
    return;
  playbackId = message.playbackId;
  send({ type: "prepare", playbackId });
  const binary =
    process.env.PIPER_PATH || resolve(root, "models/assets/piper/piper.exe");
  const model = resolve(root, "models/assets/piper/zh_CN-huayan-medium.onnx");
  if (!existsSync(binary) || !existsSync(model) || !existsSync(model + ".json"))
    return error("Piper executable or voice missing; see models/README.md");
  let sourceRate;
  try {
    sourceRate = JSON.parse(readFileSync(model + ".json", "utf8")).audio
      .sample_rate;
  } catch {
    return error("Piper voice configuration invalid");
  }
  if (!Number.isInteger(sourceRate) || sourceRate < 8000 || sourceRate > 48000)
    return error("Piper sample rate invalid");
  const synth = spawn(binary, ["--model", model, "--output_raw"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  tts = synth;
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => {
    synth.kill();
    error("TTS timeout");
  }, 15000);
  synth.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 16000 * 2 * 30) {
      synth.kill();
      error("TTS output too long");
      return;
    }
    chunks.push(chunk);
  });
  synth.on("error", (cause) => error(cause.message));
  synth.on("close", (code) => {
    clearTimeout(timer);
    if (tts === synth) tts = undefined;
    if (code === 0 && playbackId === message.playbackId)
      send({
        type: "play",
        playbackId,
        pcm: resamplePcm16(Buffer.concat(chunks), sourceRate).toString(
          "base64",
        ),
        sampleRate: 16000,
      });
    else if (code !== 0 && playbackId === message.playbackId)
      error(`Piper exited: ${code}`);
  });
  synth.stdin.end(message.text + "\n");
}

const server = http.createServer(async (request, response) => {
  const host = request.headers.host;
  const url = new URL(request.url || "/", origin);
  const cookie = request.headers.cookie
    ?.split("; ")
    .find((entry) => entry.startsWith("voice_token="))
    ?.slice(12);
  const suppliedToken = url.searchParams.get("token");
  const hostOk = host === `127.0.0.1:${port}`;
  const tokenOk = suppliedToken === token || cookie === token;
  if (!hostOk || !tokenOk) {
    const reason = !hostOk
      ? "host_must_be_127.0.0.1"
      : suppliedToken || cookie
        ? "token_invalid_or_expired"
        : "token_missing";
    response
      .writeHead(403, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(
        `403 Forbidden: ${reason}. Use the complete URL from the current pi session.`,
      );
    return;
  }
  let file;
  let mime;
  if (url.pathname === "/") {
    file = resolve(root, "web/index.html");
    mime = "text/html";
  } else if (url.pathname === "/client.js") {
    file = resolve(root, "web/client.js");
    mime = "text/javascript";
  } else if (url.pathname === "/vad.js") {
    file = resolve(root, "node_modules/@ricky0123/vad-web/dist/bundle.min.js");
    mime = "text/javascript";
  } else if (url.pathname === "/ort.js") {
    file = resolve(root, "node_modules/onnxruntime-web/dist/ort.wasm.min.js");
    mime = "text/javascript";
  } else if (url.pathname === "/silero_vad_v5.onnx") {
    file = resolve(
      root,
      "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx",
    );
    mime = "application/octet-stream";
  } else if (/^\/ort-wasm-[\w.-]+\.wasm$/.test(url.pathname)) {
    file = resolve(
      root,
      "node_modules/onnxruntime-web/dist",
      url.pathname.slice(1),
    );
    mime = "application/wasm";
  } else if (/^\/ort-wasm-[\w.-]+\.mjs$/.test(url.pathname)) {
    file = resolve(
      root,
      "node_modules/onnxruntime-web/dist",
      url.pathname.slice(1),
    );
    mime = "text/javascript";
  } else if (url.pathname === "/vad.worklet.bundle.min.js") {
    file = resolve(
      root,
      "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
    );
    mime = "text/javascript";
  } else {
    response.writeHead(404).end();
    return;
  }
  try {
    response.writeHead(200, {
      "content-type": mime,
      "cache-control": "no-store",
      ...(url.pathname === "/"
        ? {
            "set-cookie": `voice_token=${token}; HttpOnly; SameSite=Strict; Path=/`,
          }
        : {}),
      "content-security-policy":
        "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self' 'unsafe-inline'",
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", origin);
  if (
    request.headers.host !== `127.0.0.1:${port}` ||
    request.headers.origin !== origin ||
    url.pathname !== "/socket" ||
    url.searchParams.get("token") !== token
  ) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  browser?.close();
  browser = ws;
  report({ type: "state", value: "待授权" });
  send({ type: "epoch", sessionEpoch, draftEpoch });
  ws.on("message", (payload) => {
    if (payload.length > 2_000_000) {
      ws.close();
      return;
    }
    let message;
    try {
      message = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (message.v !== 1 || ws !== browser) return;
    if (
      message.type === "speech_start" &&
      message.sessionEpoch === sessionEpoch &&
      message.draftEpoch === draftEpoch
    ) {
      report({ type: "speaking", utteranceId: message.utteranceId });
      stopPlayback();
    }
    if (message.type === "speech_end") transcribe(message);
    if (message.type === "state")
      report({ type: "state", value: message.value });
  });
  ws.on("close", () => {
    if (browser === ws) {
      browser = undefined;
      report({ type: "state", value: "离线：辅助页已关闭" });
    }
  });
});
process.on("message", (message) => {
  if (message.type === "epoch") {
    sessionEpoch = message.sessionEpoch;
    draftEpoch = message.draftEpoch;
    utteranceId = 0;
    pendingTranscription = undefined;
    stopPlayback();
    send({ type: "epoch", sessionEpoch, draftEpoch });
  }
  if (message.type === "stop") stopPlayback();
  if (message.type === "speak") speak(message);
});
server.listen(port, "127.0.0.1", () => report({ type: "ready" }));
server.on("error", (cause) => {
  error(cause.message);
  process.exitCode = 1;
});
process.on("disconnect", () => {
  stopPlayback();
  void asrWorker?.terminate();
  wss.close();
  server.close();
});
