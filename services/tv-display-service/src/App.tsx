import { useMemo } from 'react';
import { Routes, Route } from 'react-router-dom';
import { TvApi } from './api/tv-api';
import type { ITvApi } from './api/tv-api';
import { SequencerAudioProvider } from './audio/sequencer-audio-provider';
import type { AudioProvider } from './audio/audio-provider';
import { TvStoreProvider } from './state/tv-store';
import { TvBoardPage } from './pages/TvBoardPage';

/**
 * The TV board is a single full-screen route. The {@link TvStoreProvider} owns
 * the realtime socket + the audio sequencer; {@link TvBoardPage} just projects
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
  const audioProvider = useMemo(() => audio ?? new SequencerAudioProvider(), [audio]);

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