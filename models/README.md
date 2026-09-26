# 本地模型与运行时

当前项目选用 sherpa-onnx SenseVoiceSmall 2024-07-17 多语模型，以及 Piper `zh_CN-huayan-medium` 中文 voice。两者均为离线推理方案；前者支持中英混合的模型目标，后者固定中文声音。选择基于与项目固定引擎和语言要求匹配，**不是目标机器音质或准确率实测结论**。

本文件记录的下载来源、SHA-256 与许可证条款均在**本机**实际获取并核对过。仍未完成的部分（真实麦克风与播放验收）在末尾单独列出，不要把它读成已通过。

## 已安装并核验的 npm 组件

精确依赖及传递依赖见 `package-lock.json`，npm registry tarball URL 与 SHA-512 integrity 均记录其中。当前实际运行文件 SHA-256：

| 组件                 | 版本    | 来源         | 许可证     | 文件                                                      | SHA-256                                                            |
| -------------------- | ------- | ------------ | ---------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `sherpa-onnx`        | 1.12.17 | npm registry | Apache-2.0 | `node_modules/sherpa-onnx/sherpa-onnx-wasm-nodejs.wasm`   | `c0ed19396b4662c1fd37d256e0bc73c68094f0505c707f6c6ae0d10188a29a01` |
| `@ricky0123/vad-web` | 0.0.27  | npm registry | ISC        | `node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx` | `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f` |
| `onnxruntime-web`    | 1.22.0  | npm registry | MIT        | 见 lockfile                                               | 未逐文件核验                                                       |
| `ws`                 | 8.21.0  | npm registry | MIT        | 见 lockfile                                               | 未逐文件核验                                                       |

兼容基线：Windows x64、Node >=22.19、pi 0.87.1。sherpa 使用 WASM CPU 推理，`numThreads: 1`、`provider: cpu`、16 kHz 单声道 Float32 输入；VAD 使用 Silero v5 本地 ONNX/ORT WASM。GPU 不需要，CPU 和内存需求尚未测量。

> `numThreads` 原为 `2`（与 `spec.md` 一致）。实测该值会使 sherpa-onnx 1.12.17 的 Node WASM 在解码时抛未捕获异常（`numThreads: 1` 正常，`2`/`4` 必崩），因此 `audio/asr-worker.mjs` 已改为 `1`。详见下方「验收记录 / 已修复缺陷」。

## 已安装的模型与运行时

三项此前待取得的文件均已下载、解包并逐文件核验。放置完成后的清单：

| 组件             | 版本 / 标识                        | 来源                                                     | 许可证                               | 文件                                              |      字节 | SHA-256                                                            |
| ---------------- | ---------------------------------- | -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| SenseVoiceSmall  | 2024-07-17 (`iic/SenseVoiceSmall`) | GitHub release `asr-models`（经 `ghfast.top`）           | FunASR Model License v1.1（Alibaba） | `assets/sensevoice/model.int8.onnx`               | 239233841 | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| SenseVoiceSmall  | 同上                               | 同上                                                     | 同上                                 | `assets/sensevoice/tokens.txt`                    |    315894 | `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc` |
| SenseVoiceSmall  | 归档内 `LICENSE` 指针              | 同上                                                     | 指向 FunASR license                  | `assets/sensevoice/LICENSE`                       |        71 | `221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17` |
| Piper 运行时     | `piper.exe` 报告 1.2.0             | GitHub release `2023.11.14-2`（经 `ghfast.top`）         | MIT（+GPL-3.0 的 espeak-ng，见下）   | `assets/piper/piper.exe`                          |    509952 | `96f3da3811151580073e40bb4dd20eb0fb8115f5f5f76e2fb54282b3edfa5c1f` |
| Piper 运行时     | 同一次解包（共 363 个文件）        | 同上                                                     | 同上                                 | `assets/piper/{*.dll,espeak-ng-data/,pkgconfig/}` |         — | 主要文件见下方「Piper 随附二进制」                                 |
| Piper 中文 voice | `zh_CN-huayan-medium`              | HuggingFace `rhasspy/piper-voices`（经 `hf-mirror.com`） | 仓库 MIT；数据集 License Unknown     | `assets/piper/zh_CN-huayan-medium.onnx`           |  63201294 | `9929917bf8cabb26fd528ea44d3a6699c11e87317a14765312420be230be0f3d` |
| Piper 中文 voice | 同上                               | 同上                                                     | 同上                                 | `assets/piper/zh_CN-huayan-medium.onnx.json`      |      4822 | `d521dc45504a8ccc99e325822b35946dd701840bfb07e3dbb31a40929ed6a82b` |

