import Foundation

extension AdminClient {
    /// Give the user time to answer the OS keychain dialog; never ask for its password in-app.
    public static var pickerTimeout: TimeInterval { 5 * 60 }

    public func clientCapabilities() async throws -> ClientCapabilities {
        ClientCapabilities(document: try await getDocument("/api/status"))
    }

    public func codexIntegration() async throws -> CodexIntegration {
        try await get("/api/codex")
    }

    public func setDesktopPicker(_ enabled: Bool) async throws -> ClientCommandResult {
        try await clientCommand("/api/picker", enabled: enabled, timeout: Self.pickerTimeout)
    }

    public func setStatusMod(_ enabled: Bool) async throws -> ClientCommandResult {
        try await clientCommand("/api/status-mod", enabled: enabled)
    }

    public func setCodexIntegration(_ enabled: Bool) async throws -> ClientCommandResult {
        try await clientCommand("/api/codex", enabled: enabled)
    }

    private func clientCommand(_ path: String, enabled: Bool, timeout: TimeInterval = writeTimeout) async throws -> ClientCommandResult {
        let answer: ClientCommandResult = try await send("POST", path, json: .object([("enabled", .bool(enabled))]), timeout: timeout)
        guard answer.ok else { throw AdminError.http(status: 500, message: answer.output) }
        return answer
    }
}
