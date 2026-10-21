import { posix } from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../util/json';
import {
  buildLink,
  headingLevelOf,
  isUrl,
  LineOperation,
  linesToTable,
  parseImageUrl,
  parseLinkText,
  Replacement,
  toggleInline,
  toggleLines,
  wordRangeAt,
} from './editing';
import { DEFAULT_MARKDOWN_HTML_OPTIONS, MarkdownHtmlOptions, renderMarkdownHtml } from './html';

interface MarkdownCommand {
  id: string;
  label: string;
  example: string;
  run(editor: vscode.TextEditor): Promise<void>;
}

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6];

/** Registers all Markdown editing commands. */
export function registerMarkdownCommands(channel: vscode.LogOutputChannel): vscode.Disposable[] {
  const commands: MarkdownCommand[] = [
    inline('bold', 'Fett', '**Text**', () => [setting('boldMarker', '**')]),
    inline('italic', 'Kursiv', '_Text_', () => [setting('italicMarker', '_')]),
    inline('strikethrough', 'Durchgestrichen', '~~Text~~', () => ['~~']),
    inline('inlineCode', 'Code im Text', '`Code`', () => ['`']),
    ...HEADING_LEVELS.map((level) =>
      lines(`heading${level}`, `Überschrift ${level}`, `${'#'.repeat(level)} Titel`, () => ({ kind: 'heading', level })),
    ),
    lines('bullets', 'Aufzählung', '- Punkt', () => ({ kind: 'bullets', marker: setting('bulletMarker', '-') })),
    lines('numbers', 'Nummerierte Liste', '1. Punkt', () => ({ kind: 'numbers' })),
    lines('checkboxes', 'Checkliste', '- [ ] Aufgabe', () => ({ kind: 'checkboxes', marker: setting('bulletMarker', '-') })),
    lines('quote', 'Zitat', '> Zitat', () => ({ kind: 'quote' })),
    lines('codeBlock', 'Codeblock', '``` Code ```', () => ({ kind: 'codeBlock' })),
    { id: 'link', label: 'Link', example: '[Text](https://...)', run: (editor) => insertLink(editor, false) },
    { id: 'image', label: 'Bild', example: '![Alt-Text](https://...)', run: (editor) => insertLink(editor, true) },
    { id: 'table', label: 'Tabelle (ohne Kopfzeile)', example: '| | |', run: (editor) => insertTable(editor, false) },
    {
      id: 'tableWithHeader',
      label: 'Tabelle (mit Kopfzeile)',
      example: '| Spalte | Spalte |',
      run: (editor) => insertTable(editor, true),
    },
  ];

  const execute = (command: MarkdownCommand) => async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    try {
      await command.run(editor);
    } catch (error) {
      channel.error(`Markdown-Befehl "${command.label}" fehlgeschlagen: ${errorMessage(error)}`);
    }
  };

  // The built-in preview does not tell which file it shows; remember the last Markdown editor as fallback.
  let lastMarkdownDocument = markdownDocumentOf(vscode.window.activeTextEditor);
  const tracker = vscode.window.onDidChangeActiveTextEditor((editor) => {
    lastMarkdownDocument = markdownDocumentOf(editor) ?? lastMarkdownDocument;
  });

  return [
    tracker,
    ...commands.map((command) => vscode.commands.registerCommand(`teamSync.markdown.${command.id}`, execute(command))),
    // Optional argument: a level 1 to 6 applies it directly (also usable in keybindings).
    vscode.commands.registerCommand('teamSync.markdown.heading', async (level?: unknown) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      // Title bar buttons pass a URI here, only a number selects a level.
      const direct =
        typeof level === 'number' ? commands.find((candidate) => candidate.id === `heading${level}`) : undefined;
      if (direct) {
        await execute(direct)();
        return;
      }
      const document = editor.document;
      const current = headingLevelOf(
        lineBlocks(editor).flatMap(({ startLine, endLine }) =>
          Array.from({ length: endLine - startLine + 1 }, (_, i) => document.lineAt(startLine + i).text),
        ),
      );
      const picked = await vscode.window.showQuickPick(
        HEADING_LEVELS.map((level) => ({
          label: `${level === current ? '$(check)' : '$(blank)'} Überschrift ${level}`,
          description: level === current ? 'aktiv, auswählen zum Entfernen' : '#'.repeat(level),
          level,
        })),
        { title: 'Überschrift', placeHolder: 'Ebene für die aktuelle Zeile wählen' },
      );
      const command = picked && commands.find((candidate) => candidate.id === `heading${picked.level}`);
      if (command) {
        // Same level toggles the heading off, another level replaces it.
        await execute(command)();
      }
    }),
    vscode.commands.registerCommand('teamSync.markdown.showCommands', async () => {
      const picked = await vscode.window.showQuickPick(
        commands.map((command) => ({ label: command.label, description: command.example, command })),
        { title: 'Markdown-Formatierung', matchOnDescription: true },
      );
      if (picked) {
        await execute(picked.command)();
      }
    }),
    vscode.commands.registerCommand('teamSync.markdown.copyAsHtml', (resource?: unknown) =>
      copyAsHtml(channel, resource, lastMarkdownDocument),
    ),
  ];
}

