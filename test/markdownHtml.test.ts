import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_MARKDOWN_HTML_OPTIONS, renderMarkdownHtml } from '../src/markdown/html';

// Fictional sample with the structure of a typical product description.
const PRODUCT_MARKDOWN = `Die Beispielleuchte Alpha von Muster & Co verbindet eine schlichte Form mit robusten Materialien. Ein Diffusor verteilt das Licht gleichmäßig im Raum.

Die Leuchte kann an der Wand oder an der Decke montiert werden.

Design Erika Mustermann 2020

### Technische Daten

| | |
|---|---|
| Leuchtmittel | LED |
| Leistung | 10 Watt |
| Hinweise | dimmbar |

### Material

- Aluminium
- Glas

### Maße

- H 20 cm, B 30 cm

===legal_notice_placeholder===
`;

// Target format: Bootstrap table classes, no empty <thead>.
const PRODUCT_HTML = `<p>Die Beispielleuchte Alpha von Muster &amp; Co verbindet eine schlichte Form mit robusten Materialien. Ein Diffusor verteilt das Licht gleichmäßig im Raum.</p>
<p>Die Leuchte kann an der Wand oder an der Decke montiert werden.</p>
<p>Design Erika Mustermann 2020</p>
<h3>Technische Daten</h3>
<table class="table table-sm align-top table-hover">
<tbody>
<tr>
<td>Leuchtmittel</td>
<td>LED</td>
</tr>
<tr>
<td>Leistung</td>
<td>10 Watt</td>
</tr>
<tr>
<td>Hinweise</td>
<td>dimmbar</td>
</tr>
</tbody>
</table>
<h3>Material</h3>
<ul>
<li>Aluminium</li>
<li>Glas</li>
</ul>
<h3>Maße</h3>
<ul>
<li>H 20 cm, B 30 cm</li>
</ul>
<p>===legal_notice_placeholder===</p>
`;

describe('renderMarkdownHtml', () => {
  it('produces the shop format for a product description', () => {
    assert.equal(renderMarkdownHtml(PRODUCT_MARKDOWN, DEFAULT_MARKDOWN_HTML_OPTIONS), PRODUCT_HTML);
  });

  it('keeps a table header with content', () => {
    const html = renderMarkdownHtml('| Name | Wert |\n|---|---|\n| a | b |\n', DEFAULT_MARKDOWN_HTML_OPTIONS);
    assert.match(html, /<thead>\s*<tr>\s*<th>Name<\/th>/);
  });

  it('can keep empty headers and plain tables (format of the old workflow)', () => {
    const html = renderMarkdownHtml('| | |\n|---|---|\n| a | b |\n', {
      ...DEFAULT_MARKDOWN_HTML_OPTIONS,
      tableClass: '',
      removeEmptyTableHeader: false,
    });
    assert.match(html, /^<table>\n<thead>\n<tr>\n<th><\/th>/);
  });

  it('handles several tables in one document', () => {
    const table = '| | |\n|---|---|\n| a | b |\n';
    const html = renderMarkdownHtml(`${table}\ntext\n\n${table}`, DEFAULT_MARKDOWN_HTML_OPTIONS);
    assert.equal(html.match(/<table class="table table-sm align-top table-hover">/g)?.length, 2);
    assert.equal(html.includes('<thead>'), false);
  });

  it('applies typography with German quotes and line breaks', () => {
    const html = renderMarkdownHtml('Ein "Beispiel" -- seit 2020...\nneue Zeile', DEFAULT_MARKDOWN_HTML_OPTIONS);
    assert.equal(html, '<p>Ein „Beispiel“ – seit 2020…<br>\nneue Zeile</p>\n');
  });

  it('escapes raw HTML unless enabled', () => {
    assert.match(renderMarkdownHtml('<b>x</b>', DEFAULT_MARKDOWN_HTML_OPTIONS), /&lt;b&gt;/);
    assert.match(renderMarkdownHtml('<b>x</b>', { ...DEFAULT_MARKDOWN_HTML_OPTIONS, html: true }), /<b>x<\/b>/);
  });

  it('falls back to default quotes for an invalid quotes setting', () => {
    const html = renderMarkdownHtml('"a"', { ...DEFAULT_MARKDOWN_HTML_OPTIONS, quotes: '' });
    assert.equal(html, '<p>“a”</p>\n');
  });
});
