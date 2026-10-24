import fs from "node:fs";
import path from "node:path";
import type { RequestRecord } from "./requestlog.ts";

const HOUR_MS = 3_600_000;

export type SummaryBucket = {
  count: number;
  ok: number;
  failed: number;
  input: number;
  cached: number;
  /** Tokens written to the prompt cache: part of the input, and not a hit. */
  cacheWrite: number;
  output: number;
  cacheHitPercent: number;
  avgMs: number;
};

export type ModelUsageBucket = SummaryBucket & { provider: string; model: string };

/** The part of a bucket that is summed across records and hours; `ms` is the sum of durations. */
export type BucketTotals = {
  count: number;
  ok: number;
  failed: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  ms: number;
};

export type UsageSummary = {
  total: SummaryBucket;
  providers: Record<string, SummaryBucket>;
  models: ModelUsageBucket[];
  earliest: string | null;
};

/** One persisted line: a partial bucket for (hour, provider, model). Lines are additive. */
type HourBucket = BucketTotals & { h: number; p: string; m: string };

export function emptyTotals(): BucketTotals {
  return { count: 0, ok: 0, failed: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, ms: 0 };
}

/** The same counting rules as `RequestLog.summary`, for one record. */
export function recordTotals(record: RequestRecord): BucketTotals {
  const totals = emptyTotals();
  totals.count = 1;
  if (record.ok) totals.ok = 1;
  else if (!record.resent) totals.failed = 1;
  totals.ms = record.ms;
  if (record.usage) {
    totals.input = record.usage.input;
    totals.cached = record.usage.cached;
    totals.cacheWrite = record.usage.cacheWrite ?? 0;
    totals.output = record.usage.output;
  }
  return totals;
}

export function addTotals(target: BucketTotals, source: BucketTotals): void {
  target.count += source.count;
  target.ok += source.ok;
  target.failed += source.failed;
  target.input += source.input;
  target.cached += source.cached;
  target.cacheWrite += source.cacheWrite;
  target.output += source.output;
  target.ms += source.ms;
}

/** Derives the rate columns from summed totals. A cache write is input the model read fresh, so it
 * counts against the hit rate (leaving it out read a turn that wrote 2,218 tokens and uncached 2 as
 * a 100% hit, 2026-09-23). */
export function finishTotals(totals: BucketTotals): SummaryBucket {
  const base = totals.input + totals.cached + totals.cacheWrite;
  return {
    count: totals.count,
    ok: totals.ok,
    failed: totals.failed,
    input: totals.input,
    cached: totals.cached,
    cacheWrite: totals.cacheWrite,
    output: totals.output,
    cacheHitPercent: base > 0 ? Math.round((totals.cached / base) * 1000) / 10 : 0,
    avgMs: totals.count > 0 ? Math.round(totals.ms / totals.count) : 0,
  };
}

function bucketKey(h: number, provider: string, model: string): string {
  return `${h}\u0000${provider}\u0000${model}`;
}

function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/** Models with the most tokens read first (input + cached + cacheWrite), then the busiest. */
export function sortByVolume<T extends SummaryBucket & { provider: string; model: string }>(models: T[]): void {
  const volume = (bucket: SummaryBucket): number => bucket.input + bucket.cached + bucket.cacheWrite;
  models.sort((a, b) => volume(b) - volume(a) || b.count - a.count);
}

function isHourBucket(value: unknown): value is HourBucket {
  if (!value || typeof value !== "object") return false;
  const b = value as Partial<HourBucket>;
  return typeof b.h === "number" && Number.isFinite(b.h) && Number.isInteger(b.h) &&
    typeof b.p === "string" && typeof b.m === "string" &&
    ["count", "ok", "failed", "input", "cached", "cacheWrite", "output", "ms"].every((key) => {
      const n = (b as unknown as Record<string, unknown>)[key];
      return typeof n === "number" && Number.isFinite(n);
    });
}

function toLine(bucket: HourBucket): string {
  return JSON.stringify({
    h: bucket.h,
    p: bucket.p,
    m: bucket.m,
    count: bucket.count,
    ok: bucket.ok,
    failed: bucket.failed,
    input: bucket.input,
    cached: bucket.cached,
    cacheWrite: bucket.cacheWrite,
    output: bucket.output,
    ms: bucket.ms,
  }) + "\n";
}