`model.int8.onnx` 的哈希由 `audio/asr-worker.mjs` 实际加载的文件直接计算。voice `.onnx` 的哈希与上游 HuggingFace 对该 LFS 对象返回的 `X-Linked-Etag` **逐字符相同**，即已对上游完成校验；对应 HF 提交为 `c10ece1aade47bb51c153c893d14e5bf8e5b7117`。

### 下载归档（供复核）

| 归档                                                         |       字节 | SHA-256                                                            |
| ------------------------------------------------------------ | ---------: | ------------------------------------------------------------------ |
| `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2` | 1047870769 | `f6b2a72ebcb1ac7a764d4cfccd886e6bcb2a95c4657c2199d0ba95ed4b9ea71a` |
| `piper_windows_amd64.zip`                                    |   22477236 | `f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea` |

两个归档的字节数与上游 `Content-Range` 声明完全一致。**归档本身未保留在本机**（磁盘考虑，约 1.1 GB）；上表哈希来自两次独立下载各自复算并互相吻合的结果，且第二次下载重新解包所得的 `model.int8.onnx` 与 `tokens.txt` 与已安装文件哈希逐字符一致。SenseVoice 归档解包后仅安装 `model.int8.onnx` 与 `tokens.txt`（与 `asr-worker.mjs` 的加载路径一致）；同一归档内的 fp32 `model.onnx`（约 900 MB）**未安装**。

### Piper 随附二进制

| 文件                               |     字节 | SHA-256                                                            |
| ---------------------------------- | -------: | ------------------------------------------------------------------ |
| `piper.exe`                        |   509952 | `96f3da3811151580073e40bb4dd20eb0fb8115f5f5f76e2fb54282b3edfa5c1f` |
| `onnxruntime.dll`                  |  9271704 | `a630f67f4a82b6689e4178bf81d362d945522dd907b2a92cb43cebf72c83a06f` |
| `espeak-ng.dll`                    |   380928 | `9588480f8197df62fd8461a8431f8eaec6e8e7749c5ffcbe7fee656fe40a2189` |
| `piper_phonemize.dll`              |   407040 | `4b5f344b2f31204a8a94a0bf485f93e4971671e81188a0d67f326e113bfb0b2e` |
| `onnxruntime_providers_shared.dll` |    22424 | `71705b9bd76baced583eb37fe5ec2101946b4de50f1e9bdb156109f7e8082980` |
| `libtashkeel_model.ort`            | 10261536 | `9f27090af3e0f661913af048a739632a3f577b3233512551d8c90580ccad4aa8` |

## 实际使用的下载地址（本机已验证可用）

`README.md` 原记录的 Piper 地址不可用：`rhasspy/piper` 的 `v1.2.0` 只发布 `piper_amd64.tar.gz` / `piper_arm64.tar.gz` / `piper_armv7.tar.gz`（Linux），**没有 Windows 包**；`piper_windows_amd64.zip` 位于标签 `2023.11.14-2`。另外 OHF-Voice 的后续维护仓库只提供 Windows Python wheel，没有独立 `piper.exe`。

本机直连 `github.com` 与 `huggingface.co` 均超时/重置，因此走镜像前缀。可复核的原始地址：

1. SenseVoiceSmall — `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2`，实际经 `https://ghfast.top/` 前缀获取。
2. Piper 运行时 — `https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip`，同样经 `https://ghfast.top/` 前缀获取。
3. Piper voice — `https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx` 及同名 `.onnx.json`，实际经 `https://hf-mirror.com/` 获取。

镜像前缀只改变传输路径，不改变归档的字节内容；上表的归档 SHA-256 是本机独立计算值，`.onnx` 还与上游 LFS etag 交叉核对通过。

## 许可证

