import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

export function getFfmpegExecutable() {
  return process.env.FFMPEG_PATH?.trim() || ffmpegStaticPath || "ffmpeg";
}

export function getFfprobeExecutable() {
  return process.env.FFPROBE_PATH?.trim() || ffprobeStatic.path || "ffprobe";
}
