// VS Code BAC extension. Launches the bundled `bac-language-server` over
// stdio and connects it as the language server for `.bac` files.

import * as path from 'node:path';
import * as fs   from 'node:fs';
import { ExtensionContext, workspace, window } from 'vscode';
import {
  LanguageClient, LanguageClientOptions, ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  // The LSP server ships next to the extension — `editors/code/` (the extension
  // root) sits next to `lsp/out/server.js` in this monorepo. We resolve up one
  // level and into `lsp/out` for development; once published we'll re-bundle.
  const serverEntry = resolveServerEntry(context);
  if (!serverEntry) {
    window.showWarningMessage(
      'BAC: language server not found. Highlighting still works; diagnostics are disabled.\n' +
      'Build the LSP with `npm run build` in vscode-bac/lsp/.',
    );
    return;
  }

  const serverOptions: ServerOptions = {
    run:   { module: serverEntry, transport: TransportKind.ipc },
    debug: { module: serverEntry, transport: TransportKind.ipc, options: { execArgv: ['--inspect=6009'] } },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'bac' }],
    synchronize: {
      configurationSection: 'bac',
      fileEvents: workspace.createFileSystemWatcher('**/*.bac'),
    },
  };

  client = new LanguageClient(
    'bac',
    'Blueprint as Code',
    serverOptions,
    clientOptions,
  );
  await client.start();
  context.subscriptions.push({ dispose: () => client?.stop() });
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

function resolveServerEntry(context: ExtensionContext): string | undefined {
  // Dev layout: <repo>/editors/code/  →  <repo>/lsp/out/server.js
  const dev = path.resolve(context.extensionPath, '..', '..', 'lsp', 'out', 'server.js');
  if (fs.existsSync(dev)) { return dev; }
  // Bundled layout (future): server.js shipped under server/ inside the VSIX.
  const bundled = path.join(context.extensionPath, 'server', 'server.js');
  if (fs.existsSync(bundled)) { return bundled; }
  return undefined;
}