const DOCUMENT_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs']);

function markdownDocumentOf(editor: vscode.TextEditor | undefined): vscode.TextDocument | undefined {
  return editor?.document.languageId === 'markdown' ? editor.document : undefined;
}

/**
 * Document shown by the active Markdown preview: matched by the tab label
 * ("Preview <file name>", localized), otherwise the last active Markdown editor.
 */
function previewedDocument(fallback: vscode.TextDocument | undefined): vscode.TextDocument | undefined {
  const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? '';
  const candidates = vscode.workspace.textDocuments.filter(
    (document) => document.languageId === 'markdown' && !document.isClosed && label.endsWith(posix.basename(document.uri.path)),
  );
  if (candidates.length === 1) {
    return candidates[0];
  }
  return fallback && (candidates.length === 0 || candidates.includes(fallback)) && !fallback.isClosed ? fallback : candidates[0];
}

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('teamSync.markdown').get<T>(key, fallback);
}

function inline(id: string, label: string, example: string, markers: () => [string, string?]): MarkdownCommand {
  return {
    id,
    label,
    example,
    run: async (editor) => {
      const [before, after] = markers();
      const doc = editor.document.getText();
      const replacements = editor.selections.map((selection) =>
        toggleInline(doc, editor.document.offsetAt(selection.start), editor.document.offsetAt(selection.end), before, after),
      );
      await applyReplacements(editor, replacements);
    },
  };
}

function lines(id: string, label: string, example: string, operation: () => LineOperation): MarkdownCommand {
  return {
    id,
    label,
    example,
    run: async (editor) => {
      const op = operation();
      const document = editor.document;
      const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const replacements = lineBlocks(editor).map(({ startLine, endLine, selection }) => {
        const original = Array.from({ length: endLine - startLine + 1 }, (_, i) => document.lineAt(startLine + i).text);
        const changed = toggleLines(original, op);
        const text = changed.join(eol);
        const start = document.offsetAt(new vscode.Position(startLine, 0));
        const end = document.offsetAt(document.lineAt(endLine).range.end);
        if (selection && selection.isEmpty && original.length === 1) {
          // Keep the cursor at its place in the text; on an empty code block inside the block.
          if (op.kind === 'codeBlock' && changed.length === 3) {
            const inside = changed[0].length + eol.length + changed[1].length;
            return { start, end, text, selectionStart: inside, selectionEnd: inside };
          }
          const column = selection.active.character + changed[0].length - original[0].length;
          const offset = Math.max(0, Math.min(changed[0].length, original[0].trim() === '' ? changed[0].length : column));
          return { start, end, text, selectionStart: offset, selectionEnd: offset };
        }
        return { start, end, text, selectionStart: 0, selectionEnd: text.length };
      });
      await applyReplacements(editor, replacements);
    },
  };
}

