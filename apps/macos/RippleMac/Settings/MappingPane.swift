import RippleKit
import SwiftUI

struct MappingPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @State private var editor = MappingEditor()

    /// Keep several rows visible without letting a grouped Form collapse the native table.
    private static let tableHeight: CGFloat = 300
    private static let removeWidth: CGFloat = 28

    var body: some View {
        LoadableView(editor.load, retry: reload) { _ in
            Form {
                Section {
                    mappingTable
                        .frame(minHeight: Self.tableHeight)
                    HStack {
                        Button("Add mapping", systemImage: "plus") { editor.add(store: store) }
                            .buttonStyle(.glass)
                            .disabled(!canAdd)
                        Spacer()
                        if editor.isWriting { ProgressView().controlSize(.small) }
                        Text(editor.saveState).font(.callout).foregroundStyle(.secondary)
                    }
                    if editor.error != nil {
                        InlineError(editor.error)
                        Button("Retry save") { editor.retry(store: store) }.buttonStyle(.glass)
                    }
                    if let warning = editor.warning {
                        Label(warning, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.warn)
                    }
                } header: {
                    Label("Model mapping", systemImage: "arrow.triangle.branch")
                } footer: {
                    FormNote(
                        "Choose which provider answers each Claude model. Unmapped models pass through unchanged. Changes save automatically; fallback routes are preserved."
                    )
                }
                if editor.configuration.providers.allSatisfy({ $0.models.isEmpty }) {
                    Section {
                        FormNote("No routing targets are configured. Add providers and their models in the web dashboard.")
                        Button("Manage providers", systemImage: "arrow.up.right.square") { app.openWebDashboard(section: "providers") }
                            .buttonStyle(.glass)
                    }
                }
            }
            .formStyle(.grouped)
        }
        .task { await editor.load(using: store.client) }
    }

    private var canAdd: Bool {
        editor.models.contains { model in !editor.configuration.routes.contains { $0.source == model.id } }
            && editor.configuration.providers.contains { !$0.models.isEmpty }
    }

    private var mappingTable: some View {
        Table(editor.configuration.routes) {
            TableColumn("Claude model") { route in sourcePicker(route) }
            TableColumn("Provider") { route in providerPicker(route) }
            TableColumn("Model") { route in modelPicker(route) }
            TableColumn("Effort") { route in effortPicker(route) }
            if editor.windows != nil {
                TableColumn("Context") { route in
                    RoutingContextField(value: route.contextWindow, placeholder: contextPlaceholder(route)) { value in
                        editor.change([.change(source: route.source, field: .contextWindow, value: value.map(JSONValue.int))], store: store)
                    }
                    .help("This mapping's context window. Empty uses the model or global fallback.")
                }
            }
            TableColumn("") { route in
                Button("Remove mapping", systemImage: "minus.circle") {
                    editor.change([.remove(source: route.source)], store: store)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .help("Remove mapping for \(route.source)")
            }
            .width(Self.removeWidth)
        }
        .controlSize(.small)
    }

    private func sourcePicker(_ route: ModelRoute) -> some View {
        Picker(
            "Claude model",
            selection: Binding(
                get: { route.source },
                set: { value in
                    editor.change([.rename(source: route.source, destination: value)], store: store)
                })
        ) {
            if !editor.models.contains(where: { $0.id == route.source }) { Text(route.source).tag(route.source) }
            ForEach(editor.models) { model in
                Text(model.label).tag(model.id)
                    .disabled(model.id != route.source && editor.configuration.routes.contains { $0.source == model.id })
            }
        }
        .labelsHidden()
    }

    private func providerPicker(_ route: ModelRoute) -> some View {
        Picker(
            "Provider",
            selection: Binding(
                get: { route.provider },
                set: { value in
                    guard let model = editor.configuration.providers.first(where: { $0.id == value })?.models.first else { return }
                    editor.selectTarget(route: route, provider: value, model: model.id, store: store)
                })
        ) {
            if !editor.configuration.providers.contains(where: { $0.id == route.provider }) {
                Text("\(route.provider) (unavailable)").tag(route.provider)
            }
            ForEach(editor.configuration.providers.filter { !$0.models.isEmpty }) { provider in
                Text(provider.id).tag(provider.id)
            }
        }
        .labelsHidden()
    }

    private func modelPicker(_ route: ModelRoute) -> some View {
        let models = editor.configuration.providers.first { $0.id == route.provider }?.models ?? []
        return Picker(
            "Model",
            selection: Binding(
                get: { route.model },
                set: { value in
                    editor.selectTarget(route: route, provider: route.provider, model: value, store: store)
                })
        ) {
            if !models.contains(where: { $0.id == route.model }) { Text("\(route.model) (unavailable)").tag(route.model) }
            ForEach(models) { model in Text(model.label).tag(model.id) }
        }
        .labelsHidden()
    }

    private func effortPicker(_ route: ModelRoute) -> some View {
        let levels = editor.levels(for: route)
        return Picker(
            "Effort",
            selection: Binding(
                get: { route.effort ?? "" },
                set: { value in
                    editor.change(
                        [.change(source: route.source, field: .effort, value: value.isEmpty ? nil : .string(value))], store: store)
                })
        ) {
            Text(levels.isEmpty ? "Not available" : "Default").tag("")
            if let effort = route.effort, !levels.contains(effort) { Text("\(effort) (saved)").tag(effort) }
            ForEach(levels, id: \.self) { Text($0).tag($0) }
        }
        .labelsHidden()
        .disabled(levels.isEmpty)
    }

    private func contextPlaceholder(_ route: ModelRoute) -> String {
        let model = editor.configuration.providers.first { $0.id == route.provider }?.models.first { $0.id == route.model }
        return (model?.contextWindow ?? editor.windows?.windows[route.model]).map(String.init) ?? "Automatic"
    }

    private func reload() { Task { await editor.load(using: store.client) } }
}
