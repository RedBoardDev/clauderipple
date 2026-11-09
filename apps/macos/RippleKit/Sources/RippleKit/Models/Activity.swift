import Foundation

/// One bucket of `GET /api/requests/summary` (total, per provider, per model).
public struct SummaryBucket: Decodable, Sendable, Equatable {
    public let count: Int
    public let ok: Int
    public let failed: Int
    public let input: Double
    public let cached: Double
    public let cacheWrite: Double
    public let output: Double
    public let cacheHitPercent: Double
    public let avgMs: Double

    enum CodingKeys: String, CodingKey { case count, ok, failed, input, cached, cacheWrite, output, cacheHitPercent, avgMs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
        ok = try c.decodeIfPresent(Int.self, forKey: .ok) ?? 0
        failed = try c.decodeIfPresent(Int.self, forKey: .failed) ?? 0
        input = try c.decodeIfPresent(Double.self, forKey: .input) ?? 0
        cached = try c.decodeIfPresent(Double.self, forKey: .cached) ?? 0
        cacheWrite = try c.decodeIfPresent(Double.self, forKey: .cacheWrite) ?? 0
        output = try c.decodeIfPresent(Double.self, forKey: .output) ?? 0
        cacheHitPercent = try c.decodeIfPresent(Double.self, forKey: .cacheHitPercent) ?? 0
        avgMs = try c.decodeIfPresent(Double.self, forKey: .avgMs) ?? 0
    }
}

public struct ModelBucket: Decodable, Sendable, Equatable, Identifiable {
    public var id: String { "\(provider)/\(model)" }
    public let provider: String
    public let model: String
    public let bucket: SummaryBucket

    enum CodingKeys: String, CodingKey { case provider, model }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        model = try c.decode(String.self, forKey: .model)
        bucket = try SummaryBucket(from: decoder)
    }
}

/// `GET /api/requests/summary`: the in-memory ring (`since`) or the durable hourly history
/// (`from`/`to`, newer routers; they echo `from` back, older ones ignore it).
public struct RequestSummary: Decodable, Sendable, Equatable {
    public let total: SummaryBucket
    public let providers: [String: SummaryBucket]
    public let models: [ModelBucket]
    /// Earliest durable record, ISO 8601 (range answers only).
    public let earliest: String?
    /// Echo of the requested range, epoch ms; nil when the router answered from its ring.
    public let from: Double?
    public let to: Double?

    enum CodingKeys: String, CodingKey { case total, providers, models, earliest, from, to }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = try c.decode(SummaryBucket.self, forKey: .total)
        providers = try c.decodeIfPresent([String: SummaryBucket].self, forKey: .providers) ?? [:]
        models = (try? c.decodeIfPresent([ModelBucket].self, forKey: .models)) ?? []
        earliest = try c.decodeIfPresent(String.self, forKey: .earliest)
        from = try c.decodeIfPresent(Double.self, forKey: .from)
        to = try c.decodeIfPresent(Double.self, forKey: .to)
    }

    /// Whether the router honoured a `from`/`to` range (an older one silently answers its last hour).
    public var isRange: Bool { from != nil }
}
