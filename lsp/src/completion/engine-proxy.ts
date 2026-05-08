// TS-side client for the BAC completion server that the editor module hosts.
//
// Protocol (NDJSON, see BacCompletionServer.cpp):
//   request:  {"id":"<str>","op":"complete-type","className":"StaticMeshComponent"}
//   response: {"id":"<str>","ok":true,"result":{"functions":[…],"properties":[…]}}
//   error:    {"id":"<str>","ok":false,"error":"…"}
//
// Endpoint discovery: the plugin writes
// `<projectDir>/Saved/BacEditorEndpoint.json` at startup with `{port,pid,…}`
// and removes it on shutdown. We poll the file on a 1s timer, (re)connecting
// when port changes.
//
// Reliability:
//   • Editor not running → no discovery file → `completeType` returns
//     undefined; the LSP gracefully degrades to TS-only completion.
//   • Editor closes mid-session → the socket fires `close`, we drop the
//     connection, the next request triggers a re-discovery attempt.
//   • Cache is invalidated on disconnect (the next editor instance may have
//     different code loaded).

import * as net from 'node:net';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface EngineFunction {
  name:        string;
  displayName?: string;
  isPure:      boolean;
  isLatent:    boolean;
  params:      Array<{ name: string; type: string; isOut: boolean }>;
  returnType?: string;
  category?:   string;
  doc?:        string;
}

export interface EngineProperty {
  name:      string;
  type:      string;
  readOnly:  boolean;
  category?: string;
  doc?:      string;
}

export interface EngineTypeMembers {
  resolvedClassName: string;
  functions:         EngineFunction[];
  properties:        EngineProperty[];
}

interface PendingRequest {
  resolve: (resp: unknown) => void;
  reject:  (err: Error)    => void;
  timer:   NodeJS.Timeout;
}

interface DiscoveryFile {
  version:    number;
  port:       number;
  pid:        number;
  projectDir: string;
}

/** Push-channel payload sent by the plugin's BacSyncSubsystem (no `id`). */
export interface BacSyncEventPayload {
  assetPath: string;
  bacPath?:  string;        // absolute disk path of the .bac, when known
  code:      string;        // BAC24xx
  severity:  'error' | 'warning' | 'info';
  message:   string;
  decision:  string;        // "applied" | "conflict" | "orphan" | …
}

export interface EngineProxyOptions {
  /** Where to look for `Saved/BacEditorEndpoint.json`. Usually the dir of the active `.uproject`. */
  projectDir:    string;
  /** Defaults to 1000ms — how often to poll the discovery file when not connected. */
  discoveryPollMs?: number;
  /** Default request timeout, ms. */
  requestTimeoutMs?: number;
  /** Optional sink for diagnostic logging (LSP `connection.console`). */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Called when the plugin pushes a `bac.sync` event over the open socket. */
  onSyncEvent?: (payload: BacSyncEventPayload) => void;
}

export class BacEngineProxy {
  private readonly opts:           Required<EngineProxyOptions>;
  private readonly endpointPath:   string;
  private socket:                  net.Socket | undefined;
  private connectedPort:           number | undefined;
  private discoveryTimer:          NodeJS.Timeout | undefined;
  private nextRequestId           = 0;
  private readonly pending         = new Map<string, PendingRequest>();
  private readonly typeCache       = new Map<string, EngineTypeMembers>();
  private receiveBuffer            = '';
  private disposed                 = false;

  constructor(opts: EngineProxyOptions) {
    this.opts = {
      projectDir:       opts.projectDir,
      discoveryPollMs:  opts.discoveryPollMs  ?? 1000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 3000,
      log:              opts.log              ?? (() => { /* swallow */ }),
      onSyncEvent:      opts.onSyncEvent      ?? (() => { /* no consumer */ }),
    };
    this.endpointPath = path.join(this.opts.projectDir, 'Saved', 'BacEditorEndpoint.json');
  }

