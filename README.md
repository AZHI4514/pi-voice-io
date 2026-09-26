# Pi Voice I/O

Pi Voice I/O 是一个给 [pi coding agent](https://github.com/badlogic/pi-mono) 使用的本地语音输入输出扩展。它把语音转写结果写入 pi 原生输入框，用户可以检查和修改文字，只有按下 pi 原生回车后任务才会发送。

任务结束后，扩展使用当前 pi 模型生成不超过三句的中文摘要，并通过本地 Piper 播放。播放时用户开口可以立即打断，之后继续录音和转写。pi 终端始终是唯一的工作界面，浏览器页面只负责麦克风权限、VAD、音频播放和连接状态。

## 项目架构

```text
pi Agent terminal
  └─ src/extension.ts       pi 扩展、草稿同步、任务摘要、生命周期清理
       └─ audio/bridge.mjs  本地 loopback HTTP/WebSocket、ASR/TTS 子进程协调
            ├─ audio/asr-worker.mjs  sherpa-onnx + SenseVoiceSmall
            └─ web/             Chrome/Edge 音频辅助页
                 ├─ getUserMedia 麦克风与 AEC/降噪/自动增益请求
                 ├─ vad-web + Silero V5 VAD
                 └─ PCM 播放与播放打断
```

所有音频处理均在本机完成。桥接服务只监听 `127.0.0.1`，每次 `/voice-io on` 生成新的令牌，并校验 Host、Origin 和 WebSocket 令牌。

## 安装要求

- Windows x64
- Node.js `>=22.19.0`
- pi `0.87.1`
- Chrome 或 Edge
- 已安装并可运行的 Piper Windows 程序
- SenseVoiceSmall 和 Piper 中文 voice 模型

模型文件不随 Git 仓库发布。请按照 [models/README.md](models/README.md) 下载、核对许可证和 SHA-256，并放到 `models/assets/` 对应目录。

## 安装到 pi Agent

```powershell
git clone [<你的 GitHub 仓库地址>](https://github.com/AZHI4514/pi-voice-io.git) pi-voice-io
cd pi-voice-io
npm.cmd ci
pi.cmd -e .\src\extension.ts
```

也可以在 pi 的扩展配置中加入 `src/extension.ts`。`npm ci` 必须在包含 `package-lock.json` 的仓库根目录执行。

## 快速开始

1. 在 pi 中输入 `/voice-io on`。
2. 从 pi 通知中完整复制本次会话的新地址到 Chrome 或 Edge。地址必须是 `http://127.0.0.1:<端口>/?token=...`。
3. 点击浏览器页面的“启用麦克风”，授权设备。
4. 直接说话。识别文字会追加到 pi 原生输入框，不会自动发送。
5. 可以继续说多句话，文字会继续追加到同一草稿；检查或修改完成后按 pi 原生回车发送。
6. pi 任务真正结束后会播放中文摘要。播放时开口可立即打断并继续录音。

可用命令：

```text
/voice-io on       启用本地语音输入输出
/voice-io off      停止并释放麦克风、页面连接和子进程
/voice-io status   查看状态和当前浏览器地址
/voice-io accept   将手动编辑冲突时保留的候选文字追加到草稿
```

## 注意事项

- **启用后不要切换麦克风输入设备。** 请在开始使用前选好 Windows 默认输入设备；切换设备可能让浏览器流和 VAD 停止工作。切换后执行 `/voice-io off`、`/voice-io on`，重新打开新地址并授权。
- 每次重启 pi、重载扩展或重新执行 `/voice-io on` 后，都必须使用最新通知中的地址。不要使用旧地址，不要把 `127.0.0.1` 改成 `localhost`，不要截断 `token`。
- 浏览器页面不是聊天窗口，没有发送按钮、会话管理或 Agent 控制；任务仍由 pi 终端完成。
- 识别结果只写入草稿，不会替用户按回车。手动编辑优先于后续识别结果。
- AEC、降噪和自动增益只是浏览器请求项，不能保证所有硬件都能消除回声。外放时可能误触发 VAD，建议优先使用耳机。
- 本地 ASR/TTS 不需要网络。摘要调用使用当前 pi 模型；模型不可用、超时或断网时会播放与实际状态匹配的固定短句。
- 端口默认是 `18764`。被占用时可设置 `PI_VOICE_PORT`，然后必须使用新端口生成的地址。
- 模型和 Piper 可执行文件体积较大且许可证各不相同，不要把它们提交到公共仓库。

## 故障排查

- `403 Forbidden`：重新执行 `/voice-io off` 和 `/voice-io on`，使用新通知中的完整 URL。响应中的 `token_missing`、`token_invalid_or_expired` 和 `host_must_be_127.0.0.1` 会指出具体原因。
- `no available backend found` 或 WASM/CSP 错误：确认使用的是仓库启动的桥接页面，并重启 pi 让新的资源路由和 CSP 生效。
- 麦克风错误：检查 Windows 麦克风隐私权限、设备占用和输入电平；不要在运行过程中切换输入设备。
- 页面离线或第二轮没有结果：执行 `/voice-io off`、`/voice-io on`，刷新浏览器页面并重新授权。
- Piper 或 SenseVoice 加载失败：检查 `models/assets/` 的文件名、Piper 附带 DLL、模型许可证和 SHA-256。

## 开发检查

```powershell
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

真实麦克风、耳机/外放声学打断和长时间运行结果取决于具体 Windows 音频设备，不应仅根据离线测试推断硬件验收结果。

## 隐私与数据

录音片段通过本机 loopback 连接传给本地 ASR，不上传云端，也不会默认保存录音。浏览器只连接当前 pi 启动的 `127.0.0.1` 服务。请不要提交模型文件、令牌、日志、浏览器配置目录或其他包含个人数据的文件。
