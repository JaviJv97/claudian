import { Notice, setIcon } from 'obsidian';

import { autoResizeTextarea } from '../ui/textareaResize';
import { LocalWhisperTranscriber } from './LocalWhisperTranscriber';

const MAX_RECORDING_MS = 120_000;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

type VoiceInputState = 'idle' | 'requesting' | 'recording' | 'transcribing';

export interface VoiceInputControllerOptions {
  mediaDevices?: MediaDevices;
  mediaRecorderFactory?: (stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder;
  transcriber?: Pick<LocalWhisperTranscriber, 'transcribe'>;
  maxRecordingMs?: number;
  maxAudioBytes?: number;
}

export class VoiceInputController {
  private readonly buttonEl: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly mediaDevices: MediaDevices | undefined;
  private readonly mediaRecorderFactory: (stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder;
  private readonly transcriber: Pick<LocalWhisperTranscriber, 'transcribe'>;
  private readonly maxRecordingMs: number;
  private readonly maxAudioBytes: number;
  private state: VoiceInputState = 'idle';
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private audioBytes = 0;
  private limitTimer: number | null = null;
  private transcriptionAbort: AbortController | null = null;
  private operationGeneration = 0;
  private destroyed = false;

  constructor(
    parentEl: HTMLElement,
    private readonly inputEl: HTMLTextAreaElement,
    options: VoiceInputControllerOptions = {},
  ) {
    this.mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
    this.mediaRecorderFactory = options.mediaRecorderFactory
      ?? ((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions));
    this.transcriber = options.transcriber ?? new LocalWhisperTranscriber();
    this.maxRecordingMs = options.maxRecordingMs ?? MAX_RECORDING_MS;
    this.maxAudioBytes = options.maxAudioBytes ?? MAX_AUDIO_BYTES;

    const container = parentEl.createDiv({ cls: 'claudian-voice-input' });
    this.statusEl = container.createSpan({
      cls: 'claudian-voice-input-status',
      attr: { 'aria-live': 'polite' },
    });
    this.buttonEl = container.createEl('button', {
      cls: 'claudian-voice-input-btn',
      attr: {
        'aria-label': 'Start voice input',
        title: 'Speak a prompt',
        type: 'button',
      },
    });
    setIcon(this.buttonEl, 'mic');
    this.buttonEl.addEventListener('click', this.handleClick);
  }

  private readonly handleClick = () => {
    if (this.state === 'idle') {
      void this.start();
    } else if (this.state === 'recording') {
      this.stop();
    } else {
      this.cancel();
    }
  };

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.buttonEl.removeClass('is-recording', 'is-transcribing');
    if (state === 'requesting') {
      this.buttonEl.addClass('is-transcribing');
      this.buttonEl.setAttribute('aria-label', 'Cancel microphone request');
      this.buttonEl.setAttribute('title', 'Cancel microphone request');
      this.statusEl.setText('Opening microphone…');
      setIcon(this.buttonEl, 'loader-circle');
    } else if (state === 'recording') {
      this.buttonEl.addClass('is-recording');
      this.buttonEl.setAttribute('aria-label', 'Stop recording and transcribe');
      this.buttonEl.setAttribute('title', 'Stop and transcribe');
      this.statusEl.setText('Recording…');
      setIcon(this.buttonEl, 'square');
    } else if (state === 'transcribing') {
      this.buttonEl.addClass('is-transcribing');
      this.buttonEl.setAttribute('aria-label', 'Cancel transcription');
      this.buttonEl.setAttribute('title', 'Cancel transcription');
      this.statusEl.setText('Transcribing…');
      setIcon(this.buttonEl, 'loader-circle');
    } else {
      this.buttonEl.setAttribute('aria-label', 'Start voice input');
      this.buttonEl.setAttribute('title', 'Speak a prompt');
      this.statusEl.setText('');
      setIcon(this.buttonEl, 'mic');
    }
  }

