import type { AudioQueueItem } from './audio-queue-item';

/**
 * Abstraction over the audio playback backend (OCP — PRD §3.2). New providers
 * (pre-recorded MP3 set, offline TTS engine) can be added behind this interface
 * without changing any use case that depends on it. The tv-display-service
 * supplies the concrete implementation at runtime; the core domain and use
 * cases depend only on this contract.
 */
export interface AudioProvider {
  readonly name: string;
  /** Enqueue an announcement for sequential, non-overlapping playback. */
  enqueue(item: AudioQueueItem): void;
  /** Whether the playback queue is currently empty. */
  isIdle(): boolean;
}