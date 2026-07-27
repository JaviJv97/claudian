import {
  type ChildProcessByStdio,
  spawn,
} from 'child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 2_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;

export const DEFAULT_WHISPER_MODEL_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'claudian',
  'whisper',
  'ggml-base.en.bin',
);

export interface LocalWhisperTranscriberOptions {
  ffmpegPath?: string;
  whisperPath?: string;
  modelPath?: string;
  tempRoot?: string;
  threads?: number;
  processTimeoutMs?: number;
}

function runProcess(
  executable: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let requestedError: Error | undefined;
    let stdout = '';
    let stderr = '';
    let killTimer: number | undefined;
    let child: ChildProcessByStdio<null, Readable, Readable>;

    try {
      child = spawn(executable, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (killTimer) window.clearTimeout(killTimer);
      window.clearTimeout(timeoutTimer);
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    };
    const terminate = (error: Error) => {
      if (settled || requestedError) return;
      requestedError = error;
      child.kill('SIGTERM');
      killTimer = window.setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, PROCESS_KILL_GRACE_MS);
    };
    const abort = () => terminate(new Error('Voice transcription cancelled'));

    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
    const timeoutTimer = window.setTimeout(() => {
      terminate(new Error(`${path.basename(executable)} timed out`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > MAX_PROCESS_OUTPUT_BYTES) {
        terminate(new Error('Voice transcription produced too much output'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > MAX_PROCESS_OUTPUT_BYTES) {
        stderr = stderr.slice(-MAX_PROCESS_OUTPUT_BYTES);
      }
    });
    child.on('error', error => {
      const message = 'code' in error && error.code === 'ENOENT'
        ? `${executable} was not found. Install it or configure its executable path.`
        : error.message;
      finish(new Error(message));
    });
    child.on('close', code => {
      if (settled) return;
      if (requestedError) {
        finish(requestedError);
        return;
      }
      if (code !== 0) {
        finish(new Error(stderr.trim() || `${path.basename(executable)} exited with code ${code}`));
        return;
      }
      finish();
    });
  });
}

export class LocalWhisperTranscriber {
  private static active = false;
  private readonly options: Required<LocalWhisperTranscriberOptions>;

  constructor(options: LocalWhisperTranscriberOptions = {}) {
    this.options = {
      ffmpegPath: options.ffmpegPath ?? 'ffmpeg',
      whisperPath: options.whisperPath ?? 'whisper-cli',
      modelPath: options.modelPath ?? DEFAULT_WHISPER_MODEL_PATH,
      tempRoot: options.tempRoot ?? os.tmpdir(),
      threads: Math.max(1, Math.min(options.threads ?? 4, 4)),
      processTimeoutMs: Math.max(10_000, options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS),
    };
  }

  async transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
    if (LocalWhisperTranscriber.active) {
      throw new Error('Another local voice transcription is already running.');
    }
    LocalWhisperTranscriber.active = true;
    try {
      return await this.transcribeExclusive(audio, signal);
    } finally {
      LocalWhisperTranscriber.active = false;
    }
  }

  private async transcribeExclusive(audio: Blob, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Voice transcription cancelled');
    try {
      await access(this.options.modelPath);
    } catch {
      throw new Error(
        `Whisper model not found at ${this.options.modelPath}.`,
      );
    }

    const tempDir = await mkdtemp(path.join(this.options.tempRoot, 'claudian-voice-'));
    const inputPath = path.join(tempDir, 'recording.webm');
    const wavPath = path.join(tempDir, 'recording.wav');
    const outputBase = path.join(tempDir, 'transcript');

    try {
      await writeFile(inputPath, Buffer.from(await audio.arrayBuffer()));
      await runProcess(this.options.ffmpegPath, [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        wavPath,
      ], signal, this.options.processTimeoutMs);
      await runProcess(this.options.whisperPath, [
        '-m',
        this.options.modelPath,
        '-f',
        wavPath,
        '-l',
        'en',
        '-t',
        String(this.options.threads),
        '-nt',
        '-np',
        '-otxt',
        '-of',
        outputBase,
      ], signal, this.options.processTimeoutMs);
      return (await readFile(`${outputBase}.txt`, 'utf8')).trim();
    } finally {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
    }
  }
}