- **sherpa-onnx npm 包**：Apache-2.0（`node_modules/sherpa-onnx/package.json`）。
- **SenseVoiceSmall 权重**：**不是** Apache-2.0。归档内 `LICENSE` 仅为 71 字节指针，指向 FunASR；对应条款为 **FunASR Model Open Source License Agreement v1.1**（Copyright Alibaba Group）。§2.1 允许使用、复制、修改与分享，§2.2 要求**署名来源与作者信息并保留模型名称**，§3 声明"仅供参考与学习"。对外分发或商用前需按此条款保留署名与模型名。
- **Piper 运行时**：`rhasspy/piper` 为 MIT（Copyright 2022 Michael Hansen）。但该 Windows 包同时附带 **espeak-ng**（`espeak-ng.dll`、`espeak-ng-data/`），espeak-ng 为 **GPL-3.0**；再分发该目录时需一并履行 GPL-3.0 义务。zip 内**未附带**任何 license/notice 文件。
- **`zh_CN-huayan-medium` voice**：`rhasspy/piper-voices` 仓库级许可为 MIT，但该 voice 的 `MODEL_CARD` 明确记录其数据集 `PlayVoice/HuaYan_TTS` 的 `License: Unknown`，且由英语 lessac voice 微调而来。**因此仍不能宣称该 voice 可自由再分发或已锁定许可**；此前的这一保留意见经核实后继续成立。

## 验收记录

验收使用与 `audio/bridge.mjs` 相同的代码路径，不是模拟引擎。

**已通过**

| 项目            | 方式                                              | 结果                                                                                                                                                                               |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Piper 合成      | 8 条中文句子经 `piper.exe --model … --output_raw` | 8/8 成功；非静音；实测 RTF ≈ 0.05；原生 22050 Hz → 16 kHz 重采样与 `bridge.mjs` 逻辑逐样本一致                                                                                     |
| SenseVoice 识别 | 归档自带 `test_wavs/{zh,en,ja,ko,yue}.wav`        | 5/5 正确，如 `zh.wav` → `开放时间早上9点至下午5点。`（真实人声录音）                                                                                                               |
| TTS→ASR 闭环    | 合成音频回灌识别                                  | 8/8 出文本，平均字错率 10.7%（含同音替换；此为合成音，不等同人声麦克风验收）                                                                                                       |
| 真实 bridge     | 启动 `audio/bridge.mjs` 并按协议对接              | 25/25 项通过：无 token 403、HttpOnly cookie、CSP、五个静态资源、WS 错误 Origin/token 拒绝、`speak` 返回 16 kHz 非静音 PCM、`speech_start`/`speech_end` 出转写、过期 epoch 段被丢弃 |
| 音频设备        | 系统枚举                                          | 存在真实采集端点（`阵列麦克风 (AMD Audio Device)`、`阵列麦克风 (OMEN Cam & Voice)`）与播放端点                                                                                     |

**未完成**

- **真实麦克风与播放验收尚未通过。** 首次采集确有信号（RMS 23.9 / 峰值 374），但随后所有采集（两个阵列麦克风、多次重试）均返回**纯数字静音**（RMS 0.1 / 峰值 1）。Windows 全局麦克风权限为 `Allow`，`ffmpeg.exe` 也在授权列表内，故不是隐私开关问题——更可能是硬件/端点静音或输入电平被拉到 0。需要人工检查麦克风静音键与输入电平后重测。
- 因此 `spec.md` 的 **G2（实际麦克风 ≥30 条中文任务）** 与 **G5（30 次插话 + 10 分钟播报）** 仍未执行；扬声器链路本身也未被声学回环验证。
- 未经测试：CPU/内存占用、端到端延迟、首字延迟。

### 已修复缺陷

`audio/asr-worker.mjs` 原为 `numThreads: 2`。在 Node 22.23.2 上，sherpa-onnx 1.12.17 的 nodejs WASM 构建在 `numThreads` 为 2 或 4 时解码阶段抛出未捕获异常（`Aborted()` / 整数异常码），`numThreads: 1` 正常。已最小化修改为 `1`。这意味着即使模型文件齐备，原配置下 ASR 也无法工作。代价是解码并行度下降；`2` 与 `4` 均不可用，故当前无更优取值。

模型文件不可凭本说明推定为已通过真实麦克风中文实测；见上方「未完成」。
