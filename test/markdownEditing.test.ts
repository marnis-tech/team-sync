import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildLink,
  headingLevelOf,
  isUrl,
  linesToTable,
  parseImageUrl,
  parseLinkText,
  Replacement,
  toggleInline,
  toggleLines,
  wordRangeAt,
} from '../src/markdown/editing';

/** Applies a replacement and marks the new selection with [ and ]. */
function apply(doc: string, replacement: Replacement): string {
  const result = doc.slice(0, replacement.start) + replacement.text + doc.slice(replacement.end);
  const selStart = replacement.start + replacement.selectionStart;
  const selEnd = replacement.start + replacement.selectionEnd;
  return `${result.slice(0, selStart)}[${result.slice(selStart, selEnd)}]${result.slice(selEnd)}`;
}

describe('wordRangeAt', () => {
  it('includes umlauts and hyphens', () => {
    const doc = 'Eine größere Tisch-Leuchte';
    const { start, end } = wordRangeAt(doc, 7);
    assert.equal(doc.slice(start, end), 'größere');
    const hyphen = wordRangeAt(doc, 15);
    assert.equal(doc.slice(hyphen.start, hyphen.end), 'Tisch-Leuchte');
  });
});

describe('toggleInline', () => {
  it('wraps the selection', () => {
    assert.equal(apply('ein Wort hier', toggleInline('ein Wort hier', 4, 8, '**')), 'ein **[Wort]** hier');
  });

  it('wraps the word at the cursor, including umlauts', () => {
    assert.equal(apply('sehr schön', toggleInline('sehr schön', 7, 7, '**')), 'sehr **[schön]**');
  });

  it('keeps surrounding whitespace outside the markers', () => {
    assert.equal(apply('a fett b', toggleInline('a fett b', 2, 7, '**')), 'a **[fett]** b');
  });

  it('removes markers inside the selection', () => {
    assert.equal(apply('a **fett** b', toggleInline('a **fett** b', 2, 10, '**')), 'a [fett] b');
  });

  it('removes markers around the selection', () => {
    assert.equal(apply('a **fett** b', toggleInline('a **fett** b', 4, 8, '**')), 'a [fett] b');
  });

  it('removes markers around the word at the cursor', () => {
    assert.equal(apply('a _kursiv_ b', toggleInline('a _kursiv_ b', 5, 5, '_')), 'a [kursiv] b');
  });

  it('inserts empty markers with the cursor inside, and removes them again', () => {
    assert.equal(apply('a  b', toggleInline('a  b', 2, 2, '~~')), 'a ~~[]~~ b');
    assert.equal(apply('a ~~~~ b', toggleInline('a ~~~~ b', 4, 4, '~~')), 'a [] b');
  });

  it('supports different start and end markers', () => {
    assert.equal(apply('x', toggleInline('x', 0, 1, '<u>', '</u>')), '<u>[x]</u>');
  });
});

