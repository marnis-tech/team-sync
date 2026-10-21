import MarkdownIt from 'markdown-it';

export interface MarkdownHtmlOptions {
  /** Allow raw HTML tags in the Markdown source. */
  html: boolean;
  /** Turn single line breaks inside paragraphs into <br>. */
  breaks: boolean;
  /** Turn URL-like text into links. */
  linkify: boolean;
  /** Typographic replacements (dashes, ellipsis, quotes). */
  typographer: boolean;
  /** Replacement quotes: double open, double close, single open, single close. */
  quotes: string;
  /** CSS classes for every <table>; empty for none. */
  tableClass: string;
  /** Drop a table header row whose cells are all empty (Markdown tables always need one). */
  removeEmptyTableHeader: boolean;
}

export const DEFAULT_MARKDOWN_HTML_OPTIONS: MarkdownHtmlOptions = {
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
  quotes: '„“‚‘',
  tableClass: 'table table-sm align-top table-hover',
  removeEmptyTableHeader: true,
};

const DEFAULT_QUOTES = '“”‘’';

export function renderMarkdownHtml(markdown: string, options: MarkdownHtmlOptions): string {
  const md = new MarkdownIt({
    html: options.html,
    breaks: options.breaks,
    linkify: options.linkify,
    typographer: options.typographer,
    quotes: [...options.quotes].length === 4 ? options.quotes : DEFAULT_QUOTES,
  });

  md.core.ruler.push('team_sync_tables', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'table_open' && options.tableClass.trim() !== '') {
        token.attrJoin('class', options.tableClass.trim());
      }
      if (token.type === 'thead_open' && options.removeEmptyTableHeader) {
        const end = tokens.findIndex((candidate, index) => index > i && candidate.type === 'thead_close');
        const cells = end === -1 ? [] : tokens.slice(i, end).filter((candidate) => candidate.type === 'inline');
        if (end !== -1 && cells.every((cell) => cell.content.trim() === '')) {
          tokens.splice(i, end - i + 1);
          i--;
        }
      }
    }
  });

  return md.render(markdown);
}
