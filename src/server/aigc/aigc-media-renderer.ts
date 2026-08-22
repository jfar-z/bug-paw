import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import type { AigcMediaClipKind, AigcMediaProjectKind } from "../../shared/aigc-media-editor-contracts";

const PROCESS_OUTPUT_LIMIT = 64 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 90 * 60_000;

/** FFprobe 返回的渲染必需元数据。 */
export interface AigcMediaProbeResult {
  durationMs: number;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

/** 已解析到受控本地路径的渲染片段。 */
export interface AigcResolvedMediaClip {
  path: string;
  kind: AigcMediaClipKind;
  trimStartMs: number;
  durationMs: number;
  muted: boolean;
  hasAudio: boolean;
}

/** 媒体渲染请求。 */
export interface AigcMediaRenderRequest {
  kind: AigcMediaProjectKind;
  clips: AigcResolvedMediaClip[];
  outputPath: string;
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
}

/** 使用受限 FFprobe 与 FFmpeg 探测并渲染媒体。 */
export class AigcMediaRenderer {
  /** 读取媒体时长、画面尺寸和音轨存在性。 */
  async probe(path: string): Promise<AigcMediaProbeResult> {
    const output = await runProcess("/usr/bin/prlimit", [
      "--as=536870912",
      "--cpu=30",
      "--nofile=64",
      "--",
      "/usr/bin/ffprobe",
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json",
      path,
    ], PROBE_TIMEOUT_MS);
    return parseProbeOutput(output);
  }

  /** 以单线程、低优先级进程渲染一个工程。 */
  async render(request: AigcMediaRenderRequest): Promise<number> {
    const totalDurationMs = request.clips.reduce((total, clip) => total + clip.durationMs, 0);
    const arguments_ = buildFfmpegArguments(request);
    await runProgressProcess(arguments_, request.signal, totalDurationMs, request.onProgress);
    return (await stat(request.outputPath)).size;
  }
}

/** 将 FFprobe JSON 严格收敛为有限媒体元数据。 */
export function parseProbeOutput(value: string): AigcMediaProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("媒体元数据无法解析");
  }
  if (!isRecord(parsed) || !isRecord(parsed.format) || !Array.isArray(parsed.streams)) {
    throw new TypeError("媒体元数据格式无效");
  }
  const seconds = Number(parsed.format.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError("媒体时长无效");
  const videoStream = parsed.streams.find((stream) => isRecord(stream) && stream.codec_type === "video");
  const width = videoStream && Number(videoStream.width);
  const height = videoStream && Number(videoStream.height);
  return {
    durationMs: Math.max(1, Math.round(seconds * 1000)),
    hasAudio: parsed.streams.some((stream) => isRecord(stream) && stream.codec_type === "audio"),
    ...(Number.isInteger(width) && width > 0 ? { width } : {}),
    ...(Number.isInteger(height) && height > 0 ? { height } : {}),
  };
}

/** 构建不经过 shell 的 FFmpeg 参数，并为静音片段显式补齐音轨。 */
export function buildFfmpegArguments(request: Pick<AigcMediaRenderRequest, "kind" | "clips" | "outputPath">): string[] {
  if (!request.clips.length) throw new TypeError("时间线不能为空");
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  const mediaIndexes: number[] = [];
  const silenceIndexes: Array<number | undefined> = [];
  let inputIndex = 0;
  for (const clip of request.clips) {
    mediaIndexes.push(inputIndex++);
    if (clip.kind === "image") {
      args.push("-loop", "1", "-t", seconds(clip.durationMs), "-i", clip.path);
    } else {
      args.push("-ss", seconds(clip.trimStartMs), "-t", seconds(clip.durationMs), "-i", clip.path);
    }
    const silent = request.kind === "video" && (clip.kind === "image" || clip.muted || !clip.hasAudio);
    if (silent) {
      silenceIndexes.push(inputIndex++);
      args.push("-f", "lavfi", "-t", seconds(clip.durationMs), "-i", "anullsrc=r=48000:cl=stereo");
    } else {
      silenceIndexes.push(undefined);
    }
  }

  const filters: string[] = [];
  if (request.kind === "audio") {
    request.clips.forEach((_clip, index) => {
      filters.push(`[${mediaIndexes[index]}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`);
    });
    filters.push(`${request.clips.map((_clip, index) => `[a${index}]`).join("")}concat=n=${request.clips.length}:v=0:a=1[outa]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[outa]", "-c:a", "libmp3lame", "-b:a", "192k");
  } else {
    request.clips.forEach((_clip, index) => {
      filters.push(`[${mediaIndexes[index]}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${index}]`);
      const audioIndex = silenceIndexes[index] ?? mediaIndexes[index];
      filters.push(`[${audioIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`);
    });
    const concatInputs = request.clips.map((_clip, index) => `[v${index}][a${index}]`).join("");
    filters.push(`${concatInputs}concat=n=${request.clips.length}:v=1:a=1[outv][outa]`);
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "[outv]", "-map", "[outa]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    );
  }
  args.push("-threads", "1", "-progress", "pipe:1", request.outputPath);
  return args;
}

/** 运行短生命周期探测进程并限制输出体积。 */
function runProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let errorText = "";
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("媒体探测超时")));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PROCESS_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("媒体探测结果过大")));
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { errorText = appendLimited(errorText, chunk); });
    child.once("error", () => finish(() => reject(new Error("媒体工具不可用"))));
    child.once("close", (code) => finish(() => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(errorText.trim() || "媒体探测失败"))));
  });
}

/** 运行唯一渲染进程并解析 FFmpeg 机器可读进度。 */
function runProgressProcess(args: string[], signal: AbortSignal, totalDurationMs: number, onProgress?: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/nice", [
      "-n", "10",
      "/usr/bin/prlimit", "--as=2147483648", "--cpu=5400", "--nofile=64", "--",
      "/usr/bin/ffmpeg", ...args,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let progressBuffer = "";
    let errorText = "";
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(() => reject(signal.reason ?? new DOMException("导出已取消", "AbortError")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("媒体导出超时")));
    }, RENDER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split("\n");
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("out_time_ms=")) continue;
        const microseconds = Number(line.slice("out_time_ms=".length));
        if (Number.isFinite(microseconds) && totalDurationMs > 0) {
          onProgress?.(Math.min(0.99, Math.max(0, microseconds / 1000 / totalDurationMs)));
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { errorText = appendLimited(errorText, chunk); });
    child.once("error", () => finish(() => reject(new Error("FFmpeg 不可用"))));
    child.once("close", (code) => finish(() => code === 0
      ? resolve()
      : reject(new Error(errorText.trim() || "媒体导出失败"))));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3);
}

function appendLimited(current: string, chunk: Buffer): string {
  return (current + chunk.toString("utf8")).slice(-PROCESS_OUTPUT_LIMIT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
