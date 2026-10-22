import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { UsageHistory, addTotals, emptyTotals, finishTotals, recordTotals, sortByVolume, type BucketTotals, type SummaryBucket, type UsageSummary } from "./usage-history.ts";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_CARRY = 64 * 1024;

export type RequestUsage = {
  input: number;
  cached: number;
  cacheWrite?: number;
  output: number;
};

export type RequestRecord = {
  id: string;
  at: string;
  ms: number;
  status: number | string;
  ok: boolean;
  kind: "messages" | "count_tokens" | "other" | "image";
  source: string;
  target: string;
  provider: string;
  effort?: string;
  upstreamRequestId?: string;
  messageId?: string;
  upstreamCalled?: false;
  refusal?: "thread-continue" | "drain" | "unroutable" | "no-account" | "unknown-provider" | "web-search-unsupported" | "prompt-incompatible";
  purpose?: "auto-mode-classifier" | "web-search" | "web-fetch";
  requestedTier?: string;
  servedTier?: string;
  stopReason?: string;
  usage?: RequestUsage;
  note?: string;
  stream: boolean;
  /**
   * The Claude Code session the request came from: its `X-Claude-Code-Session-Id` header (sent on
   * every `/v1/messages`, the session's own id — captured from CLI 2.1.286, 2026-10-05). Lets a
   * session ask what happened to its own requests.
   */
  session?: string;
  /**
   * The request was made inside a subagent: Claude Code names the agent in the
   * `x-claude-code-agent-id` header, and only a subagent's request carries it (CLI 2.1.304).
   * Absent on a main session's own turns. Recorded for every provider, so the header's arrival
   * can be measured rather than assumed.
   */
  subagent?: true;
  /**
   * Not ok, but the client sends the request again on its own and nothing is lost: a thread the
   * API forgot, a stateless resend asked for, a refusal during a restart. Shown apart from failures
   * so they do not read as errors.
   */
  resent?: true;
};

/** A kind or a set of kinds; a record matches any of them. */
type RequestFilter = { provider?: string; kind?: RequestRecord["kind"] | RequestRecord["kind"][]; session?: string };

export type RequestSummary = { total: SummaryBucket; providers: Record<string, SummaryBucket>; models: (SummaryBucket & { provider: string; model: string })[] };
export type { SummaryBucket };

function isRecord(value: unknown): value is RequestRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<RequestRecord>;
  return typeof r.id === "string" && typeof r.at === "string" && typeof r.ms === "number" && typeof r.ok === "boolean" &&
    (r.kind === "messages" || r.kind === "count_tokens" || r.kind === "other" || r.kind === "image") && typeof r.source === "string" &&
    typeof r.target === "string" && typeof r.provider === "string" && typeof r.stream === "boolean";
}

/** Bounded request history, persisted as JSONL so a router restart preserves recent entries. */
export class RequestLog {
  private readonly file: string;
  private readonly max: number;
  private readonly maxBytes: number;
  private records: RequestRecord[];
  private readonly history: UsageHistory;

  constructor(file: string, max = 2000, maxBytes = DEFAULT_MAX_BYTES) {
    this.file = file;
    this.max = max;
    this.maxBytes = maxBytes;
    const persisted = this.readRecords(this.file);
    this.records = persisted.slice(-this.max);
    this.history = new UsageHistory(path.join(path.dirname(file), "usage-hourly.jsonl"));
    // Replay what the history has not seen yet: the `.1` file first when it may hold a record above
    // the watermark, so the first run backfills both files. Its mtime is its last append, and a
    // record starts before it is written, so an mtime at or below the watermark hour rules it out;
    // the first record of requests.jsonl does not, since a long request that straddled the rotation
    // starts earlier than records left in `.1`. The history skips everything at or below its
    // watermark, so a restart counts no hour twice.
    const watermark = this.history.watermark;
    const rotatedHour = usageHourOfFile(`${file}.1`);
    const replay = rotatedHour !== null && (watermark === null || rotatedHour > watermark)
      ? [...this.readRecords(`${file}.1`), ...persisted]
      : persisted;
    this.history.replay(replay);
  }

