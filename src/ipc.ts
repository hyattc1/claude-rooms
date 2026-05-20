// Newline-delimited JSON-RPC over a Unix domain socket (POSIX) or named pipe
// (Windows). Used for hook-to-MCP-server communication within the same
// Claude Code session.
//
// Discovery (per the plan, Section 2):
//   - The MCP server publishes its socket path into two registry files:
//       ${CLAUDE_PLUGIN_DATA}/sockets/by-ppid-<process.ppid>.json
//       ${CLAUDE_PLUGIN_DATA}/sockets/by-session-<session_id>.json
//   - Hooks share PPID with the MCP server (both are direct children of
//     Claude Code), so they can look up by-ppid immediately on first call.
//   - Slash commands run inside the Bash tool and do NOT share PPID; they
//     use CLAUDE_CODE_SESSION_ID from env to look up by-session.
//   - The MCP server only knows its own session id once the first hook
//     tells it (the env var inherited by an MCP subprocess can be stale
//     from a parent Claude Code instance, confirmed by Phase 0 Spike).
//
// Wire protocol: newline-delimited JSON, one request or response per line.
// Request:  {"id": "1", "method": "get_state", "params": {...}}
// Response: {"id": "1", "result": ...}  or  {"id": "1", "error": "msg"}

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { createServer, createConnection, type Server as NetServer, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";

const IS_WINDOWS = platform() === "win32";

function dataDir(): string {
  const env = process.env.CLAUDE_PLUGIN_DATA;
  if (env) return env;
  return join(homedir(), ".claude", "plugins", "data", "claude-rooms-fallback");
}

function socketsDir(): string {
  return join(dataDir(), "sockets");
}

function manifestByPpid(ppid: number): string {
  return join(socketsDir(), `by-ppid-${ppid}.json`);
}

function manifestBySession(sessionId: string): string {
  if (!/^[A-Za-z0-9_.\-]+$/.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
  return join(socketsDir(), `by-session-${sessionId}.json`);
}

function manifestByCwdHash(cwd: string): string {
  const h = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(socketsDir(), `by-cwd-${h}.json`);
}

// Compute an MCP-side socket path. On POSIX, the socket lives inside
// CLAUDE_PLUGIN_DATA. On Windows, we use a \\.\pipe\ path.
//
// POSIX socket paths have an OS-enforced length limit (~104 chars on macOS,
// ~108 on Linux). CLAUDE_PLUGIN_DATA paths inside the user's home dir can be
// long. If we exceed the limit, we fall back to a path under os.tmpdir().
function chooseSocketPath(): string {
  if (IS_WINDOWS) {
    const id = randomBytes(8).toString("hex");
    return `\\\\.\\pipe\\claude-rooms-${process.pid}-${id}`;
  }
  const dir = socketsDir();
  const ideal = join(dir, `mcp-${process.pid}.sock`);
  if (ideal.length <= 100) return ideal;
  // Fallback: short path under tmp, still unique per process.
  return join(tmpdir(), `cr-${process.pid}.sock`);
}

interface SocketManifest {
  socket_path: string;
  mcp_pid: number;
  started_at_ms: number;
}

type Handler = (params: unknown) => Promise<unknown> | unknown;

export interface RpcServerOpts {
  /** Called when the first client identifies its session id, so the server
   *  can publish the by-session registry entry. May fire more than once if
   *  multiple sessions ever share an MCP (they should not, but we handle it). */
  onSessionIdLearned?(sessionId: string): void;
}

export class IpcServer {
  private server: NetServer | null = null;
  private socketPath: string;
  private handlers = new Map<string, Handler>();
  private opts: RpcServerOpts;
  private learnedSessionIds = new Set<string>();
  private connectedClients = new Set<Socket>();

  constructor(opts: RpcServerOpts = {}) {
    this.opts = opts;
    this.socketPath = chooseSocketPath();
  }

  on<T = unknown, R = unknown>(method: string, handler: (params: T) => Promise<R> | R): void {
    this.handlers.set(method, handler as Handler);
  }

  async start(): Promise<void> {
    mkdirSync(socketsDir(), { recursive: true });
    if (!IS_WINDOWS) {
      // Remove any stale socket file from a prior crashed run.
      try { unlinkSync(this.socketPath); } catch { /* not present */ }
    }
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((sock) => this.handleClient(sock));
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    this.publishByPpid();
    // Best-effort registry entry keyed on the cwd-hash of the MCP's process,
    // so slash commands have a discovery path even if no hook has ever
    // identified the session yet.
    this.publishByCwdHash();
  }

  private publishByPpid(): void {
    const manifest: SocketManifest = {
      socket_path: this.socketPath,
      mcp_pid: process.pid,
      started_at_ms: Date.now(),
    };
    const p = manifestByPpid(process.ppid);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  private publishByCwdHash(): void {
    const manifest: SocketManifest = {
      socket_path: this.socketPath,
      mcp_pid: process.pid,
      started_at_ms: Date.now(),
    };
    const p = manifestByCwdHash(process.cwd());
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  publishBySession(sessionId: string): void {
    if (this.learnedSessionIds.has(sessionId)) return;
    this.learnedSessionIds.add(sessionId);
    const manifest: SocketManifest = {
      socket_path: this.socketPath,
      mcp_pid: process.pid,
      started_at_ms: Date.now(),
    };
    const p = manifestBySession(sessionId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
    this.opts.onSessionIdLearned?.(sessionId);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    // Clean up sockets and registry entries.
    try { unlinkSync(manifestByPpid(process.ppid)); } catch { /* ignore */ }
    for (const sid of this.learnedSessionIds) {
      try { unlinkSync(manifestBySession(sid)); } catch { /* ignore */ }
    }
    try { unlinkSync(manifestByCwdHash(process.cwd())); } catch { /* ignore */ }
    if (!IS_WINDOWS) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
    for (const sock of this.connectedClients) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    this.connectedClients.clear();
  }

  private handleClient(sock: Socket): void {
    this.connectedClients.add(sock);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        this.dispatch(sock, line);
      }
    });
    sock.on("close", () => {
      this.connectedClients.delete(sock);
    });
    sock.on("error", () => {
      this.connectedClients.delete(sock);
    });
  }

  private async dispatch(sock: Socket, line: string): Promise<void> {
    let msg: { id?: string; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      // Malformed line, ignore.
      return;
    }
    const id = msg.id;
    const method = msg.method;
    const params = msg.params;
    if (typeof method !== "string") {
      if (id != null) sock.write(JSON.stringify({ id, error: "missing method" }) + "\n");
      return;
    }
    const handler = this.handlers.get(method);
    if (!handler) {
      if (id != null) sock.write(JSON.stringify({ id, error: `unknown method: ${method}` }) + "\n");
      return;
    }
    try {
      const result = await handler(params);
      if (id != null) sock.write(JSON.stringify({ id, result }) + "\n");
    } catch (e) {
      if (id != null) sock.write(JSON.stringify({ id, error: String(e) }) + "\n");
    }
  }
}

// ---------- Client side ----------

interface IpcClientOpts {
  sessionId?: string;
  ppid?: number;
  cwdForFallback?: string;
}

function readManifest(p: string): SocketManifest | null {
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as SocketManifest;
    if (typeof parsed.socket_path !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // ESRCH = no such process. EPERM = exists but we can't signal it (still alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function discoverSocketPath(opts: IpcClientOpts): string | null {
  if (opts.sessionId) {
    const m = readManifest(manifestBySession(opts.sessionId));
    if (m && isAlive(m.mcp_pid)) return m.socket_path;
  }
  if (opts.ppid != null) {
    const m = readManifest(manifestByPpid(opts.ppid));
    if (m && isAlive(m.mcp_pid)) return m.socket_path;
  }
  if (opts.cwdForFallback) {
    const m = readManifest(manifestByCwdHash(opts.cwdForFallback));
    if (m && isAlive(m.mcp_pid)) return m.socket_path;
  }
  return null;
}

// Best-effort scan: if explicit lookups fail, walk the sockets directory and
// return the first alive manifest. Useful when a slash command runs in a
// new project subdir where cwd-hash does not match.
export function discoverAnyAliveSocket(): string | null {
  try {
    const entries = readdirSync(socketsDir());
    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      const m = readManifest(join(socketsDir(), e));
      if (m && isAlive(m.mcp_pid)) return m.socket_path;
    }
  } catch {
    // ignore
  }
  return null;
}

export class IpcClient {
  private sock: Socket | null = null;
  private inbox = new Map<string, (res: { result?: unknown; error?: string }) => void>();
  private nextId = 1;
  private buf = "";
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(timeoutMs = 1500): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      const onErr = (e: Error) => { sock.destroy(); reject(e); };
      const t = setTimeout(() => onErr(new Error(`connect timeout ${this.socketPath}`)), timeoutMs);
      sock.once("connect", () => {
        clearTimeout(t);
        sock.off("error", onErr);
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string) => this.onData(chunk));
        sock.on("close", () => { this.sock = null; });
        this.sock = sock;
        resolve();
      });
      sock.once("error", onErr);
    });
  }

  close(): void {
    if (this.sock) {
      try { this.sock.destroy(); } catch { /* ignore */ }
      this.sock = null;
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: string; result?: unknown; error?: string };
        if (msg.id && this.inbox.has(msg.id)) {
          const cb = this.inbox.get(msg.id)!;
          this.inbox.delete(msg.id);
          cb({ result: msg.result, error: msg.error });
        }
      } catch {
        // ignore malformed
      }
    }
  }

  call<R = unknown>(method: string, params?: unknown, timeoutMs = 3000): Promise<R> {
    if (!this.sock) return Promise.reject(new Error("not connected"));
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<R>((resolve, reject) => {
      const t = setTimeout(() => {
        this.inbox.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.inbox.set(id, ({ result, error }) => {
        clearTimeout(t);
        if (error) reject(new Error(error));
        else resolve(result as R);
      });
      this.sock!.write(payload);
    });
  }
}

// Convenience: discover, connect, call, close. For one-shot tools like
// slash commands and hooks. Returns null when MCP is not reachable so
// callers can fail open.
export async function callOnce<R = unknown>(
  method: string,
  params: unknown,
  discovery: IpcClientOpts,
  timeoutMs = 1500
): Promise<R | null> {
  const path = discoverSocketPath(discovery) ?? discoverAnyAliveSocket();
  if (!path) return null;
  const c = new IpcClient(path);
  try {
    await c.connect(timeoutMs);
    return await c.call<R>(method, params, timeoutMs);
  } catch {
    return null;
  } finally {
    c.close();
  }
}
