import RippleKit
import SwiftUI

struct ClientsPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @State private var editor = ClientsEditor()
    @State private var confirmPicker = false

    var body: some View {
        LoadableView(editor.load, retry: reload) { _ in
            Form {
                feedback
                desktopSection
                extraModelsSection
                slotsSection
                workersSection
                codexSection
            }
            .formStyle(.grouped)
            .disabled(editor.busy != nil)
        }
        .task { await editor.load(using: store) }
        .confirmationDialog("Enable the Desktop model picker?", isPresented: $confirmPicker, titleVisibility: .visible) {
            Button("Enable picker") { setPicker(true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "macOS may ask for your keychain password to trust the local router's certificate. Enter it only in the macOS dialog. Fully quit and reopen Claude Desktop afterwards; closing its window is not enough."
            )
        }
    }

    @ViewBuilder
    private var feedback: some View {
        if let busy = editor.busy {
            Section {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(busy)
                }
                if busy == "Updating Desktop picker…" {
                    FormNote("Waiting for the router. Check for a macOS keychain dialog; this can take several minutes.")
                }
            }
        }
        if editor.error != nil || editor.warning != nil || editor.saved {
            Section {
                InlineError(editor.error).textSelection(.enabled)
                if let warning = editor.warning {
                    Label(warning, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.warn)
                }
                if editor.saved { Label("Saved", systemImage: "checkmark.circle").foregroundStyle(Theme.ok) }
            }
        }
    }

    private var desktopSection: some View {
        Section {
            Toggle(
                "Add models to Claude Desktop",
                isOn: Binding(
                    get: { store.status?.picker?.enabled ?? false },
                    set: { enabled in
                        if enabled { confirmPicker = true } else { setPicker(false) }
                    })
            )
            .disabled(store.status?.picker == nil)
            if let capabilities = editor.capabilities, store.status?.picker?.enabled == true {
                if let at = capabilities.pickerLastAt {
                    LabeledContent("Last injection", value: (try? Date(at, strategy: .iso8601))?.formatted() ?? at)
                    if let count = capabilities.pickerInjected { LabeledContent("Injected models", value: String(count)) }
                } else {
                    FormNote("Configured, but no picker injection has been seen. Fully quit and reopen Claude Desktop.")
                }
                if !capabilities.pickerModels.isEmpty {
                    LabeledContent("Picker models", value: capabilities.pickerModels.joined(separator: ", "))
                }
            }
        } header: {
            Label("Claude Desktop", systemImage: "desktopcomputer")
        } footer: {
            FormNote(
                "Picker mode routes Claude Desktop's model list through the local router. A system keychain dialog may appear when changing it. Fully quit and reopen Claude Desktop after changing picker mode."
            )
        }
    }

    private var extraModelsSection: some View {
        Section {
            if editor.configuration.pickerModels.isEmpty {
                FormNote("No provider models are configured.")
                Button("Manage providers", systemImage: "arrow.up.right.square") { app.openWebDashboard(section: "providers") }
                    .buttonStyle(.glass)
            }
            ForEach(editor.configuration.pickerModels) { choice in
                VStack(alignment: .leading, spacing: Metrics.labelGap) {
                    Toggle(
                        isOn: Binding(
                            get: { extra(choice.id) != nil },
                            set: { enabled in
                                editor.edit("Saving picker models…", store: store) { config in
                                    ConfigEdits.setPickerModel(provider: choice.provider, model: choice.id, enabled: enabled, in: &config)
                                }
                            })
                    ) {
                        VStack(alignment: .leading) {
                            Text(choice.model.label)
                            Text(choice.provider).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let entry = extra(choice.id) {
                        LabeledContent("Context window") {
                            RoutingContextField(
                                value: entry["contextWindow"]?.intValue,
                                placeholder: choice.model.contextWindow.map(String.init) ?? "Global fallback"
                            ) { window in
                                editor.edit("Saving context window…", store: store) { config in
                                    // As on the dashboard, an empty field picks the vendor's known window.
                                    try ConfigEdits.setPickerContext(
                                        model: choice.id, window: window ?? choice.model.contextWindow, in: &config)
                                }
                            }
                        }
                    }
                }
            }
        } header: {
            Label("Extra picker models", systemImage: "list.bullet.rectangle")
        } footer: {
            FormNote(
                store.status?.picker?.enabled == true
                    ? "These entries appear in the Desktop and CLI model pickers. Unknown context windows use the global fallback."
                    : "These entries configure the CLI picker. Enable the Desktop picker above to show them in Claude Desktop too.")
        }
    }

    private var slotsSection: some View {
        Section {
            ForEach(CliModelSlot.allCases, id: \.self) { slot in
                Picker(
                    slotTitle(slot),
                    selection: Binding(
                        get: { editor.configuration.cliSlots[slot.rawValue] ?? "" },
                        set: { model in
                            editor.edit("Saving CLI model…", store: store) { config in ConfigEdits.setSlot(slot, model: model, in: &config)
                            }
                        })
                ) {
                    Text("Default (Claude)").tag("")
                    let choices = editor.configuration.pickerModels
                    let saved = editor.configuration.cliSlots[slot.rawValue] ?? ""
                    if !saved.isEmpty, !choices.contains(where: { $0.id == saved }) { Text("\(saved) (unavailable)").tag(saved) }
                    ForEach(choices) { choice in
                        Text(slotLabel(choice, slot: slot)).tag(choice.id)
                    }
                }
            }
            Picker(
                "Web search backend",
                selection: Binding<SearchBackend?>(
                    get: { editor.configuration.webSearch },
                    set: { backend in
                        editor.edit("Saving web search…", store: store) { config in ConfigEdits.setWebSearch(backend, in: &config) }
                    })
            ) {
                Text("Follow small, fast model").tag(Optional<SearchBackend>.none)
                if let saved = editor.configuration.webSearch, !searchChoices.contains(saved) {
                    Text("\(saved.provider) / \(saved.model) (unavailable)").tag(Optional(saved))
                }
                ForEach(searchChoices, id: \.self) { backend in
                    Text(searchLabel(backend)).tag(Optional(backend))
                }
            }
            if let small = editor.configuration.cliSlots[CliModelSlot.smallFast.rawValue], !small.isEmpty,
                editor.configuration.webSearch == nil,
                let owner = editor.configuration.pickerModels.first(where: { $0.id == small }),
                editor.capabilities?.canSearch(provider: owner.provider, model: small) == false
            {
                Label(
                    "This small, fast model cannot run web search. Choose a supported search backend.",
                    systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(Theme.warn)
            }
        } header: {
            Label("Claude Code CLI", systemImage: "terminal")
        } footer: {
            FormNote(
                "Main is the session default; small, fast handles titles and classifiers; subagent is the default worker model. A separate web search backend handles searches independently. New sessions read changed CLI slots."
            )
        }
    }

    private var workersSection: some View {
        Section {
            Toggle(
                "ClaudeRipple status mod",
                isOn: Binding(
                    get: { store.status?.statusMod ?? false },
                    set: { enabled in
                        editor.command("Updating status mod…", store: store) { client in try await client.setStatusMod(enabled) }
                    })
            )
            .disabled(store.status?.statusMod == nil)
            Toggle(
                "Limit worker tools",
                isOn: Binding(
                    get: { editor.configuration.limitWorkerTools },
                    set: { enabled in
                        editor.edit("Saving worker tools…", store: store) { config in ConfigEdits.setLimitWorkerTools(enabled, in: &config)
                        }
                    }))
        } header: {
            Label("Workers", systemImage: "person.2.wave.2")
        } footer: {
            FormNote(
                "The mod shows routing and worker controls inside Claude Code. Limiting tools reduces worker prompt size, but removes browser, simulator and other inherited MCP tools."
            )
        }
    }

    private var codexSection: some View {
        Section {
            LoadableView(editor.codex, retry: { Task { await editor.loadCodex(using: store.client) } }) { codex in
                Toggle(
                    "Use ClaudeRipple in Codex",
                    isOn: Binding(
                        get: { codex.enabled },
                        set: { enabled in
                            editor.command("Updating Codex…", store: store) { client in try await client.setCodexIntegration(enabled) }
                        }))
                LabeledContent("Codex home", value: codex.codexHome).textSelection(.enabled)
                LabeledContent("Config file", value: codex.configPath).textSelection(.enabled)
            }
        } header: {
            Label("Codex", systemImage: "curlybraces")
        } footer: {
            FormNote("Updates Codex's integration with the router. Your Codex sign-in remains managed by Codex.")
        }
    }

    private var searchChoices: [SearchBackend] {
        editor.configuration.providers.filter { $0.type != "anthropic" }.flatMap { provider in
            provider.models.filter { editor.capabilities?.canSearch(provider: provider.id, model: $0.id) == true }
                .map { SearchBackend(provider: provider.id, model: $0.id) }
        }
    }

    private func extra(_ id: String) -> JSONValue? {
        editor.configuration.extraModels.first { $0["model"]?.stringValue == id }
    }

    private func slotTitle(_ slot: CliModelSlot) -> String {
        switch slot {
        case .main: "Main model"
        case .smallFast: "Small, fast model"
        case .subagent: "Subagent model"
        }
    }

    private func slotLabel(_ choice: PickerModelChoice, slot: CliModelSlot) -> String {
        let label = "\(choice.model.label) · \(choice.provider)"
        if slot == .smallFast, editor.configuration.webSearch == nil,
            editor.capabilities?.canSearch(provider: choice.provider, model: choice.id) == false
        {
            return "\(label) — no web search"
        }
        return label
    }

    private func searchLabel(_ backend: SearchBackend) -> String {
        let model = editor.configuration.providers.first { $0.id == backend.provider }?.models.first { $0.id == backend.model }
        return "\(model?.label ?? backend.model) · \(backend.provider)"
    }

    private func setPicker(_ enabled: Bool) {
        editor.command("Updating Desktop picker…", store: store) { client in try await client.setDesktopPicker(enabled) }
    }

    private func reload() { Task { await editor.load(using: store) } }
}
