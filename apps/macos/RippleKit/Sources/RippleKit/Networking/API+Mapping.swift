import Foundation

extension AdminClient {
    public func claudeModels() async throws -> ClaudeModelsResponse {
        try await get("/api/claude-models")
    }

    public func effortLevels() async throws -> EffortLevelsResponse {
        try await get("/api/effort-levels")
    }

    /// 0.9.5 serves HTML for this missing route. That is a capability absence, not a pane failure.
    public func contextWindows() async throws -> ContextWindowsResponse? {
        do { return try await get("/api/context-windows") } catch AdminError.routeMissing { return nil }
    }

    @discardableResult
    public func editRoutes(_ edits: [RouteEdit]) async throws -> String? {
        try await updateConfig { config in try ConfigEdits.apply(edits, to: &config) }
    }
}