  async start(): Promise<void> {
    if (this.state !== 'idle' || this.destroyed) return;
    if (!this.mediaDevices?.getUserMedia) {
      new Notice('Microphone access is unavailable in this Obsidian session.');
      return;
    }

    const generation = ++this.operationGeneration;
    this.setState('requesting');
    try {
      const stream = await this.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (this.destroyed || generation !== this.operationGeneration) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      this.chunks = [];
      this.audioBytes = 0;
      const preferredMime = typeof MediaRecorder !== 'undefined'
        && MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined;
      this.recorder = this.mediaRecorderFactory(
        this.stream,
        preferredMime ? { mimeType: preferredMime } : undefined,
      );
      this.recorder.addEventListener('dataavailable', this.handleData);
      this.recorder.addEventListener('stop', this.handleStop, { once: true });
      this.recorder.start(250);
      this.setState('recording');
      this.limitTimer = window.setTimeout(() => this.stop(), this.maxRecordingMs);
    } catch {
      this.releaseStream();
      if (!this.destroyed && generation === this.operationGeneration) {
        this.setState('idle');
        new Notice('Could not access the microphone. Check Obsidian microphone permission.');
      }
    }
  }

  stop(): void {
    if (this.state !== 'recording' || !this.recorder) return;
    this.clearLimitTimer();
    this.setState('transcribing');
    this.recorder.stop();
  }

  private readonly handleData = (event: BlobEvent) => {
    if (
      event.data.size === 0
      || (this.state !== 'recording' && this.state !== 'transcribing')
    ) return;
    this.audioBytes += event.data.size;
    if (this.audioBytes > this.maxAudioBytes) {
      this.discardRecording();
      new Notice('Voice recording stopped because it exceeded the audio memory limit.');
      return;
    }
    this.chunks.push(event.data);
  };

  private readonly handleStop = () => {
    if (this.state !== 'transcribing') {
      this.releaseRecordingData();
      return;
    }
    const generation = this.operationGeneration;
    const mimeType = this.recorder?.mimeType || 'audio/webm';
    const audio = new Blob(this.chunks, { type: mimeType });
    this.releaseRecordingData();
    void this.transcribe(audio, generation);
  };

  private async transcribe(audio: Blob, generation: number): Promise<void> {
    if (
      this.destroyed
      || generation !== this.operationGeneration
      || audio.size === 0
    ) {
      this.setState('idle');
      return;
    }
    this.transcriptionAbort = new AbortController();
    try {
      const transcript = await this.transcriber.transcribe(
        audio,
        this.transcriptionAbort.signal,
      );
      if (
        this.destroyed
        || generation !== this.operationGeneration
        || this.transcriptionAbort.signal.aborted
        || !transcript
      ) return;
      const separator = this.inputEl.value && !/\s$/.test(this.inputEl.value) ? ' ' : '';
      this.inputEl.value += `${separator}${transcript}`;
      this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      autoResizeTextarea(this.inputEl);
      this.inputEl.focus();
    } catch (error) {
      if (!this.transcriptionAbort.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Unknown transcription error';
        new Notice(`Voice transcription failed: ${message}`);
      }
    } finally {
      this.transcriptionAbort = null;
      if (!this.destroyed && generation === this.operationGeneration) this.setState('idle');
    }
  }

  cancel(): void {
    if (this.state === 'idle') return;
    ++this.operationGeneration;
    this.clearLimitTimer();
    this.transcriptionAbort?.abort();
    if (this.recorder?.state === 'recording') {
      this.discardRecording();
    } else {
      this.releaseStream();
      this.setState('idle');
    }
  }

  private clearLimitTimer(): void {
    if (this.limitTimer === null) return;
    window.clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }

  private releaseStream(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private releaseRecordingData(): void {
    this.releaseStream();
    this.recorder = null;
    this.chunks = [];
    this.audioBytes = 0;
  }

  private discardRecording(): void {
    this.clearLimitTimer();
    const recorder = this.recorder;
    this.setState('idle');
    if (recorder?.state === 'recording') recorder.stop();
    this.releaseRecordingData();
  }

  destroy(): void {
    this.destroyed = true;
    ++this.operationGeneration;
    this.clearLimitTimer();
    this.transcriptionAbort?.abort();
    if (this.recorder?.state === 'recording') {
      this.recorder.stop();
    }
    this.releaseRecordingData();
    this.buttonEl.removeEventListener('click', this.handleClick);
  }
}
