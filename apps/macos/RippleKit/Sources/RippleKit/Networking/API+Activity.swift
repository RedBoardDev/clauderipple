import Foundation

public extension AdminClient {
    /// Matches the dashboard's bounded recent-request and log tails.
    static var activityRowLimit: Int { 200 }

    func activitySummary(query: ActivityQuery) async throws -> ActivitySummary {
        let ranged: RequestSummary = try await get("/api/requests/summary", query: query.rangeItems)
        if ranged.isRange { return ActivitySummary(summary: ranged, periodAvailable: true) }
        guard let fallback = query.fallbackItems else {
            return ActivitySummary(summary: ranged, periodAvailable: false)
        }
        let recent: RequestSummary = try await get("/api/requests/summary", query: fallback)
        return ActivitySummary(summary: recent, periodAvailable: true)
    }

    func recentRequests(provider: String? = nil) async throws -> [RequestRecord] {
        var items = [URLQueryItem(name: "n", value: String(Self.activityRowLimit)),
                     URLQueryItem(name: "kind", value: "messages,image")]
        if let provider { items.append(URLQueryItem(name: "provider", value: provider)) }
        let response: RecentRequests = try await get("/api/requests", query: items)
        // The route already returns newest first. Sorting also handles imported older ring entries.
        return response.requests.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }

    func activityRouterLog() async throws -> String {
        try await getText("/api/logs", query: [URLQueryItem(name: "n", value: String(Self.activityRowLimit))])
    }
}
