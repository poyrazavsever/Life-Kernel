import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface McpSession { transport: StreamableHTTPServerTransport; clientId: string }
interface Entry extends McpSession { lastSeen: number }

export interface SessionOptions {
  /** A session with no request for this long is closed. */
  idleMs?: number;
  /** The least recently used session is closed when a new one would exceed this. */
  max?: number;
  now?: () => number;
}

/**
 * The open MCP sessions. A session belongs to the client that created it, and an abandoned one must not
 * stay in memory forever: idle sessions are closed, and the table has an upper bound. Closing a session is
 * safe because a client that gets a 404 for its session ID initializes a new one.
 */
export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(options: SessionOptions = {}) {
    this.idleMs = options.idleMs ?? 30 * 60 * 1000;
    this.max = options.max ?? 100;
    this.now = options.now ?? Date.now;
  }

  get size(): number { return this.entries.size; }

  /** The session for an ID, marked as just used; undefined when it never existed, expired, or was closed. */
  get(id: string): McpSession | undefined {
    this.sweep();
    const entry = this.entries.get(id);
    if (entry) entry.lastSeen = this.now();
    return entry;
  }

  add(id: string, session: McpSession): void {
    this.sweep();
    while (this.entries.size >= this.max) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]!;
      this.close(oldest[0]);
    }
    this.entries.set(id, { ...session, lastSeen: this.now() });
  }

  /** Forget a session whose transport already closed. */
  remove(id: string): void { this.entries.delete(id); }

  private sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, entry] of this.entries) if (entry.lastSeen < cutoff) this.close(id);
  }

  private close(id: string): void {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    entry?.transport.close().catch(() => undefined);
  }
}
