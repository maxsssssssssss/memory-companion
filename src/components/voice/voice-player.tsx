"use client";

import { useEffect, useRef, useState } from "react";

type VoicePlayerProps = {
  audioBase64: string;
  mimeType?: string;
  onPlaying: () => void;
  onEnded: () => void;
  onError: () => void;
  onAutoplayBlocked?: () => void;
};

const ignoreAutoplayBlock = () => undefined;

function decodeBase64Audio(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function VoicePlayer({
  audioBase64,
  mimeType = "audio/wav",
  onPlaying,
  onEnded,
  onError,
  onAutoplayBlocked = ignoreAutoplayBlock
}: VoicePlayerProps) {
  const playerRef = useRef<HTMLAudioElement>(null);
  const [sourceUrl, setSourceUrl] = useState<string>();

  useEffect(() => {
    let objectUrl: string | undefined;
    const player = playerRef.current;
    try {
      const audio = decodeBase64Audio(audioBase64);
      objectUrl = URL.createObjectURL(new Blob([audio], { type: mimeType }));
      setSourceUrl(objectUrl);
    } catch {
      onError();
    }

    return () => {
      player?.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [audioBase64, mimeType, onError]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !sourceUrl) return;

    void player.play().catch(onAutoplayBlocked);
  }, [onAutoplayBlocked, sourceUrl]);

  return (
    <audio
      ref={playerRef}
      className="voice-qa-player"
      aria-label="AI 语音回答"
      src={sourceUrl}
      controls
      onPlay={onPlaying}
      onEnded={onEnded}
      onError={onError}
    />
  );
}