  start(): void {
    if (this.discoveryTimer) { return; }
    void this.tryDiscover();
    this.discoveryTimer = setInterval(() => {
      if (!this.disposed && !this.socket) { void this.tryDiscover(); }
    }, this.opts.discoveryPollMs);
    this.discoveryTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = undefined; }
    this.disconnect(new Error('proxy disposed'));
  }

  /** True if the proxy currently believes it has a usable connection. */
  isConnected(): boolean { return this.socket !== undefined && !this.socket.destroyed; }

  /** Returns members for the given class name, or undefined if no editor is reachable. */
  async completeType(className: string): Promise<EngineTypeMembers | undefined> {
    const cached = this.typeCache.get(className);
    if (cached) { return cached; }
    if (!this.isConnected()) {
      // One discovery attempt before giving up — the editor may have just started.
      await this.tryDiscover();
      if (!this.isConnected()) { return undefined; }
    }
    try {
      const resp = await this.request({ op: 'complete-type', className });
      const body = (resp as { result?: EngineTypeMembers }).result;
      if (body) { this.typeCache.set(className, body); }
      return body;
    } catch (err) {
      this.opts.log('warn', `bac engine: complete-type(${className}) failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async tryDiscover(): Promise<void> {
    if (this.disposed || this.socket) { return; }
    let raw: string;
    try {
      raw = await fsp.readFile(this.endpointPath, 'utf8');
    } catch {
      return;  // file absent → editor not running
    }
    let info: DiscoveryFile;
    try {
      info = JSON.parse(raw) as DiscoveryFile;
    } catch {
      this.opts.log('warn', `bac engine: malformed discovery file at ${this.endpointPath}`);
      return;
    }
    if (typeof info.port !== 'number' || info.port <= 0) { return; }
    // The early `if (this.socket) return` above guarantees we're disconnected
    // here, so just connect — even if the port matches a previous session, the
    // editor process behind it may be new.
    this.connect(info.port);
  }

  private connect(port: number): void {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.setNoDelay(true);
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      this.opts.log('info', `bac engine: connected on 127.0.0.1:${port}`);
      this.connectedPort = port;
    });
    sock.on('data', (chunk: string | Buffer) => {
      this.receiveBuffer += chunk.toString();
      this.drainBuffer();
    });
    sock.on('close', () => {
      this.opts.log('info', 'bac engine: connection closed');
      this.disconnect(new Error('connection closed'));
    });
    sock.on('error', (err) => {
      this.opts.log('warn', `bac engine: socket error: ${err.message}`);
      this.disconnect(err);
    });
    this.socket = sock;
  }

  private disconnect(reason: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    this.typeCache.clear();
    this.connectedPort = undefined;
    if (this.socket) {
      this.socket.removeAllListeners();
      if (!this.socket.destroyed) { this.socket.destroy(); }
      this.socket = undefined;
    }
  }

  private drainBuffer(): void {
    while (true) {
      const nl = this.receiveBuffer.indexOf('\n');
      if (nl < 0) { return; }
      const line = this.receiveBuffer.slice(0, nl);
      this.receiveBuffer = this.receiveBuffer.slice(nl + 1);
      if (line.trim().length === 0) { continue; }
      let parsed: { id?: string; ok?: boolean; error?: string; event?: string; payload?: unknown } & Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.opts.log('warn', `bac engine: malformed response: ${line.slice(0, 200)}`);
        continue;
      }
      // Server-initiated push (no `id`, has `event`).
      if (typeof parsed.event === 'string') {
        if (parsed.event === 'bac.sync' && parsed.payload && typeof parsed.payload === 'object') {
          this.opts.onSyncEvent(parsed.payload as BacSyncEventPayload);
        }
        continue;
      }
      const id = parsed.id;
      if (typeof id !== 'string') { continue; }
      const pend = this.pending.get(id);
      if (!pend) { continue; }
      this.pending.delete(id);
      clearTimeout(pend.timer);
      if (parsed.ok === false) {
        pend.reject(new Error(parsed.error ?? 'engine returned ok:false'));
      } else {
        pend.resolve(parsed);
      }
    }
  }

  private request(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) { reject(new Error('not connected')); return; }
      const id = String(this.nextRequestId++);
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request timed out (${this.opts.requestTimeoutMs}ms)`));
        }
      }, this.opts.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const json = JSON.stringify({ id, ...payload });
      this.socket.write(json + '\n');
    });
  }
}
