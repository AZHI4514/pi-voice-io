const params = new URLSearchParams(location.search);
const token = params.get("token");
const state = document.querySelector("#state");
const device = document.querySelector("#device");
const enable = document.querySelector("#enable");
let socket,
  vad,
  stream,
  context,
  playing,
  generation = 0,
  allowedPlaybackId = "",
  sessionEpoch = 0,
  draftEpoch = 0,
  utteranceId = 0;

function show(value) {
  state.textContent = value;
  if (socket?.readyState === 1)
    socket.send(JSON.stringify({ v: 1, type: "state", value }));
}
function send(value) {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ v: 1, ...value }));
}
function stopPlayback() {
  generation++;
  allowedPlaybackId = "";
  try {
    playing?.stop();
  } catch {}
  playing?.disconnect();
  playing = undefined;
}
function pcmBase64(audio) {
  const bytes = new Uint8Array(audio.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < audio.length; i++)
    view.setInt16(
      i * 2,
      Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32767))),
      true,
    );
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function play(message) {
  stopPlayback();
  const epoch = generation;
  const binary = atob(message.pcm);
  const buffer = context.createBuffer(1, binary.length / 2, message.sampleRate);
  const samples = buffer.getChannelData(0);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++)
    view.setUint8(i, binary.charCodeAt(i));
  for (let i = 0; i < samples.length; i++)
    samples[i] = view.getInt16(i * 2, true) / 32768;
  if (epoch !== generation) return;
  playing = context.createBufferSource();
  playing.buffer = buffer;
  playing.connect(context.destination);
  playing.start();
  playing.onended = () => {
    if (epoch === generation) {
      playing = undefined;
      show("录音");
    }
  };
  show("播报");
}
function connect() {
  socket = new WebSocket(
    `ws://${location.host}/socket?token=${encodeURIComponent(token)}`,
  );
  socket.onopen = () => show("已连接，等待麦克风授权");
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "epoch") {
      sessionEpoch = message.sessionEpoch;
      draftEpoch = message.draftEpoch;
      utteranceId = 0;
      stopPlayback();
    }
    if (message.type === "stop") stopPlayback();
    if (message.type === "state") state.textContent = message.value;
    if (message.type === "prepare") allowedPlaybackId = message.playbackId;
    if (
      message.type === "play" &&
      context &&
      message.playbackId === allowedPlaybackId
    )
      play(message);
  };
  socket.onclose = () => {
    stopPlayback();
    vad?.destroy();
    stream?.getTracks().forEach((track) => track.stop());
    context?.close();
    show("离线：连接已断开，请返回 pi 检查状态");
  };
}
enable.onclick = async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    context = new AudioContext();
    await context.resume();
    const settings = stream.getAudioTracks()[0].getSettings();
    device.textContent = `设备: ${stream.getAudioTracks()[0].label || "麦克风"}；AEC: ${settings.echoCancellation ?? "未知"}`;
    vad = await window.vad.MicVAD.new({
      model: "v5",
      baseAssetPath: "/",
      onnxWASMBasePath: "/",
      ortConfig: (ort) => {
        ort.env.logLevel = "error";
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
      },
      getStream: async () => stream,
      preSpeechPadMs: 500,
      redemptionMs: 600,
      onSpeechStart: () => {
        stopPlayback();
        send({
          type: "speech_start",
          sessionEpoch,
          draftEpoch,
          utteranceId: ++utteranceId,
        });
        show("录音");
      },
      onSpeechEnd: (audio) => {
        if (audio.length > 16000 * 60) {
          show("语音超过 60 秒，请分段说话");
          return;
        }
        send({
          type: "speech_end",
          sessionEpoch,
          draftEpoch,
          utteranceId,
          pcm: pcmBase64(audio),
        });
        show("识别中");
      },
    });
    vad.start();
    enable.disabled = true;
    show("录音");
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    console.error("Pi Voice I/O microphone/VAD initialization failed", error);
    show(`麦克风错误: ${detail}`);
    try {
      vad?.destroy();
    } catch {}
    vad = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    try {
      await context?.close();
    } catch {}
    context = undefined;
    enable.disabled = false;
  }
};
addEventListener("beforeunload", () => {
  stopPlayback();
  vad?.destroy();
  stream?.getTracks().forEach((track) => track.stop());
  context?.close();
  socket?.close();
});
connect();
