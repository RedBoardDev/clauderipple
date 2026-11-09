import Foundation

/// Recent requests can outlive the router version that wrote them; additive fields stay optional.
public struct RequestRecord: Decodable, Sendable, Identifiable {
    public let id: String
    public let at: String?
    public let ms: Double?
    public let status: RequestStatus?
    public let ok: Bool?
    public let kind: String?
    public let source: String?
    public let target: String?
    public let provider: String?
    public let effort: String?
    public let requestedTier: String?
    public let servedTier: String?
    public let stopReason: String?
    public let usage: RequestUsage?
    public let refusal: String?
    public let purpose: String?
    public let note: String?
    public let session: String?
    public let stream: Bool?
    public let resent: Bool?
    public let upstreamCalled: Bool?
    public let upstreamRequestId: String?
    public let messageId: String?

    enum CodingKeys: String, CodingKey {
        case id, at, ms, status, ok, kind, source, target, provider, effort, requestedTier, servedTier
        case stopReason, usage, refusal, purpose, note, session, stream, resent, upstreamCalled, upstreamRequestId, messageId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        at = try c.decodeIfPresent(String.self, forKey: .at)
        ms = try c.decodeIfPresent(Double.self, forKey: .ms)
        status = try c.decodeIfPresent(RequestStatus.self, forKey: .status)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        target = try c.decodeIfPresent(String.self, forKey: .target)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        effort = try c.decodeIfPresent(String.self, forKey: .effort)
        requestedTier = try c.decodeIfPresent(String.self, forKey: .requestedTier)
        servedTier = try c.decodeIfPresent(String.self, forKey: .servedTier)
        stopReason = try c.decodeIfPresent(String.self, forKey: .stopReason)
        usage = try c.decodeIfPresent(RequestUsage.self, forKey: .usage)
        refusal = try c.decodeIfPresent(String.self, forKey: .refusal)
        purpose = try c.decodeIfPresent(String.self, forKey: .purpose)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        session = try c.decodeIfPresent(String.self, forKey: .session)
        stream = try c.decodeIfPresent(Bool.self, forKey: .stream)
        resent = try c.decodeIfPresent(Bool.self, forKey: .resent)
        upstreamCalled = try c.decodeIfPresent(Bool.self, forKey: .upstreamCalled)
        upstreamRequestId = try c.decodeIfPresent(String.self, forKey: .upstreamRequestId)
        messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
    }

    public var date: Date? {
        guard let at else { return nil }
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        return (try? fractional.parse(at)) ?? (try? Date.ISO8601FormatStyle().parse(at))
    }
}

public enum RequestStatus: Decodable, Sendable, Equatable {
    case number(Int)
    case text(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let number = try? c.decode(Int.self) { self = .number(number) }
        else { self = .text(try c.decode(String.self)) }
    }

    public var text: String {
        switch self {
        case let .number(value): String(value)
        case let .text(value): value
        }
    }
}

public struct RequestUsage: Decodable, Sendable {
    public let input: Double?
    public let cached: Double?
    public let cacheWrite: Double?
    public let output: Double?
}

public struct RecentRequests: Decodable, Sendable {
    public let requests: [RequestRecord]
}

public extension RequestSummary {
    /// Provider filtering never changes the summary request, nor recomputes rates from raw rows.
    func bucket(for provider: String?) -> SummaryBucket? {
        provider.map { providers[$0] } ?? total
    }

    func models(for provider: String?) -> [ModelBucket] {
        models.filter { provider == nil || $0.provider == provider }
    }
}
