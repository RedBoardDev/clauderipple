import Observation
import RippleKit
import SwiftUI

@MainActor
@Observable
final class ClientsEditor {
    var load: Loadable<Bool> = .loading
    var configuration = RoutingConfiguration(document: .object([]))
    var capabilities: ClientCapabilities?
    var codex: Loadable<CodexIntegration> = .loading
    var busy: String?
    var error: String?
    var warning: String?
    var saved = false
    private var document = JSONValue.object([])

    func load(using store: RouterStore) async {
        guard busy == nil else { return }
        load = .loading
        do {
            async let config = store.client.config()
            async let capabilities = store.client.clientCapabilities()
            let values = try await (config, capabilities)
            document = values.0
            configuration = RoutingConfiguration(document: document)
            self.capabilities = values.1
            load = .loaded(true)
        } catch { load = .failed(error.asAdminError) }
        await loadCodex(using: store.client)
        if store.status == nil { await store.refresh() }
    }

    func loadCodex(using client: AdminClient) async {
        do { codex = .loaded(try await client.codexIntegration()) } catch { codex = .failed(error.asAdminError) }
    }

    func edit(_ name: String, store: RouterStore, change: @escaping @Sendable (inout JSONValue) throws -> Void) {
        guard busy == nil else { return }
        busy = name
        error = nil
        saved = false
        Task {
            defer { busy = nil }
            do {
                warning = try await store.client.updateConfig(change)
                try change(&document)
                configuration = RoutingConfiguration(document: document)
                saved = true
            } catch { self.error = error.asAdminError.userMessage }
            await store.refresh()
            capabilities = try? await store.client.clientCapabilities()
        }
    }

    func command(_ name: String, store: RouterStore, action: @escaping @Sendable (AdminClient) async throws -> ClientCommandResult) {
        guard busy == nil else { return }
        busy = name
        error = nil
        warning = nil
        saved = false
        Task {
            defer { busy = nil }
            do {
                _ = try await action(store.client)
                saved = true
            } catch { self.error = error.asAdminError.userMessage }
            // Even a failed CLI command may have completed part of its work. Show actual state.
            await store.refresh()
            capabilities = try? await store.client.clientCapabilities()
            await loadCodex(using: store.client)
        }
    }
}
