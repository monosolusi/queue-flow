import { useMemo } from 'react';
import { Routes, Route } from 'react-router-dom';
import { TvApi } from './api/tv-api';
import type { ITvApi } from './api/tv-api';
import { RemoteAnnouncementAudioProvider } from './audio/remote-announcement-audio-provider';
import { QueuedAudioProvider } from './audio/queued-audio-provider';
import type { AudioProvider } from './audio/audio-provider';
import { TvStoreProvider } from './state/tv-store';
import { TvBoardPage } from './pages/TvBoardPage';

/**
 * The TV board is a single full-screen route. The {@link TvStoreProvider} owns
 * the realtime socket + announcement playback; {@link TvBoardPage} just projects
 * the store. `api` and `audio` are optional props so tests can inject fakes
 * (ISP: the TV consumes only `ITvApi` + `AudioProvider`).
 */
export function App({
  api,
  audio,
  socketOptions,
}: {
  api?: ITvApi;
  audio?: AudioProvider;
  socketOptions?: import('./realtime/queue-socket').QueueSocketOptions;
} = {}) {
  const tvApi = useMemo(() => api ?? new TvApi(), [api]);
  // Wrap the remote-clip player in the announcement-level FIFO queue so
  // back-to-back TICKET_CALLED events play serially without overlap (QUE-22,
  // FR-TV-02). Tests inject a bare AudioProvider to bypass the queue.
  const audioProvider = useMemo(
    () => audio ?? new QueuedAudioProvider({ inner: new RemoteAnnouncementAudioProvider() }),
    [audio],
  );

  return (
    <Routes>
      <Route
        path="/"
        element={
          <TvStoreProvider api={tvApi} audio={audioProvider} socketOptions={socketOptions}>
            <TvBoardPage />
          </TvStoreProvider>
        }
      />
    </Routes>
  );
}