describe('toggleLines', () => {
  it('adds and removes bullets', () => {
    assert.deepEqual(toggleLines(['eins', '', '  zwei'], { kind: 'bullets', marker: '-' }), ['- eins', '', '  - zwei']);
    assert.deepEqual(toggleLines(['- eins', '* zwei'], { kind: 'bullets', marker: '-' }), ['eins', 'zwei']);
  });

  it('converts numbered lists and checkboxes to bullets', () => {
    assert.deepEqual(toggleLines(['1. eins', '- [ ] zwei'], { kind: 'bullets', marker: '-' }), ['- eins', '- zwei']);
  });

  it('starts a list on an empty line', () => {
    assert.deepEqual(toggleLines([''], { kind: 'bullets', marker: '-' }), ['- ']);
    assert.deepEqual(toggleLines([''], { kind: 'numbers' }), ['1. ']);
  });

  it('numbers per indentation level', () => {
    assert.deepEqual(toggleLines(['a', '  b', '  c', 'd', '  e'], { kind: 'numbers' }), [
      '1. a',
      '  1. b',
      '  2. c',
      '2. d',
      '  1. e',
    ]);
    assert.deepEqual(toggleLines(['1. a', '2. b'], { kind: 'numbers' }), ['a', 'b']);
  });

  it('toggles checkboxes, also checked ones', () => {
    assert.deepEqual(toggleLines(['a', '- b'], { kind: 'checkboxes', marker: '-' }), ['- [ ] a', '- [ ] b']);
    assert.deepEqual(toggleLines(['- [x] a', '- [ ] b'], { kind: 'checkboxes', marker: '-' }), ['a', 'b']);
  });

  it('toggles quotes, keeping paragraphs inside the quote', () => {
    assert.deepEqual(toggleLines(['a', '', 'b'], { kind: 'quote' }), ['> a', '>', '> b']);
    assert.deepEqual(toggleLines(['> a', '>', '> b'], { kind: 'quote' }), ['a', '', 'b']);
  });

  it('sets, changes and removes headings', () => {
    assert.deepEqual(toggleLines(['Titel'], { kind: 'heading', level: 3 }), ['### Titel']);
    assert.deepEqual(toggleLines(['## Titel'], { kind: 'heading', level: 3 }), ['### Titel']);
    assert.deepEqual(toggleLines(['### Titel'], { kind: 'heading', level: 3 }), ['Titel']);
    assert.deepEqual(toggleLines([''], { kind: 'heading', level: 2 }), ['## ']);
  });

  it('wraps and unwraps code blocks', () => {
    assert.deepEqual(toggleLines(['let a = 1;'], { kind: 'codeBlock' }), ['```', 'let a = 1;', '```']);
    assert.deepEqual(toggleLines(['```', 'let a = 1;', '```'], { kind: 'codeBlock' }), ['let a = 1;']);
  });
});

describe('headingLevelOf', () => {
  it('detects the shared heading level', () => {
    assert.equal(headingLevelOf(['### Titel']), 3);
    assert.equal(headingLevelOf(['## a', '', '## b']), 2);
  });

  it('returns undefined for plain or mixed lines', () => {
    assert.equal(headingLevelOf(['Titel']), undefined);
    assert.equal(headingLevelOf(['## a', '### b']), undefined);
    assert.equal(headingLevelOf(['']), undefined);
    assert.equal(headingLevelOf(['#hashtag']), undefined);
  });
});

describe('linesToTable', () => {
  it('builds a table with an empty header from tab separated lines', () => {
    assert.deepEqual(linesToTable(['Leistung\t10 Watt', 'Farbe\tweiß'], false), [
      '| | |',
      '|---|---|',
      '| Leistung | 10 Watt |',
      '| Farbe | weiß |',
    ]);
  });

  it('uses the first line as header and pads missing cells', () => {
    assert.deepEqual(linesToTable(['Name  Wert  Einheit', 'Höhe  20'], true), [
      '| Name | Wert | Einheit |',
      '|---|---|---|',
      '| Höhe | 20 | |',
    ]);
  });

  it('accepts lines that already use pipes', () => {
    assert.deepEqual(linesToTable(['| a | b |'], false), ['| | |', '|---|---|', '| a | b |']);
  });

  it('creates an empty two-column table without input', () => {
    assert.deepEqual(linesToTable([], false), ['| | |', '|---|---|', '| | |']);
  });
});

describe('links', () => {
  it('detects URLs', () => {
    assert.equal(isUrl('https://example.com/a'), true);
    assert.equal(isUrl('www.example.com'), true);
    assert.equal(isUrl('kein Link'), false);
  });

  it('builds links and images', () => {
    assert.equal(buildLink('Beispiel', 'https://example.com'), '[Beispiel](https://example.com)');
    assert.equal(buildLink('a [b]', 'https://example.com/x (1)'), '[a [b\\]](<https://example.com/x (1)>)');
    assert.equal(buildLink('Foto', 'https://example.com/a.jpg', true), '![Foto](https://example.com/a.jpg)');
  });

  it('parses existing links and images', () => {
    assert.equal(parseLinkText('[Beispiel](https://example.com)'), 'Beispiel');
    assert.equal(parseLinkText('Beispiel'), undefined);
    assert.equal(parseImageUrl('![Foto](<https://example.com/a b.jpg>)'), 'https://example.com/a b.jpg');
  });
});
