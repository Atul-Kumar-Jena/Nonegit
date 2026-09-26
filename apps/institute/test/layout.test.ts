import { describe, expect, it } from 'vitest';
import { layoutDay } from '../src/planner/layout';

const it_ = (key: string, start: string, end: string) => ({ key, start, end });

describe('board lanes', () => {
  it('puts overlapping classes side by side and leaves others full width', () => {
    const m = layoutDay([it_('a', '09:00', '10:00'), it_('b', '09:30', '10:30'), it_('c', '10:00', '11:00'), it_('d', '12:00', '13:00')]);
    expect(m.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(m.get('b')).toEqual({ lane: 1, lanes: 2 });
    expect(m.get('c')).toEqual({ lane: 0, lanes: 2 }); // reuses a's lane once a has ended
    expect(m.get('d')).toEqual({ lane: 0, lanes: 1 });
  });

  it('back-to-back classes never share a cluster', () => {
    const m = layoutDay([it_('a', '09:00', '10:00'), it_('b', '10:00', '11:00')]);
    expect(m.get('a')).toEqual({ lane: 0, lanes: 1 });
    expect(m.get('b')).toEqual({ lane: 0, lanes: 1 });
  });
});