interface LineBlock {
  startLine: number;
  endLine: number;
  /** The selection, if the block comes from exactly one selection. */
  selection?: vscode.Selection;
}

/** Whole-line blocks covered by the selections; overlapping or adjacent ones are merged. */
function lineBlocks(editor: vscode.TextEditor): LineBlock[] {
  const blocks = editor.selections
    .map((selection) => {
      let endLine = selection.end.line;
      if (!selection.isEmpty && selection.end.character === 0 && endLine > selection.start.line) {
        endLine--;
      }
      return { startLine: selection.start.line, endLine, selection } as LineBlock;
    })
    .sort((a, b) => a.startLine - b.startLine);
  const merged: LineBlock[] = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && block.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, block.endLine);
      last.selection = undefined;
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

/** Applies non-overlapping replacements in one edit (one undo step) and sets the new selections. */
async function applyReplacements(editor: vscode.TextEditor, replacements: Replacement[]): Promise<void> {
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  const unique = sorted.filter((replacement, index) => index === 0 || replacement.start >= sorted[index - 1].end);
  const document = editor.document;
  const applied = await editor.edit((builder) => {
    for (const { start, end, text } of unique) {
      builder.replace(new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
    }
  });
  if (!applied) {
    return;
  }
  let shift = 0;
  editor.selections = unique.map((replacement) => {
    const base = replacement.start + shift;
    shift += replacement.text.length - (replacement.end - replacement.start);
    return new vscode.Selection(
      document.positionAt(base + replacement.selectionStart),
      document.positionAt(base + replacement.selectionEnd),
    );
  });
  editor.revealRange(editor.selection);
}

async function insertLink(editor: vscode.TextEditor, image: boolean): Promise<void> {
  const document = editor.document;
  const doc = document.getText();
  let start = document.offsetAt(editor.selection.start);
  let end = document.offsetAt(editor.selection.end);
  if (start === end) {
    ({ start, end } = wordRangeAt(doc, start));
  }
  const selected = doc.slice(start, end);

  // Toggle off: a link becomes its text again, an image its URL.
  const existing = image ? parseImageUrl(selected) : parseLinkText(selected);
  if (existing !== undefined) {
    await applyReplacements(editor, [{ start, end, text: existing, selectionStart: 0, selectionEnd: existing.length }]);
    return;
  }

  const clipboard = (await vscode.env.clipboard.readText()).trim();
  const url = isUrl(selected)
    ? selected.trim()
    : await vscode.window.showInputBox({
        title: image ? 'Bild einfügen' : 'Link einfügen',
        prompt: image ? 'Adresse des Bildes' : 'Adresse (URL)',
        value: isUrl(clipboard) ? clipboard : 'https://',
        ignoreFocusOut: true,
      });
  if (!url || url === 'https://') {
    return;
  }
  let text = isUrl(selected) ? '' : selected;
  if (text === '') {
    const entered = await vscode.window.showInputBox({
      title: image ? 'Bild einfügen' : 'Link einfügen',
      prompt: image ? 'Alternativtext (beschreibt das Bild)' : 'Linktext',
      value: image ? '' : url,
      ignoreFocusOut: true,
    });
    if (entered === undefined) {
      return;
    }
    text = entered;
  }
  const markdown = buildLink(text, url, image);
  await applyReplacements(editor, [
    { start, end, text: markdown, selectionStart: markdown.length, selectionEnd: markdown.length },
  ]);
}

async function insertTable(editor: vscode.TextEditor, withHeader: boolean): Promise<void> {
  const document = editor.document;
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const selection = editor.selection;

  if (selection.isEmpty) {
    const table = linesToTable(withHeader ? ['Spalte 1\tSpalte 2'] : [], withHeader);
    // Wider empty body cells, so the cursor lands inside the first one.
    table[2] = table[2].replace(/\| (?=\|)/g, '|  ');
    const line = document.lineAt(selection.active.line);
    // An empty line is replaced, otherwise the table goes below the current line.
    const start = line.isEmptyOrWhitespace ? document.offsetAt(line.range.start) : document.offsetAt(line.range.end);
    const prefix = line.isEmptyOrWhitespace ? '' : eol + eol;
    const text = prefix + table.join(eol);
    // Cursor into the first body cell.
    const cursor = prefix.length + table[0].length + eol.length + table[1].length + eol.length + 2;
    const end = line.isEmptyOrWhitespace ? document.offsetAt(line.range.end) : start;
    await applyReplacements(editor, [{ start, end, text, selectionStart: cursor, selectionEnd: cursor }]);
    return;
  }

  const block = lineBlocks(editor)[0];
  const original = Array.from({ length: block.endLine - block.startLine + 1 }, (_, i) =>
    document.lineAt(block.startLine + i).text,
  );
  const text = linesToTable(original, withHeader).join(eol);
  await applyReplacements(editor, [
    {
      start: document.offsetAt(new vscode.Position(block.startLine, 0)),
      end: document.offsetAt(document.lineAt(block.endLine).range.end),
      text,
      selectionStart: 0,
      selectionEnd: text.length,
    },
  ]);
}

/**
 * Converts the selection (or the whole document) to HTML and puts it on the clipboard.
 * Called from a Markdown preview, it converts the whole previewed document.
 */
async function copyAsHtml(
  channel: vscode.LogOutputChannel,
  resource: unknown,
  lastMarkdownDocument: vscode.TextDocument | undefined,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let document: vscode.TextDocument | undefined;
  let selection: vscode.Selection | undefined;
  // Title bar buttons pass the URI of the active tab; for a preview that is an internal
  // webview URI, which is no document and has to be ignored.
  const fileUri =
    resource instanceof vscode.Uri && DOCUMENT_SCHEMES.has(resource.scheme) && resource.toString() !== editor?.document.uri.toString()
      ? resource
      : undefined;
  if (fileUri) {
    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch (error) {
      channel.warn(`Dokument ${fileUri.toString()} konnte nicht geöffnet werden: ${errorMessage(error)}`);
    }
  }
  if (!document && editor) {
    ({ document, selection } = editor);
  }
  if (!document) {
    document = previewedDocument(lastMarkdownDocument);
  }
  if (!document) {
    void vscode.window.showInformationMessage('Bitte zuerst eine Markdown-Datei oder ihre Vorschau öffnen.');
    return;
  }
  const partial = selection !== undefined && !selection.isEmpty;
  const markdown = partial ? document.getText(selection) : document.getText();
  try {
    await vscode.env.clipboard.writeText(renderMarkdownHtml(markdown, readHtmlOptions(document.uri)));
    vscode.window.setStatusBarMessage(
      partial ? '$(check) HTML der Auswahl kopiert' : `$(check) HTML von ${posix.basename(document.uri.path)} kopiert`,
      3000,
    );
  } catch (error) {
    channel.error(`Markdown konnte nicht als HTML kopiert werden: ${errorMessage(error)}`);
    void vscode.window.showErrorMessage('Markdown konnte nicht als HTML kopiert werden.');
  }
}

function readHtmlOptions(scope: vscode.Uri): MarkdownHtmlOptions {
  const config = vscode.workspace.getConfiguration('teamSync.markdown', scope);
  const defaults = DEFAULT_MARKDOWN_HTML_OPTIONS;
  return {
    html: config.get<boolean>('html', defaults.html),
    breaks: config.get<boolean>('breaks', defaults.breaks),
    linkify: config.get<boolean>('linkify', defaults.linkify),
    typographer: config.get<boolean>('typographer', defaults.typographer),
    quotes: config.get<string>('quotes', defaults.quotes),
    tableClass: config.get<string>('tableClass', defaults.tableClass),
    removeEmptyTableHeader: config.get<boolean>('removeEmptyTableHeader', defaults.removeEmptyTableHeader),
  };
}