/**
 * Durable hourly usage history, appended to `usage-hourly.jsonl` next to `requests.jsonl`.
 *
 * Invariant: every hour below the open hour is fully on disk (possibly as several additive lines
 * for the same (h,p,m)); only the open hour lives in memory. A late record (its hour is below the
 * open hour because a request started earlier and finished later) is appended immediately as its
 * own line. On startup the file's highest hour is the watermark, and request records above it are
 * replayed, so an hour never counted twice yet the open hour survives a restart.
 */
export class UsageHistory {
  private readonly file: string;
  private readonly buckets = new Map<string, HourBucket>();
  private readonly open = new Map<string, HourBucket>();
  private openHour: number | null = null;
  private highestHour: number | null = null;
  private earliestHour: number | null = null;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  /** Highest hour already on disk, or null when nothing was persisted yet. */
  get watermark(): number | null {
    return this.highestHour;
  }

  /** Feeds startup replay: records at or below the watermark are already on disk. */
  replay(records: RequestRecord[]): void {
    const floor = this.highestHour;
    for (const record of records) {
      const hour = hourOf(record);
      if (hour === null) continue;
      if (floor !== null && hour <= floor) continue;
      this.add(record);
    }
  }

  add(record: RequestRecord): void {
    const hour = hourOf(record);
    if (hour === null) return;
    this.observe(hour);
    const bucket: HourBucket = { h: hour, p: record.provider, m: record.target, ...recordTotals(record) };
    if (this.openHour !== null && hour < this.openHour) {
      this.append([bucket]);
      this.merge(this.buckets, bucket);
      return;
    }
    if (this.openHour === null || hour > this.openHour) {
      this.flush();
      this.openHour = hour;
    }
    this.merge(this.open, bucket);
  }

  /** Buckets whose hour start lies in [fromMs, toMs), summed across providers and models. */
  summary(fromMs: number, toMs: number): UsageSummary {
    const fromHour = Math.floor(fromMs / HOUR_MS);
    const total = emptyTotals();
    const providers = new Map<string, BucketTotals>();
    const models = new Map<string, { totals: BucketTotals; provider: string; model: string }>();
    for (const bucket of [...this.buckets.values(), ...this.open.values()]) {
      if (bucket.h < fromHour || bucket.h * HOUR_MS >= toMs) continue;
      addTotals(total, bucket);
      const provider = providers.get(bucket.p) ?? providers.set(bucket.p, emptyTotals()).get(bucket.p)!;
      addTotals(provider, bucket);
      const key = modelKey(bucket.p, bucket.m);
      const model = models.get(key) ?? (models.set(key, { totals: emptyTotals(), provider: bucket.p, model: bucket.m }).get(key)!);
      addTotals(model.totals, bucket);
    }
    const modelList = [...models.values()].map(({ totals, provider, model }) => ({ ...finishTotals(totals), provider, model }));
    sortByVolume(modelList);
    return {
      total: finishTotals(total),
      providers: Object.fromEntries([...providers].map(([name, totals]) => [name, finishTotals(totals)])),
      models: modelList,
      earliest: this.earliestHour === null ? null : new Date(this.earliestHour * HOUR_MS).toISOString(),
    };
  }

  private observe(hour: number): void {
    if (this.earliestHour === null || hour < this.earliestHour) this.earliestHour = hour;
  }

  private merge(target: Map<string, HourBucket>, bucket: HourBucket): void {
    const key = bucketKey(bucket.h, bucket.p, bucket.m);
    const existing = target.get(key);
    if (existing) addTotals(existing, bucket);
    else target.set(key, { ...bucket });
    if (target === this.buckets && (this.highestHour === null || bucket.h > this.highestHour)) this.highestHour = bucket.h;
  }

  private flush(): void {
    if (this.open.size === 0) return;
    const lines = [...this.open.values()];
    this.open.clear();
    this.append(lines);
    for (const line of lines) this.merge(this.buckets, line);
  }

  private append(lines: HourBucket[]): void {
    if (lines.length === 0) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, lines.map(toLine).join(""), { encoding: "utf8", mode: 0o600 });
      // The mode above applies only when the append creates the file; one written before is narrowed here.
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Usage history is best-effort: it must never alter the proxy response path.
    }
  }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isHourBucket(parsed)) {
          this.observe(parsed.h);
          this.merge(this.buckets, parsed);
        }
      } catch {
        // A torn write stays behind; the neighbouring lines still count.
      }
    }
  }
}

function hourOf(record: RequestRecord): number | null {
  const at = Date.parse(record.at);
  return Number.isFinite(at) ? Math.floor(at / HOUR_MS) : null;
}
