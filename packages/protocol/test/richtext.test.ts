import { describe, expect, it } from 'vitest';
import { parseInline, parseRich, richToPlain } from '../src/richtext';

describe('notice formatting', () => {
  it('bold, italic, strike, code, nested', () => {
    expect(parseInline('Hi **all** and *you*, ~~no~~ `x=1` **bold *both***')).toEqual([
      { text: 'Hi ' },
      { text: 'all', b: true },
      { text: ' and ' },
      { text: 'you', i: true },
      { text: ', ' },
      { text: 'no', s: true },
      { text: ' ' },
      { text: 'x=1', code: true },
      { text: ' ' },
      { text: 'bold ', b: true },
      { text: 'both', b: true, i: true },
    ]);
  });

  it('links: [text](url), bare URLs without trailing punctuation, never javascript:', () => {
    expect(parseInline('See [the form](https://x.edu/f) or https://x.edu/g.')).toEqual([
      { text: 'See ' },
      { text: 'the form', href: 'https://x.edu/f' },
      { text: ' or ' },
      { text: 'https://x.edu/g', href: 'https://x.edu/g' },
      { text: '.' },
    ]);
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ text: '[click](javascript:alert(1))' }]);
  });

  it('unclosed markers and snake_case stay as text; backslash escapes', () => {
    expect(parseInline('2 * 3 = 6, file_name_here, \\*not italic\\*')).toEqual([{ text: '2 * 3 = 6, file_name_here, *not italic*' }]);
  });

  it('blocks: headings, lists, quote, divider, gaps', () => {
    const b = parseRich('# Exam week\n\nBring:\n- ID card\n- **Hall ticket**\n1. Reach by 9\n2) Sit by roll no.\n> Good luck!\n---\n\n\n');
    expect(b.map((x) => x.type)).toEqual(['h1', 'gap', 'p', 'li', 'li', 'ol', 'ol', 'quote', 'hr']);
    expect(b[5]).toMatchObject({ type: 'ol', n: 1 });
    expect(b[4]).toMatchObject({ inlines: [{ text: 'Hall ticket', b: true }] });
  });

  it('plain preview for notifications', () => {
    expect(richToPlain('# Holiday\nCollege is **closed** on Friday.\n- Labs too')).toBe('Holiday · College is closed on Friday. · • Labs too');
    expect(richToPlain('x'.repeat(300), 20)).toHaveLength(20);
  });
});
