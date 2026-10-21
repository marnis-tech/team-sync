/*
 * Text transformations behind the Markdown editing commands. Pure functions on plain
 * strings and offsets, so they can be tested without VS Code.
 */

/** Replace `start..end` of the document with `text`; the new selection is relative to `start`. */
export interface Replacement {
  start: number;
  end: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const WORD_CHAR = /[\p{L}\p{N}_-]/u;

/** Range of the word around `offset` (letters incl. umlauts, digits, `_`, `-`), empty if none. */
export function wordRangeAt(doc: string, offset: number): { start: number; end: number } {
  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHAR.test(doc[start - 1])) {
    start--;
  }
  while (end < doc.length && WORD_CHAR.test(doc[end])) {
    end++;
  }
  return { start, end };
}

/**
 * Wraps the selection (or the word at the cursor) in `before`/`after`, or removes them
 * if they are already there, inside or directly around the selection. Surrounding
 * whitespace stays outside the markers, because `**word **` is not bold in Markdown.
 */
export function toggleInline(doc: string, selStart: number, selEnd: number, before: string, after = before): Replacement {
  let start = selStart;
  let end = selEnd;

  if (start === end) {
    if (doc.slice(start - before.length, start) === before && doc.slice(start, start + after.length) === after) {
      // Cursor between empty markers, e.g. right after inserting them: remove them again.
      return { start: start - before.length, end: start + after.length, text: '', selectionStart: 0, selectionEnd: 0 };
    }
    ({ start, end } = wordRangeAt(doc, start));
    if (start === end) {
      const text = before + after;
      return { start, end, text, selectionStart: before.length, selectionEnd: before.length };
    }
  }

  const raw = doc.slice(start, end);
  const coreStart = start + (raw.length - raw.trimStart().length);
  const coreEnd = end - (raw.length - raw.trimEnd().length);
  if (coreStart >= coreEnd) {
    return { start, end, text: raw, selectionStart: 0, selectionEnd: raw.length };
  }
  const core = doc.slice(coreStart, coreEnd);

  if (core.length >= before.length + after.length && core.startsWith(before) && core.endsWith(after)) {
    const inner = core.slice(before.length, core.length - after.length);
    return { start: coreStart, end: coreEnd, text: inner, selectionStart: 0, selectionEnd: inner.length };
  }
  if (
    doc.slice(coreStart - before.length, coreStart) === before &&
    doc.slice(coreEnd, coreEnd + after.length) === after
  ) {
    return {
      start: coreStart - before.length,
      end: coreEnd + after.length,
      text: core,
      selectionStart: 0,
      selectionEnd: core.length,
    };
  }
  return {
    start: coreStart,
    end: coreEnd,
    text: before + core + after,
    selectionStart: before.length,
    selectionEnd: before.length + core.length,
  };
}

export type LineOperation =
  | { kind: 'bullets'; marker: string }
  | { kind: 'numbers' }
  | { kind: 'checkboxes'; marker: string }
  | { kind: 'quote' }
  | { kind: 'heading'; level: number }
  | { kind: 'codeBlock' };

