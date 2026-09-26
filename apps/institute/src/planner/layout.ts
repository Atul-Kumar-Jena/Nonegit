import type { PlannerItem } from '@attendly/protocol';

/** Side-by-side lanes for classes that overlap within one day. */
export function layoutDay(items: readonly Pick<PlannerItem, 'key' | 'start' | 'end'>[]): Map<string, { lane: number; lanes: number }> {
  const sorted = [...items].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const out = new Map<string, { lane: number; lanes: number }>();
  let cluster: Pick<PlannerItem, 'key' | 'start' | 'end'>[] = [];
  let clusterEnd = '';
  let laneEnds: string[] = [];
  const flush = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const it of cluster) out.set(it.key, { lane: out.get(it.key)!.lane, lanes });
    cluster = [];
    laneEnds = [];
    clusterEnd = '';
  };
  for (const it of sorted) {
    if (cluster.length && it.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((e) => e <= it.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = it.end;
    out.set(it.key, { lane, lanes: 1 });
    cluster.push(it);
    if (it.end > clusterEnd) clusterEnd = it.end;
  }
  if (cluster.length) flush();
  return out;
}

