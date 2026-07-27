import { createMockEl } from '@test/helpers/mockElement';

import { VoiceInputController } from '@/features/chat/voice/VoiceInputController';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

class FakeMediaRecorder extends EventTarget {
  readonly mimeType = 'audio/webm';
  state: RecordingState = 'inactive';

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), {
      data: new Blob(['recorded audio'], { type: this.mimeType }),
    }));
    this.state = 'inactive';
    this.dispatchEvent(new Event('stop'));
  }
}

describe('VoiceInputController', () => {
  it('records, transcribes, appends, and releases the microphone', async () => {
    const track = { stop: jest.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const recorder = new FakeMediaRecorder();
    const transcriber = {
      transcribe: jest.fn().mockResolvedValue('spoken prompt'),
    };
    const input = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    input.value = 'Existing';
    const controller = new VoiceInputController(
      createMockEl(),
      input,
      {
        mediaDevices: {
          getUserMedia: jest.fn().mockResolvedValue(stream),
        } as unknown as MediaDevices,
        mediaRecorderFactory: () => recorder as unknown as MediaRecorder,
        transcriber,
      },
    );

    await controller.start();
    controller.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(transcriber.transcribe).toHaveBeenCalled();
    expect(input.value).toBe('Existing spoken prompt');
    expect(track.stop).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('aborts an active transcription when destroyed', async () => {
    let resolveTranscript!: (value: string) => void;
    const transcriber = {
      transcribe: jest.fn((_audio: Blob, signal?: AbortSignal) => (
        new Promise<string>((resolve) => {
          resolveTranscript = resolve;
          signal?.addEventListener('abort', () => resolve('ignored'));
        })
      )),
    };
    const recorder = new FakeMediaRecorder();
    const controller = new VoiceInputController(
      createMockEl(),
      createMockEl('textarea') as unknown as HTMLTextAreaElement,
      {
        mediaDevices: {
          getUserMedia: jest.fn().mockResolvedValue({
            getTracks: () => [{ stop: jest.fn() }],
          }),
        } as unknown as MediaDevices,
        mediaRecorderFactory: () => recorder as unknown as MediaRecorder,
        transcriber,
      },
    );

    await controller.start();
    controller.stop();
    await Promise.resolve();
    controller.destroy();
    resolveTranscript('ignored');
    await Promise.resolve();

    const signal = transcriber.transcribe.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(true);
  });

  it('releases microphone access that resolves after the controller is destroyed', async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const track = { stop: jest.fn() };
    const getUserMedia = jest.fn(() => new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    }));
    const controller = new VoiceInputController(
      createMockEl(),
      createMockEl('textarea') as unknown as HTMLTextAreaElement,
      {
        mediaDevices: { getUserMedia } as unknown as MediaDevices,
      },
    );

    const start = controller.start();
    controller.destroy();
    resolveStream({ getTracks: () => [track] } as unknown as MediaStream);
    await start;

    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('does not apply a transcript after cancellation even if the transcriber ignores abort', async () => {
    let resolveTranscript!: (value: string) => void;
    const input = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    const transcriber = {
      transcribe: jest.fn(() => new Promise<string>((resolve) => {
        resolveTranscript = resolve;
      })),
    };
    const recorder = new FakeMediaRecorder();
    const controller = new VoiceInputController(
      createMockEl(),
      input,
      {
        mediaDevices: {
          getUserMedia: jest.fn().mockResolvedValue({
            getTracks: () => [{ stop: jest.fn() }],
          }),
        } as unknown as MediaDevices,
        mediaRecorderFactory: () => recorder as unknown as MediaRecorder,
        transcriber,
      },
    );

    await controller.start();
    controller.stop();
    await Promise.resolve();
    controller.cancel();
    resolveTranscript('late transcript');
    await Promise.resolve();

    expect(input.value).toBe('');
    controller.destroy();
  });

  it('cancels recording when buffered audio exceeds the configured limit', async () => {
    const track = { stop: jest.fn() };
    const recorder = new FakeMediaRecorder();
    const transcriber = { transcribe: jest.fn() };
    const controller = new VoiceInputController(
      createMockEl(),
      createMockEl('textarea') as unknown as HTMLTextAreaElement,
      {
        mediaDevices: {
          getUserMedia: jest.fn().mockResolvedValue({
            getTracks: () => [track],
          }),
        } as unknown as MediaDevices,
        mediaRecorderFactory: () => recorder as unknown as MediaRecorder,
        transcriber,
        maxAudioBytes: 4,
      },
    );

    await controller.start();
    recorder.dispatchEvent(Object.assign(new Event('dataavailable'), {
      data: new Blob(['too large'], { type: recorder.mimeType }),
    }));
    await Promise.resolve();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    controller.destroy();
  });
});
