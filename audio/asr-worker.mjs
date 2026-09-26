import { parentPort } from "node:worker_threads";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const modelDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../models/assets/sensevoice",
);
const model = resolve(modelDir, "model.int8.onnx");
const tokens = resolve(modelDir, "tokens.txt");
let recognizer;

parentPort.on("message", async ({ pcm, id }) => {
  try {
    if (!existsSync(model) || !existsSync(tokens))
      throw new Error("SenseVoiceSmall model missing; see models/README.md");
    if (!recognizer) {
      const sherpa = await import("sherpa-onnx");
      recognizer = sherpa.createOfflineRecognizer({
        modelConfig: {
          senseVoice: {
            model,
            language: "auto",
            useInverseTextNormalization: 1,
          },
          tokens,
          numThreads: 1,
          provider: "cpu",
        },
      });
    }
    const bytes = Buffer.from(pcm);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++)
      samples[i] = bytes.readInt16LE(i * 2) / 32768;
    const stream = recognizer.createStream();
    try {
      stream.acceptWaveform(16000, samples);
      recognizer.decode(stream);
      parentPort.postMessage({
        id,
        text: recognizer.getResult(stream)?.text?.trim() || "",
      });
    } finally {
      stream.free?.();
    }
  } catch (cause) {
    parentPort.postMessage({ id, error: cause?.message || String(cause) });
  }
});
