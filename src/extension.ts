import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DraftCoordinator, type Transcript } from "./draft.ts";
import { fallback, validateSummary } from "./summary.ts";

const statusKey = "voice-io";
const bridgeFile = fileURLToPath(
  new URL("../audio/bridge.mjs", import.meta.url),
);

export default function voiceIO(pi: ExtensionAPI): void {
  let child: ChildProcess | undefined;
  let editor: DraftCoordinator | undefined;
  let unsubscribe: (() => void) | undefined;
  let active = false;
  let generation = 0;
  let runId = "";
  let settledRun = "";
  let playbackId = "";
  let lastText = "";
  let outcome: "completed" | "aborted" | "error" | "unknown" = "unknown";
  let summarizing: AbortController | undefined;
  let uiPrompt = false;
  let bridgeUrl = "";

  function status(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) ctx.ui.setStatus(statusKey, `语音: ${text}`);
  }

  function send(message: object): void {
    if (child?.connected) {
      try {
        child.send(message);
      } catch {
        /* Audio failure never changes the editor. */
      }
    }
  }

  function cancelPlayback(): void {
    playbackId = randomUUID();
    summarizing?.abort();
    summarizing = undefined;
    send({ type: "stop", playbackId });
  }

  function stop(ctx: ExtensionContext): void {
    generation++;
    active = false;
    bridgeUrl = "";
    cancelPlayback();
    unsubscribe?.();
    unsubscribe = undefined;
    editor?.resetSession();
    if (child) {
      const old = child;
      child = undefined;
      old.removeAllListeners();
      old.kill();
    }
    status(ctx, "关闭");
  }

  async function summarize(
    ctx: ExtensionContext,
    currentRun: string,
    epoch: number,
  ): Promise<void> {
    const controller = new AbortController();
    summarizing = controller;
    const timer = setTimeout(() => controller.abort(), 12000);
    let spoken = fallback(outcome);
    try {
      if (ctx.model && lastText) {
        const prompt = `将以下 pi 运行结果压缩为 1 到 3 句中文口语。只返回 JSON 字符串数组。准确表达失败、取消或待用户决定；不得推断成功。运行状态: ${outcome}\n结果:\n${lastText.slice(-8000)}`;
        const result = await ctx.modelRegistry.complete(
          ctx.model,
          {
            systemPrompt:
              "你只总结实际运行结果，不执行任务，不添加未经证实的成功结论。",
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            signal: controller.signal,
            cacheRetention: "none",
            sessionId: randomUUID(),
          },
        );
        const raw = result.content
          .filter(
            (part): part is { type: "text"; text: string } =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join("");
        spoken = validateSummary(raw) ?? spoken;
      }
    } catch {
      /* Use the status-specific fallback. */
    } finally {
      clearTimeout(timer);
      if (summarizing === controller) summarizing = undefined;
    }
    if (
      !active ||
      epoch !== generation ||
      currentRun !== runId ||
      controller.signal.aborted
    )
      return;
    const id = (playbackId = randomUUID());
    status(ctx, "播报");
    send({
      type: "speak",
      sessionEpoch: editor?.sessionEpoch,
      runId,
      playbackId: id,
      text: spoken,
    });
  }

  function start(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (active) return;
    active = true;
    const epoch = ++generation;
    editor = new DraftCoordinator(ctx.ui);
    const token = randomBytes(24).toString("hex");
    const port = Number(process.env.PI_VOICE_PORT || 18764);
    bridgeUrl = `http://127.0.0.1:${port}/?token=${token}`;
    child = spawn(process.execPath, [bridgeFile], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, VOICE_TOKEN: token, VOICE_PORT: String(port) },
      windowsHide: true,
    });
    const bridge = child;
    send({
      type: "epoch",
      sessionEpoch: editor.sessionEpoch,
      draftEpoch: editor.draftEpoch,
    });
    createInterface({ input: bridge.stdout! }).on("line", (line) => {
      if (!active || epoch !== generation) return;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === "ready") {
        status(ctx, "等待浏览器连接");
        ctx.ui.notify(
          `请完整复制此地址到 Chrome/Edge（不要改成 localhost）：\n${bridgeUrl}\n授权麦克风后保持此 pi 会话运行。`,
          "info",
        );
      } else if (message.type === "transcript") {
        if (uiPrompt || !editor) return;
        const result = editor.apply(message as Transcript);
        status(
          ctx,
          result === "candidate"
            ? "手动编辑优先；候选可用 /voice-io accept 插入"
            : message.final
              ? "等待确认"
              : "识别中",
        );
      } else if (message.type === "speaking") {
        cancelPlayback();
        editor?.beginUtterance(message.utteranceId);
        status(ctx, "录音");
      } else if (message.type === "state") {
        status(ctx, String(message.value));
      } else if (message.type === "error") {
        editor?.recognitionFailed();
        status(ctx, `错误: ${String(message.message).slice(0, 80)}`);
      }
    });
    bridge.stderr?.on("data", () => {
      /* Never let subprocess diagnostics reach the editor. */
    });
    bridge.on("error", (error) => {
      if (epoch === generation) status(ctx, `错误: ${error.message}`);
    });
    bridge.on("exit", () => {
      if (epoch === generation && active) status(ctx, "离线：音频进程退出");
    });
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!active || !editor) return;
      // Keep pi's native Enter behavior. A user may submit the current draft
      // while another utterance is still being recognized.
      editor.manualInput();
      return undefined;
    });
    status(ctx, "启动中");
  }

  pi.registerCommand("voice-io", {
    description: "本地语音输入输出：on / off / status / accept",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") start(ctx);
      else if (action === "off") stop(ctx);
      else if (action === "accept" && editor?.candidate && ctx.hasUI) {
        const current = ctx.ui.getEditorText();
        ctx.ui.setEditorText(
          current +
            (current && !/\s$/.test(current) ? " " : "") +
            editor.candidate,
        );
        editor.candidate = "";
        status(ctx, "等待确认");
      } else if (action === "status")
        ctx.ui.notify(
          active
            ? `语音开启；${editor?.recognizing ? "识别中" : "等待输入"}\n${bridgeUrl || "浏览器地址尚未就绪"}`
            : "语音关闭",
          "info",
        );
      else ctx.ui.notify("用法: /voice-io on | off | status | accept", "info");
    },
  });

  pi.on("input", (event) => {
    if (!active || event.source !== "interactive") return;
    editor?.resetDraft();
    cancelPlayback();
    send({
      type: "epoch",
      sessionEpoch: editor?.sessionEpoch,
      draftEpoch: editor?.draftEpoch,
    });
  });
  pi.on("agent_start", (_event, ctx) => {
    runId = randomUUID();
    settledRun = "";
    lastText = "";
    outcome = "unknown";
    cancelPlayback();
    status(ctx, "执行");
  });
  pi.on("agent_end", (event) => {
    if (!active) return;
    const last = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (last?.role === "assistant") {
      lastText = last.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n");
      outcome =
        last.stopReason === "error"
          ? "error"
          : last.stopReason === "aborted"
            ? "aborted"
            : "completed";
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!active || !runId || settledRun === runId) return;
    settledRun = runId;
    void summarize(ctx, runId, generation);
  });
  pi.on("ui_prompt_start", () => {
    uiPrompt = true;
  });
  pi.on("ui_prompt_end", () => {
    uiPrompt = false;
  });
  pi.on("session_tree", (_event, ctx) => {
    if (active) stop(ctx);
  });
  pi.on("session_before_switch", (_event, ctx) => {
    if (active) stop(ctx);
  });
  pi.on("session_start", (event, ctx) => {
    if (active && event.reason === "reload") stop(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => stop(ctx));
}
