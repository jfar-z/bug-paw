import type { FastifyInstance } from "fastify";
import type { WhisperClient } from "../asr/whisper-client";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

interface SpeechRouteDependencies {
  authService: AuthService;
  whisper: Pick<WhisperClient, "transcribe">;
}

/** 注册浏览器录音上传与本机 Whisper 转写接口。 */
export function registerSpeechRoutes(app: FastifyInstance, dependencies: SpeechRouteDependencies): void {
  app.post("/api/speech/transcriptions", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) {
      return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传录音");
    }

    try {
      const part = await request.file({ limits: { files: 1, fileSize: MAX_AUDIO_BYTES } });
      if (!part || part.fieldname !== "audio") {
        return sendApiError(reply, 400, "EMPTY_UPLOAD", "请选择需要转写的录音");
      }
      if (!part.mimetype.startsWith("audio/")) {
        return sendApiError(reply, 415, "VALIDATION_FAILED", "仅支持音频录音");
      }
      const audio = await part.toBuffer();
      if (!audio.length) return sendApiError(reply, 400, "EMPTY_UPLOAD", "录音内容为空");

      const result = await dependencies.whisper.transcribe(audio, part.filename, part.mimetype);
      return reply.header("Cache-Control", "no-store").send(result);
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return sendApiError(reply, 413, "ATTACHMENT_TOO_LARGE", "录音不能超过 25 MiB");
      }
      request.log.error({ err: error }, "Whisper transcription failed");
      return sendApiError(reply, 502, "MODEL_RUNTIME_UNAVAILABLE", "本机语音识别暂时不可用，请稍后重试");
    }
  });
}
