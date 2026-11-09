import Foundation

public enum ModSaveError: Error, LocalizedError, Sendable {
    case unsupportedSchema
    case conflict(ModSettingsSnapshot)

    public var errorDescription: String? {
        switch self {
        case .unsupportedSchema: "This router uses an unsupported settings schema. Update ClaudeRipple before saving."
        case .conflict: "Settings changed elsewhere three times. Current settings were reloaded; please make your change again."
        }
    }
}

public extension AdminClient {
    func modSettings() async throws -> ModSettingsSnapshot {
        try await ModSettingsSnapshot(document: getDocument("/api/mod-settings"))
    }

    func modOptions() async throws -> ModOptions {
        try await get("/api/mod-options")
    }

    /// Retry only stale revisions, rebasing the changed paths on the actual 409 response body.
    func saveModSettings(_ editor: ModSettingsEditor) async throws -> ModSettingsSnapshot {
        var draft = editor
        for attempt in 1...ModSettingsEditor.maximumSaveAttempts {
            try Task.checkCancellation()
            let answer = try await exchange("PUT", "/api/mod-settings", json: draft.putBody())
            if answer.status == 426 { throw ModSaveError.unsupportedSchema }
            if answer.status == 409, let document = answer.document, document["settings"] != nil {
                let current = try ModSettingsSnapshot(document: document)
                if attempt == ModSettingsEditor.maximumSaveAttempts { throw ModSaveError.conflict(current) }
                draft.rebase(on: current)
                continue
            }
            guard (200..<300).contains(answer.status) else {
                throw AdminError.http(status: answer.status, message: answer.document?["error"]?.stringValue)
            }
            guard let document = answer.document else { throw AdminError.decoding("missing saved settings snapshot") }
            return try ModSettingsSnapshot(document: document)
        }
        throw AdminError.decoding("missing mod save result")
    }
}