  add(record: RequestRecord): void {
    this.history.add(record);
    this.records.push(record);
    if (this.records.length > this.max) this.records.splice(0, this.records.length - this.max);
    const line = JSON.stringify(record) + "\n";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const bytes = Buffer.byteLength(line);
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size > 0 && size + bytes > this.maxBytes) {
        const previous = `${this.file}.1`;
        fs.rmSync(previous, { force: true });
        fs.renameSync(this.file, previous);
      }
      fs.appendFileSync(this.file, line, "utf8");
    } catch {
      // Request logging must never alter the proxy response path.
    }
  }

  list(n: number, filter: RequestFilter = {}): RequestRecord[] {
    const limit = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    const kind = filter.kind === undefined ? undefined : Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    const out: RequestRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const record = this.records[i]!;
      if (filter.provider && record.provider !== filter.provider) continue;
      if (kind && !kind.includes(record.kind)) continue;
      if (filter.session && record.session !== filter.session) continue;
      out.push(record);
    }
    return out;
  }

  /** Summarise records at or after an epoch timestamp in milliseconds. */
  summary(sinceMs: number): RequestSummary {
    const total = emptyTotals();
    const providers = new Map<string, BucketTotals>();
    const models = new Map<string, { totals: BucketTotals; provider: string; model: string }>();
    for (const record of this.records) {
      const at = Date.parse(record.at);
      if (!Number.isFinite(at) || at < sinceMs) continue;
      const provider = providers.get(record.provider) ?? providers.set(record.provider, emptyTotals()).get(record.provider)!;
      const key = `${record.provider}\u0000${record.target}`;
      const model = models.get(key) ?? models.set(key, { totals: emptyTotals(), provider: record.provider, model: record.target }).get(key)!;
      for (const bucket of [total, provider, model.totals]) addTotals(bucket, recordTotals(record));
    }
    const modelsList = [...models.values()].map(({ totals, provider, model }) => ({ ...finishTotals(totals), provider, model }));
    sortByVolume(modelsList);
    return {
      total: finishTotals(total),
      providers: Object.fromEntries([...providers].map(([name, totals]) => [name, finishTotals(totals)])),
      models: modelsList,
    };
  }

  /** Durable hourly usage over [fromMs, toMs), beyond the in-memory ring. */
  usage(fromMs: number, toMs: number): UsageSummary {
    return this.history.summary(fromMs, toMs);
  }

  private readRecords(file: string): RequestRecord[] {
    try {
      return fs.readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            const parsed: unknown = JSON.parse(line);
            return isRecord(parsed) ? [parsed] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }
}

/** The hour of a file's last write, or null when it does not exist. */
function usageHourOfFile(file: string): number | null {
  try {
    return Math.floor(fs.statSync(file).mtimeMs / 3_600_000);
  } catch {
    return null;
  }
}

export type ObservedResponse = { usage?: RequestUsage; stopReason?: string; messageId?: string; servedTier?: string };

/**
 * Observes an Anthropic-compatible response without retaining or modifying its bytes.
 * Call feed() after forwarding each response chunk, then finish() on response end.
 */
export class ResponseUsageTap {
  private readonly isSse: boolean;
  private readonly decoder = new TextDecoder();
  private carry = "";
  private skipSseLine = false;
  private event = "";
  private data: string[] = [];
  private dropUntilNewline = false;
  private jsonUsageStarted = false;
  private jsonUsageDepth = 0;
  private jsonUsageText = "";
  private stopCarry = "";
  private stopReason: string | undefined;
  private messageId: string | undefined;
  private servedTier: string | undefined;
  private jsonDepth = 0;
  private jsonString: string | null = null;
  private jsonEscaped = false;
  private jsonKey: string | undefined;
  private jsonValue = false;
  private usage: RequestUsage | undefined;

