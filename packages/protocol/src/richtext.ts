/**
 * Notice formatting: a small, safe subset of Markdown — parsed the same way on every device.
 *
 *   # Heading          ## Smaller heading
 *   - bullet           1. numbered
 *   > quote            ---  (divider)
 *   **bold**  *italic*  ~~strike~~  `code`  [text](https://…)  and bare https://… links
 *
 * No HTML, no images, only http(s) links: nothing a notice can smuggle in.
 */

export interface Inline {
  text: string;
  b?: true;
  i?: true;
  s?: true;
  code?: true;
  href?: string;
}

export type Block =
  | { type: 'p' | 'h1' | 'h2' | 'quote'; inlines: Inline[] }
  | { type: 'li'; inlines: Inline[] }
  | { type: 'ol'; n: number; inlines: Inline[] }
  | { type: 'hr' }
  | { type: 'gap' };

const SAFE_URL = /^https?:\/\/[^\s<>"'`]+$/i;

function trimUrl(u: string): string {
  // "see https://x.y/z." → the full stop belongs to the sentence.
  return u.replace(/[.,;:!?)\]]+$/, '');
}

/** Inline markup → styled runs. Unclosed markers are kept as plain text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const push = (text: string, style: Omit<Inline, 'text'> = {}) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...style, text: '' })) last.text += text;
    else out.push({ text, ...style });
  };
  const walk = (s: string, style: Omit<Inline, 'text'>) => {
    let i = 0;
    let plain = '';
    const flush = () => {
      if (!plain) return;
      // bare links inside plain text
      let rest = plain;
      const re = /https?:\/\/[^\s<>"'`]+/i;
      for (let m = re.exec(rest); m; m = re.exec(rest)) {
        const url = trimUrl(m[0]);
        push(rest.slice(0, m.index), style);
        push(url, { ...style, href: url });
        rest = rest.slice(m.index + url.length);
      }
      push(rest, style);
      plain = '';
    };
    while (i < s.length) {
      const c = s[i]!;
      const two = s.slice(i, i + 2);
      if (c === '\\' && i + 1 < s.length && '*_~`[]\\#>-'.includes(s[i + 1]!)) {
        plain += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '`' && !style.code) {
        const end = s.indexOf('`', i + 1);
        if (end > i + 1) {
          flush();
          push(s.slice(i + 1, end), { ...style, code: true });
          i = end + 1;
          continue;
        }
      }
      if ((two === '**' || two === '~~') && !style.code) {
        let end = s.indexOf(two, i + 2);
        // "**bold *italic***": the closing ** is the last two of the three stars.
        while (end > 0 && s[end + 2] === two[0]) end++;
        if (end > i + 2) {
          flush();
          walk(s.slice(i + 2, end), two === '**' ? { ...style, b: true } : { ...style, s: true });
          i = end + 2;
          continue;
        }
      }
      if ((c === '*' || c === '_') && two !== '**' && !style.code) {
        const end = s.indexOf(c, i + 1);
        // _italic_ must not start inside a word (snake_case stays as is)
        const wordBefore = c === '_' && i > 0 && /\w/.test(s[i - 1]!);
        if (end > i + 1 && !wordBefore && s[i + 1] !== ' ') {
          flush();
          walk(s.slice(i + 1, end), { ...style, i: true });
          i = end + 1;
          continue;
        }
      }
      if (c === '[') {
        const m = /^\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/i.exec(s.slice(i));
        if (m && SAFE_URL.test(m[2]!)) {
          flush();
          walk(m[1]!, { ...style, href: m[2]! });
          i += m[0].length;
          continue;
        }
      }
      plain += c;
      i++;
    }
    flush();
  };
  walk(src, {});
  return out;
}

/** The whole notice → blocks (one per line; blank lines become small gaps). */
export function parseRich(src: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1]!.type !== 'gap') blocks.push({ type: 'gap' });
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) blocks.push({ type: 'hr' });
    else if ((m = /^##\s+(.*)$/.exec(line))) blocks.push({ type: 'h2', inlines: parseInline(m[1]!) });
    else if ((m = /^#\s+(.*)$/.exec(line))) blocks.push({ type: 'h1', inlines: parseInline(m[1]!) });
    else if ((m = /^>\s?(.*)$/.exec(line))) blocks.push({ type: 'quote', inlines: parseInline(m[1]!) });
    else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) blocks.push({ type: 'li', inlines: parseInline(m[1]!) });
    else if ((m = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line))) blocks.push({ type: 'ol', n: Number(m[1]), inlines: parseInline(m[2]!) });
    else blocks.push({ type: 'p', inlines: parseInline(line) });
  }
  while (blocks.length && blocks[blocks.length - 1]!.type === 'gap') blocks.pop();
  return blocks;
}

/** Plain text for notifications and previews ("• item", links as their text). */
export function richToPlain(src: string, maxLen = 240): string {
  const text = parseRich(src)
    .map((b) => {
      if (b.type === 'hr' || b.type === 'gap') return '';
      const t = b.inlines.map((x) => x.text).join('');
      return b.type === 'li' ? `• ${t}` : b.type === 'ol' ? `${b.n}. ${t}` : t;
    })
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text;
}
