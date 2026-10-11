import { useEffect } from 'react';
import { useNexus } from '../store/useNexus';
import { ensureDossier, ensureEgo, ensureEntity } from './api';

/**
 * 在线模式下，让当前选中/聚焦/档案涉及的实体与关系总是已加载：
 * 订阅 store，任何状态变化时检查并按需拉取（已加载的键会被跳过，代价很小）。
 * 家族视图（深度是视图内部状态）与路径视图自行调用 api。
 */
export function useRemoteSync() {
  useEffect(() => {
    const run = () => {
      const s = useNexus.getState();
      if (!s.online || !s.data) return;
      if (s.selected) void ensureEntity(s.selected);
      if (s.scope.kind === 'ego') void ensureEgo(s.scope.id, s.scope.depth);
      if (s.scope.kind === 'dossier') void ensureDossier(s.scope.id);
      if (s.familyTarget?.kind === 'dossier') void ensureDossier(s.familyTarget.id);
    };
    run();
    return useNexus.subscribe(run);
  }, []);
}
