import { useEffect } from 'react';
import { readHash, useNexus, writeHash } from './store/useNexus';
import { loadGraph } from './lib/data';
import { useRemoteSync } from './lib/sync';
import { TopBar } from './components/TopBar';
import { FilterPanel } from './components/FilterPanel';
import { ProfilePanel } from './components/ProfilePanel';
import { NetworkView } from './views/NetworkView';
import { FamilyView } from './views/FamilyView';
import { PathView } from './views/PathView';
import { DataView } from './views/DataView';
import { TimelineView } from './views/TimelineView';
import { ReviewView } from './views/ReviewView';

export default function App() {
  const { loading, error, view, showLeft, showRight, data } = useNexus();
  useRemoteSync();

  useEffect(() => {
    readHash();
    void loadGraph();
    const unsub = useNexus.subscribe(writeHash);
    const onHash = () => readHash();
    window.addEventListener('hashchange', onHash);
    return () => {
      unsub();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <TopBar />
      {loading && <div className="loading-bar" />}
      <div className="flex-1 flex min-h-0">
        {showLeft && data && view === 'network' && (
          <aside className="w-56 shrink-0 border-r border-line bg-panel/80">
            <FilterPanel />
          </aside>
        )}
        <main className="flex-1 min-w-0 relative">
          {error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="panel brackets p-6 max-w-lg">
                <div className="hud-title text-red mb-2">data link error</div>
                <div className="mono text-[12px] text-ink-2">{error}</div>
              </div>
            </div>
          )}
          {loading && !error && <div className="absolute inset-0 flex items-center justify-center mono text-cyan caret">ESTABLISHING DATA LINK</div>}
          {data && view === 'network' && <NetworkView />}
          {data && view === 'family' && <FamilyView />}
          {data && view === 'path' && <PathView />}
          {data && view === 'timeline' && <TimelineView />}
          {data && view === 'review' && <ReviewView />}
          {data && view === 'data' && <DataView />}
        </main>
        {showRight && data && (
          <aside className="w-[380px] shrink-0 border-l border-line bg-panel/90">
            <ProfilePanel />
          </aside>
        )}
      </div>
    </div>
  );
}