const LIST_PREFIX = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const BULLET = /^\s*[-*+]\s+(?!\[[ xX]\]\s)/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+/;
const QUOTE = /^(\s*)>\s?/;
const HEADING = /^\s*(#{1,6})(?:\s+|$)/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Toggles a line format on whole lines: removes it if every line already has it,
 * otherwise applies it (converting other list types). Empty lines are left alone,
 * unless all lines are empty (cursor on an empty line).
 */
export function toggleLines(lines: string[], operation: LineOperation): string[] {
  const allEmpty = lines.every((line) => line.trim() === '');
  const targets = (line: string): boolean => allEmpty || line.trim() !== '';
  const relevant = lines.filter(targets);

  switch (operation.kind) {
    case 'bullets':
      if (!allEmpty && relevant.every((line) => BULLET.test(line))) {
        return lines.map((line) => line.replace(LIST_PREFIX, '$1'));
      }
      return lines.map((line) => (targets(line) ? withListPrefix(line, `${operation.marker} `) : line));

    case 'checkboxes':
      if (!allEmpty && relevant.every((line) => CHECKBOX.test(line))) {
        return lines.map((line) => line.replace(LIST_PREFIX, '$1'));
      }
      return lines.map((line) => (targets(line) ? withListPrefix(line, `${operation.marker} [ ] `) : line));

    case 'numbers': {
      if (!allEmpty && relevant.every((line) => NUMBERED.test(line))) {
        return lines.map((line) => line.replace(LIST_PREFIX, '$1'));
      }
      // Separate counters per indentation, a shallower line restarts deeper levels.
      const counters = new Map<number, number>();
      return lines.map((line) => {
        if (!targets(line)) {
          return line;
        }
        const indent = /^\s*/.exec(line)?.[0].length ?? 0;
        for (const depth of [...counters.keys()]) {
          if (depth > indent) {
            counters.delete(depth);
          }
        }
        const next = (counters.get(indent) ?? 0) + 1;
        counters.set(indent, next);
        return withListPrefix(line, `${next}. `);
      });
    }

    case 'quote':
      if (!allEmpty && lines.every((line) => line.trim() === '' || QUOTE.test(line))) {
        return lines.map((line) => line.replace(QUOTE, '$1'));
      }
      return lines.map((line) => (line.trim() === '' && !allEmpty ? '>' : `> ${line}`));

    case 'heading': {
      const marker = '#'.repeat(operation.level);
      const hasLevel = (line: string): boolean => HEADING.exec(line)?.[1] === marker;
      if (!allEmpty && relevant.every(hasLevel)) {
        return lines.map((line) => line.replace(HEADING, ''));
      }
      return lines.map((line) => (targets(line) ? `${marker} ${line.replace(HEADING, '').trimStart()}` : line));
    }

    case 'codeBlock':
      if (lines.length >= 2 && FENCE.test(lines[0]) && FENCE.test(lines[lines.length - 1])) {
        return lines.slice(1, -1);
      }
      return ['```', ...lines, '```'];
  }
}

/** Heading level shared by all non-empty lines, undefined if none or mixed. */
export function headingLevelOf(lines: string[]): number | undefined {
  const levels = new Set(
    lines.filter((line) => line.trim() !== '').map((line) => HEADING.exec(line)?.[1].length ?? 0),
  );
  const [level] = [...levels];
  return levels.size === 1 && level > 0 ? level : undefined;
}

function withListPrefix(line: string, prefix: string): string {
  const match = LIST_PREFIX.exec(line);
  if (match) {
    return match[1] + prefix + line.slice(match[0].length);
  }
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  return indent + prefix + line.slice(indent.length);
}

/**
 * Builds a Markdown table from lines whose cells are separated by tabs, `|` or at least
 * two spaces (e.g. pasted from a spreadsheet). Without header, the header row stays
 * empty, which the HTML export drops.
 */
export function linesToTable(lines: string[], withHeader: boolean): string[] {
  const rows = lines.filter((line) => line.trim() !== '').map(splitCells);
  const columns = Math.max(2, ...rows.map((row) => row.length));
  const pad = (row: string[]): string[] => [...row, ...Array<string>(columns - row.length).fill('')];

  const header = withHeader && rows.length > 0 ? pad(rows.shift() as string[]) : Array<string>(columns).fill('');
  const body = rows.length > 0 ? rows.map(pad) : [Array<string>(columns).fill('')];
  return [formatRow(header), `|${'---|'.repeat(columns)}`, ...body.map(formatRow)];
}

function splitCells(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.includes('\t')) {
    return trimmed.split('\t').map((cell) => cell.trim());
  }
  if (trimmed.includes('|')) {
    return trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }
  return trimmed.split(/\s{2,}/);
}

function formatRow(cells: string[]): string {
  return `|${cells.map((cell) => (cell === '' ? ' ' : ` ${cell} `)).join('|')}|`;
}

const LINK = /^\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)$/;
const IMAGE = /^!\[([^\]]*)\]\((<[^>]*>|[^)]*)\)$/;
const URL_PATTERN = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

export function isUrl(text: string): boolean {
  return URL_PATTERN.test(text.trim());
}

/** Link text of a Markdown link, or undefined if `text` is no link. */
export function parseLinkText(text: string): string | undefined {
  return LINK.exec(text.trim())?.[1];
}

/** URL of a Markdown image, or undefined if `text` is no image. */
export function parseImageUrl(text: string): string | undefined {
  const url = IMAGE.exec(text.trim())?.[2];
  return url?.replace(/^<(.*)>$/, '$1');
}

/** `[text](url)`; URLs with spaces or parentheses are wrapped in `<>`, `]` in the text is escaped. */
export function buildLink(text: string, url: string, image = false): string {
  const target = /[\s()]/.test(url) ? `<${url}>` : url;
  return `${image ? '!' : ''}[${text.replace(/]/g, '\\]')}](${target})`;
}
