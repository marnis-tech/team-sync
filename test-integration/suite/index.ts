/*
 * Integration tests, executed inside the VS Code extension host by runTest.ts.
 * Plain async functions with node:assert, no test framework needed.
 */
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import * as vscode from 'vscode';

type Test = [name: string, run: () => Promise<void>];

async function openMarkdown(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  return vscode.window.showTextDocument(document);
}

function select(editor: vscode.TextEditor, ...ranges: Array<[number, number, number, number]>): void {
  editor.selections = ranges.map(([l1, c1, l2, c2]) => new vscode.Selection(l1, c1, l2, c2));
}

async function exec(editor: vscode.TextEditor, command: string): Promise<string> {
  await vscode.commands.executeCommand(`teamSync.markdown.${command}`);
  return editor.document.getText();
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timeout while waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const tests: Test[] = [
  [
    'bold toggles the word at the cursor and back',
    async () => {
      const editor = await openMarkdown('Ein schönes Wort');
      select(editor, [0, 6, 0, 6]);
      assert.equal(await exec(editor, 'bold'), 'Ein **schönes** Wort');
      assert.equal(editor.document.getText(editor.selection), 'schönes');
      assert.equal(await exec(editor, 'bold'), 'Ein schönes Wort');
    },
  ],
  [
    'bold works with several cursors in one undo step',
    async () => {
      const editor = await openMarkdown('eins zwei drei');
      select(editor, [0, 0, 0, 4], [0, 10, 0, 14]);
      assert.equal(await exec(editor, 'bold'), '**eins** zwei **drei**');
      assert.equal(editor.selections.length, 2);
      await vscode.commands.executeCommand('undo');
      assert.equal(editor.document.getText(), 'eins zwei drei');
    },
  ],
  [
    'heading 3 is set, changed and removed',
    async () => {
      const editor = await openMarkdown('## Titel');
      select(editor, [0, 4, 0, 4]);
      assert.equal(await exec(editor, 'heading3'), '### Titel');
      assert.equal(await exec(editor, 'heading3'), 'Titel');
    },
  ],
  [
    'heading command with a level changes and removes headings',
    async () => {
      const editor = await openMarkdown('Titel');
      await vscode.commands.executeCommand('teamSync.markdown.heading', 2);
      assert.equal(editor.document.getText(), '## Titel');
      await vscode.commands.executeCommand('teamSync.markdown.heading', 3);
      assert.equal(editor.document.getText(), '### Titel');
      await vscode.commands.executeCommand('teamSync.markdown.heading', 3);
      assert.equal(editor.document.getText(), 'Titel');
    },
  ],
  [
    'bullets and numbers apply to all selected lines',
    async () => {
      const editor = await openMarkdown('eins\nzwei\n\ndrei');
      select(editor, [0, 0, 3, 4]);
      assert.equal(await exec(editor, 'bullets'), '- eins\n- zwei\n\n- drei');
      assert.equal(await exec(editor, 'numbers'), '1. eins\n2. zwei\n\n3. drei');
      assert.equal(await exec(editor, 'numbers'), 'eins\nzwei\n\ndrei');
    },
  ],
  [
    'bullet on an empty line puts the cursor behind the marker',
    async () => {
      const editor = await openMarkdown('');
      assert.equal(await exec(editor, 'bullets'), '- ');
      assert.equal(editor.selection.active.character, 2);
    },
  ],
  [
    'table converts tab separated lines with an empty header',
    async () => {
      const editor = await openMarkdown('Leistung\t10 Watt\nFarbe\tweiß');
      select(editor, [0, 0, 1, 11]);
      assert.equal(await exec(editor, 'table'), '| | |\n|---|---|\n| Leistung | 10 Watt |\n| Farbe | weiß |');
    },
  ],
  [
    'table template puts the cursor into the first cell',
    async () => {
      const editor = await openMarkdown('');
      assert.equal(await exec(editor, 'table'), '| | |\n|---|---|\n|  |  |');
      assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [2, 2]);
    },
  ],
  [
    'link toggles off an existing link',
    async () => {
      const editor = await openMarkdown('[Beispiel](https://example.com)');
      select(editor, [0, 0, 0, 31]);
      assert.equal(await exec(editor, 'link'), 'Beispiel');
    },
  ],
  [
    'copy as HTML uses the shop format',
    async () => {
      await openMarkdown('### Daten\n\n| | |\n|---|---|\n| Höhe | 20 cm |\n');
      await vscode.commands.executeCommand('teamSync.markdown.copyAsHtml');
      const html = await vscode.env.clipboard.readText();
      assert.match(html, /<table class="table table-sm align-top table-hover">\n<tbody>/);
      assert.equal(html.includes('<thead>'), false);
    },
  ],
  [
    'copy as HTML works from the Markdown preview',
    async () => {
      await openMarkdown('Vorschau mit "Zitat"');
      await vscode.commands.executeCommand('markdown.showPreview');
      await waitFor(() => vscode.window.activeTextEditor === undefined);
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('teamSync.markdown.copyAsHtml');
      assert.equal(await vscode.env.clipboard.readText(), '<p>Vorschau mit „Zitat“</p>\n');

      // A click on the title bar button passes the internal URI of the preview tab.
      await vscode.env.clipboard.writeText('');
      const previewUri = vscode.Uri.parse('webview-panel:webview-panel/webview-markdown.preview-test');
      await vscode.commands.executeCommand('teamSync.markdown.copyAsHtml', previewUri);
      assert.equal(await vscode.env.clipboard.readText(), '<p>Vorschau mit „Zitat“</p>\n');
    },
  ],
  [
    'sync writes team settings and resets dropped ones',
    async () => {
      let body = JSON.stringify({ version: 1, settings: { 'editor.tabSize': 7, 'editor.wordWrap': 'on' } });
      const server: Server = createServer((_request, response) => response.end(body));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const editorConfig = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('editor');
      try {
        await vscode.workspace
          .getConfiguration('teamSync')
          .update('configUrl', `http://127.0.0.1:${port}/team-config.json`, vscode.ConfigurationTarget.Global);
        await waitFor(() => editorConfig().inspect('tabSize')?.globalValue === 7);
        assert.equal(editorConfig().inspect('wordWrap')?.globalValue, 'on');

        body = JSON.stringify({ version: 2, settings: { 'editor.tabSize': 7 } });
        await vscode.commands.executeCommand('teamSync.syncNow');
        await waitFor(() => editorConfig().inspect('wordWrap')?.globalValue === undefined);
        assert.equal(editorConfig().inspect('tabSize')?.globalValue, 7);
      } finally {
        server.close();
        await vscode.workspace.getConfiguration('teamSync').update('configUrl', undefined, vscode.ConfigurationTarget.Global);
      }
    },
  ],
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('marnis-tech.team-sync');
  assert.ok(extension, 'extension not found');
  await extension.activate();

  const failures: string[] = [];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Revert first, closing a modified untitled editor would open a save dialog.
      for (let i = 0; i < 20 && vscode.window.activeTextEditor; i++) {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    }
  }
  console.log(`\n${tests.length - failures.length}/${tests.length} integration tests passed`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} integration test(s) failed`);
  }
}
