import { LocalWhisperTranscriber } from '@/features/chat/voice/LocalWhisperTranscriber';

describe('LocalWhisperTranscriber', () => {
  it('reports a missing model before creating a transcription process', async () => {
    const transcriber = new LocalWhisperTranscriber({
      modelPath: '/definitely/missing/claudian-whisper-model.bin',
    });

    await expect(transcriber.transcribe(new Blob(['audio']))).rejects.toThrow(
      'Whisper model not found',
    );
  });

  it('does not begin work for an already-cancelled request', async () => {
    const abort = new AbortController();
    abort.abort();
    const transcriber = new LocalWhisperTranscriber({
      modelPath: '/definitely/missing/claudian-whisper-model.bin',
    });

    await expect(transcriber.transcribe(new Blob(['audio']), abort.signal)).rejects.toThrow(
      'Voice transcription cancelled',
    );
  });
});
