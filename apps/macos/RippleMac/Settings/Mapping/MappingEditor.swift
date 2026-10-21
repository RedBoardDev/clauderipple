import Observation
import RippleKit
import SwiftUI

@MainActor
@Observable
final class MappingEditor {
    var load: Loadable<Bool> = .loading
    var configuration = RoutingConfiguration(document: .object([]))
    var models: [RoutingModel] = []
    var efforts: EffortLevelsResponse?
    var windows: ContextWindowsResponse?
    var saveState = ""
    var error: String?
    var warning: String?
    var isWriting = false

    /// Match the dashboard's autosave interval without cancelling an in-flight write.
    private static let debounce: Duration = .milliseconds(500)
    private var document = JSONValue.object([])
    private var pending: [RouteEdit] = []
    private var lastEdit = ContinuousClock.now
    private var saver: Task<Void, Never>?

    func load(using client: AdminClient) async {
        guard pending.isEmpty, !isWriting else { return }
        load = .loading
        do {
            async let config = client.config()
            async let models = client.claudeModels()
            async let efforts = client.effortLevels()
            async let windows = client.contextWindows()
            let values = try await (config, models, efforts, windows)
            document = values.0
            configuration = RoutingConfiguration(document: document)
            self.models = values.1.models
            self.efforts = values.2
            self.windows = values.3
            load = .loaded(true)
        } catch { load = .failed(error.asAdminError) }
    }

    func levels(for route: ModelRoute) -> [String] {
        let model = configuration.providers.first { $0.id == route.provider }?.models.first { $0.id == route.model }
        return efforts?.levels(provider: route.provider, model: model) ?? model?.effortLevels ?? []
    }

    func change(_ edits: [RouteEdit], store: RouterStore) {
        do {
            try ConfigEdits.apply(edits, to: &document)
            configuration = RoutingConfiguration(document: document)
            pending.append(contentsOf: edits)
            lastEdit = .now
            error = nil
            saveState = "Saving…"
            startSaver(store: store)
        } catch { self.error = error.localizedDescription }
    }

    func retry(store: RouterStore) {
        error = nil
        startSaver(store: store)
    }

    private func startSaver(store: RouterStore) {
        guard saver == nil, !pending.isEmpty else { return }
        // The task finishes pending edits even if the user leaves this pane during the debounce.
        saver = Task {
            defer {
                saver = nil
                isWriting = false
            }
            while !pending.isEmpty {
                let editedAt = lastEdit
                try? await Task.sleep(for: Self.debounce)
                guard editedAt == lastEdit else { continue }
                let batch = pending
                isWriting = true
                do {
                    warning = try await store.client.editRoutes(batch)
                    pending.removeFirst(batch.count)
                    await store.refresh()
                    isWriting = false
                    saveState = pending.isEmpty ? "Saved" : "Saving…"
                } catch {
                    self.error = error.asAdminError.userMessage
                    saveState = "Not saved"
                    return
                }
            }
        }
    }

    func add(store: RouterStore) {
        guard let source = models.first(where: { model in !configuration.routes.contains { $0.source == model.id } }),
            let provider = configuration.providers.first(where: { !$0.models.isEmpty }),
            let target = provider.models.first
        else { return }
        let levels = efforts?.levels(provider: provider.id, model: target) ?? target.effortLevels ?? []
        change(
            [
                .add(
                    source: source.id, provider: provider.id, model: target.id,
                    effort: levels.contains("high") ? "high" : levels.first)
            ], store: store)
    }

    func selectTarget(route: ModelRoute, provider: String, model: String, store: RouterStore) {
        let target = configuration.providers.first { $0.id == provider }?.models.first { $0.id == model }
        let levels = efforts?.levels(provider: provider, model: target) ?? target?.effortLevels ?? []
        let effort = route.effort.flatMap { levels.contains($0) ? $0 : nil } ?? (levels.contains("high") ? "high" : levels.first)
        change(
            [
                .change(source: route.source, field: .provider, value: .string(provider)),
                .change(source: route.source, field: .model, value: .string(model)),
                .change(source: route.source, field: .effort, value: effort.map(JSONValue.string)),
            ], store: store)
    }
}