  // Compressed responses (Anthropic answers the CLI with gzip/br) are collected side-band up to a cap
  // and inflated once at the end; the forwarded bytes are never touched.
  private readonly encoding: "gzip" | "deflate" | "br" | "zstd" | null = null;
  private encodedChunks: Buffer[] = [];
  private encodedBytes = 0;
  private static readonly MAX_ENCODED = 16 * 1024 * 1024;

  constructor(contentType: string | undefined, contentEncoding: string | undefined) {
    this.isSse = /^text\/event-stream\b/i.test(contentType ?? "");
    const enc = (contentEncoding ?? "").toLowerCase().trim();
    if (enc === "" || enc === "identity") this.encoding = null;
    else if (enc === "gzip" || enc === "x-gzip") this.encoding = "gzip";
    else if (enc === "deflate") this.encoding = "deflate";
    else if (enc === "br") this.encoding = "br";
    else if (enc === "zstd" && typeof (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function") this.encoding = "zstd";
    else this.dropUntilNewline = true; // unknown encoding: observe nothing
  }

  get enabled(): boolean {
    return !this.dropUntilNewline;
  }

  feed(chunk: Buffer): void {
    if (!this.enabled) return;
    if (this.encoding) {
      if (this.encodedBytes + chunk.length > ResponseUsageTap.MAX_ENCODED) {
        this.dropUntilNewline = true;
        this.encodedChunks = [];
        return;
      }
      this.encodedChunks.push(chunk);
      this.encodedBytes += chunk.length;
      return;
    }
    const text = this.decoder.decode(chunk, { stream: true });
    if (this.isSse) this.feedSse(text);
    else this.feedJson(text);
  }

  finish(): ObservedResponse {
    if (!this.enabled) return {};
    if (this.encoding) {
      let plain: Buffer;
      try {
        const all = Buffer.concat(this.encodedChunks);
        plain =
          this.encoding === "gzip" ? zlib.gunzipSync(all)
          : this.encoding === "deflate" ? zlib.inflateSync(all)
          : this.encoding === "br" ? zlib.brotliDecompressSync(all)
          : (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(all);
      } catch {
        return {};
      }
      this.encodedChunks = [];
      const text = plain.toString("utf8");
      if (this.isSse) this.feedSse(text);
      else this.feedJson(text);
    }
    const tail = this.decoder.decode();
    if (tail) {
      if (this.isSse) this.feedSse(tail);
      else this.feedJson(tail);
    }
    if (this.isSse && this.carry) this.feedSse("\n");
    return {
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      ...(this.messageId !== undefined ? { messageId: this.messageId } : {}),
      ...(this.servedTier !== undefined ? { servedTier: this.servedTier } : {}),
    };
  }

  // Complete lines are consumed before the cap applies, so an inflated body or one large chunk keeps
  // its events; only an unfinished line longer than the cap is dropped, along with its later bytes.
  private feedSse(text: string): void {
    const buffer = this.carry + text;
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf("\n", start);
      if (newline < 0) break;
      const raw = buffer.slice(start, newline);
      start = newline + 1;
      if (this.skipSseLine) {
        this.skipSseLine = false;
        continue;
      }
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") {
        this.consumeSseEvent();
        this.event = "";
        this.data = [];
      } else if (line.startsWith("event:")) {
        this.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).trimStart());
      }
    }
    this.carry = buffer.slice(start);
    if (this.carry.length > MAX_CARRY) {
      this.carry = "";
      this.skipSseLine = true;
      this.event = "";
      this.data = [];
    }
  }

  private consumeSseEvent(): void {
    if (!this.data.length) return;
    try {
      const body = JSON.parse(this.data.join("\n")) as Record<string, unknown>;
      if (this.event === "message_start" || body.type === "message_start") {
        const message = body.message as { id?: unknown; usage?: unknown } | undefined;
        if (typeof message?.id === "string") this.messageId = message.id;
        this.setUsage(message?.usage);
      } else if (this.event === "message_delta" || body.type === "message_delta") {
        this.setUsage(body.usage);
        const delta = body.delta as { stop_reason?: unknown } | undefined;
        if (typeof delta?.stop_reason === "string") this.stopReason = delta.stop_reason;
      }
    } catch {
      // A malformed upstream event is not a proxy error and must not affect delivery.
    }
  }

  private feedJson(text: string): void {
    // Read only the top-level id, never an id quoted in content or a tool input.
    for (const char of text) {
      if (this.jsonString !== null) {
        if (this.jsonString.length < 256) this.jsonString += char;
        if (this.jsonEscaped) this.jsonEscaped = false;
        else if (char === "\\") this.jsonEscaped = true;
        else if (char === '"') {
          if (this.jsonDepth === 1) {
            try {
              const value: unknown = JSON.parse(this.jsonString);
              if (!this.jsonValue && typeof value === "string") this.jsonKey = value;
              else if (this.jsonKey === "id" && typeof value === "string") this.messageId = value;
            } catch { /* oversized or malformed string */ }
          }
          this.jsonString = null;
        }
      } else if (char === '"') this.jsonString = '"';
      else if (char === "{" || char === "[") this.jsonDepth++;
      else if (char === "}" || char === "]") this.jsonDepth--;
      else if (this.jsonDepth === 1 && char === ":") this.jsonValue = true;
      else if (this.jsonDepth === 1 && char === ",") { this.jsonValue = false; this.jsonKey = undefined; }
    }
    this.carry += text;
    this.stopCarry = (this.stopCarry + text).slice(-MAX_CARRY);
    const stop = /"stop_reason"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(this.stopCarry);
    if (stop) {
      try { this.stopReason = JSON.parse(`"${stop[1]}"`) as string; } catch { /* ignore */ }
    }
    if (!this.jsonUsageStarted) {
      const match = /"usage"\s*:\s*\{/.exec(this.carry);
      if (!match) {
        if (this.carry.length > MAX_CARRY) this.carry = this.carry.slice(-MAX_CARRY);
        return;
      }
      this.jsonUsageStarted = true;
      const start = (match.index ?? 0) + match[0].lastIndexOf("{");
      this.jsonUsageText = this.carry.slice(start);
      this.carry = "";
      this.jsonUsageDepth = 0;
    } else {
      this.jsonUsageText += this.carry;
      this.carry = "";
    }
    if (this.jsonUsageText.length > MAX_CARRY) {
      this.jsonUsageStarted = false;
      this.jsonUsageText = "";
      return;
    }
    this.jsonUsageDepth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < this.jsonUsageText.length; i++) {
      const char = this.jsonUsageText[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") this.jsonUsageDepth++;
      else if (char === "}" && --this.jsonUsageDepth === 0) {
        try { this.setUsage(JSON.parse(this.jsonUsageText.slice(0, i + 1)) as unknown); } catch { /* ignore */ }
        this.jsonUsageStarted = false;
        this.jsonUsageText = "";
        return;
      }
    }
  }

  private setUsage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const usage = value as Record<string, unknown>;
    if (typeof usage.service_tier === "string") this.servedTier = usage.service_tier;
    const number = (key: string): number => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? Math.max(0, usage[key] as number) : 0;
    if (!("input_tokens" in usage || "output_tokens" in usage || "cache_read_input_tokens" in usage || "cache_creation_input_tokens" in usage)) return;
    const current = this.usage ?? { input: 0, cached: 0, output: 0 };
    const input = "input_tokens" in usage ? number("input_tokens") : current.input;
    const cached = "cache_read_input_tokens" in usage ? number("cache_read_input_tokens") : current.cached;
    const cacheWrite = "cache_creation_input_tokens" in usage
      ? typeof usage.cache_creation_input_tokens === "number" && Number.isFinite(usage.cache_creation_input_tokens) ? number("cache_creation_input_tokens") : undefined
      : current.cacheWrite;
    const output = "output_tokens" in usage ? number("output_tokens") : current.output;
    this.usage = { input, cached, ...(cacheWrite !== undefined ? { cacheWrite } : {}), output };
  }
}

export function requestId(): string {
  return crypto.randomUUID();
}
