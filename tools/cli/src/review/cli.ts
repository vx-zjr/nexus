/**
 * ctos review <子命令>
 *   gen <source> [--persons-only] [--max-amb 25] [--max-per 30]   生成候选（需要仓库可写）
 *   list <source> [--status pending|same|different|unsure|decided|all] [--q 名字] [--entity id] [--limit 20]
 *   decide <source> <entity-id> <ext-id> <same|different|unsure> [--note 说明]
 *   stats                                                        各来源进度
 */
import { openWarehouse } from '../warehouse/db.ts';
import { generateCandidates } from './gen.ts';
import { queryCandidates, reviewStats, type ReviewStatus } from './query.ts';
import { REVIEW_SOURCES } from './sources.ts';
import { DECISIONS, saveDecision, type Decision } from './store.ts';

export async function runReview(argv: string[], log: (m: string) => void) {
  const [sub, ...rest] = argv;
  const flag = (k: string) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--persons-only'));
  switch (sub) {
    case 'gen': {
      const source = pos[0];
      if (!source) throw new Error(`用法：ctos review gen <${Object.keys(REVIEW_SOURCES).join('|')}>`);
      await generateCandidates(source, {
        log,
        personsOnly: rest.includes('--persons-only'),
        maxAmbiguous: flag('--max-amb') ? Number(flag('--max-amb')) : undefined,
        maxPerEntity: flag('--max-per') ? Number(flag('--max-per')) : undefined,
      });
      return;
    }
    case 'list': {
      const wh = await openWarehouse({ readOnly: true });
      try {
        const { total, items } = await queryCandidates(wh.conn, {
          source: pos[0] ?? 'icij',
          status: (flag('--status') as ReviewStatus | undefined) ?? 'pending',
          q: flag('--q'),
          entity: flag('--entity'),
          limit: Number(flag('--limit') ?? 20),
          offset: Number(flag('--offset') ?? 0),
        });
        log(`共 ${total} 条`);
        let last = '';
        for (const c of items) {
          if (c.entity_id !== last) log(`\n■ ${c.entity_name}  \x1b[2m${c.entity_id} T${c.entity_tier}\x1b[0m`);
          last = c.entity_id;
          const d = c.decision ? ` [${c.decision.decision}]` : '';
          log(`  ${c.rank.toFixed(3)} ${c.ext_id.padEnd(10)} ${c.ext_name} \x1b[2m${c.ext_kind} ${c.ext_countries.join(',')} · ${c.ext_dataset ?? ''} · nk=${c.nk_score ?? '-'} 歧义=${c.ambiguity}\x1b[0m${d}`);
          for (const x of (c.context ?? []).slice(0, 6)) log(`      ${x.dir === 'out' ? '→' : '←'} ${x.link}: ${x.name} \x1b[2m${x.kind ?? ''} ${x.detail ?? ''} · ${x.dataset ?? ''}\x1b[0m`);
          if ((c.context?.length ?? 0) > 6) log(`      … 另 ${c.context!.length - 6} 条`);
        }
      } finally {
        wh.close();
      }
      return;
    }
    case 'decide': {
      const [source, entity, ext, decision] = pos;
      if (!source || !entity || !ext || !DECISIONS.includes(decision as Decision)) {
        throw new Error(`用法：ctos review decide <source> <entity-id> <ext-id> <${DECISIONS.join('|')}> [--note 说明]`);
      }
      saveDecision(source, { entity, ext, decision: decision as Decision, note: flag('--note'), by: 'cli' });
      log(`已记录：${source} ${entity} ↔ ${ext} = ${decision}（data/curated/_matches/${source}.yaml）`);
      return;
    }
    case 'stats': {
      const wh = await openWarehouse({ readOnly: true });
      try {
        for (const s of await reviewStats(wh.conn)) {
          log(`${s.source.padEnd(10)} 候选 ${s.total}（实体 ${s.entities}） 待审 ${s.pending}（高置信 ${s.pendingHigh}） 同一 ${s.same} 不同 ${s.different} 存疑 ${s.unsure}`);
        }
      } finally {
        wh.close();
      }
      return;
    }
    default:
      log('用法：ctos review <gen|list|decide|stats>   见 tools/cli/src/review/cli.ts');
  }
}
