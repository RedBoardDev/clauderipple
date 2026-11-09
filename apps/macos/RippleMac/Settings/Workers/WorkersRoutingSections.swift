import RippleKit
import SwiftUI

struct WorkersRoutingSections: View {
    @Bindable var model: WorkersModel
    let accounts: [AccountUsage]
    @State private var confirmRemoval = false

    private var choices: [ModWorkerChoice] { model.options?.workerChoices ?? [] }
    private var activeID: String { model.settings["activeMode"]?.stringValue ?? "" }
    private var resetProviders: [String] {
        let eligible = accounts.filter { account in
            guard account.health != .paused, account.health != .needsLogin else { return false }
            let windows = [account.fiveHour, account.weekly].compactMap { $0 }
            let selected = account.kind == .claude ? Array(windows.sorted { $0.usedPercent > $1.usedPercent }.prefix(1)) : windows
            return selected.contains { ($0.resetsAt ?? .distantPast) > Date() }
        }.map { $0.kind == .claude ? "anthropic" : $0.provider }
        return (model.options?.providers ?? []).compactMap { provider in
            let key = provider.type == "anthropic" ? "anthropic" : provider.name
            return eligible.contains(key) ? key : nil
        }.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
    }

    var body: some View {
        Section {
            ModStringPicker(model: model, title: "Take over", key: "agentAuto", choices: [("off", "Off"), ("auto", "ripple:auto"), ("all", "All spawns")])
            if let error = model.optionsError {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.warn)
            }
            if model.editor?.base.legacy == true {
                FormNote("Older Auto and field rules have become the four workers. Your settings retain the router's migrated ladder.")
            }
        } header: { Label("Workers", systemImage: "person.3.sequence") }
        footer: { FormNote("ripple:auto routes only explicitly delegated tasks. All spawns also routes general-purpose subagents without an explicit model. Tasks that name a model are left alone.") }

        if model.settings["modes"] != nil {
            modeSection
        }
        if model.mode == nil { allowSection }
        if model.mode?["rungs"] != nil || (model.mode == nil && model.settings.value(at: ["rules", "general", "rungs"]) != nil) {
            rungSection
        }
    }

    private var modeSection: some View {
        Section {
            Picker("Edit operating mode", selection: $model.selectedMode) {
                Text(activeID.isEmpty ? "Base · Active" : "Base").tag("")
                ForEach(model.modes.indices, id: \.self) { index in
                    let mode = model.modes[index]
                    let id = mode["id"]?.stringValue ?? ""
                    Text((mode["name"]?.stringValue ?? "Unnamed") + (id == activeID ? " · Active" : "")).tag(id)
                }
            }
            if let mode = model.mode {
                TextField("Name", text: Binding(get: { model.mode?["name"]?.stringValue ?? "" }, set: {
                    model.updateMode("name", value: .string(String($0.prefix(ModSettingsEditor.maximumNameLength))))
                }))
                if mode["delegation"] != nil { delegation(mode: true) }
                if mode["until"] != nil { untilControls(mode) }
                HStack {
                    Button(activeID == model.selectedMode ? "Turn off mode" : "Activate mode") {
                        model.activate(activeID == model.selectedMode ? "" : model.selectedMode)
                    }.buttonStyle(.glassProminent)
                    Spacer()
                    Button("Remove mode", role: .destructive) { confirmRemoval = true }.buttonStyle(.glass)
                }
                .confirmationDialog("Remove this operating mode?", isPresented: $confirmRemoval) {
                    Button("Remove mode", role: .destructive) { model.removeMode() }
                    Button("Cancel", role: .cancel) {}
                } message: { Text("The base ladder is kept. An active mode will be turned off.") }
            } else {
                if model.settings["delegation"] != nil { delegation(mode: false) }
                if !activeID.isEmpty { Button("Use base") { model.activate("") }.buttonStyle(.glass) }
            }
            HStack {
                TextField("New mode name", text: $model.newModeName)
                    .onSubmit { model.createMode() }
                Button("Add mode", systemImage: "plus") { model.createMode() }
                    .buttonStyle(.glass)
                    .disabled(model.newModeName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || model.newModeName.count > ModSettingsEditor.maximumNameLength
                              || model.modes.count >= ModSettingsEditor.maximumModes)
            }
        } header: { Label("Operating modes", systemImage: "square.stack.3d.up") }
        footer: { FormNote("A mode is an independent ordered worker set. Editing does not activate it. Save up to 20 modes; eager delegation sends everything but judgment and final review to workers.") }
    }

    private func delegation(mode: Bool) -> some View {
        let current = mode ? model.mode?["delegation"]?.stringValue : model.settings["delegation"]?.stringValue
        return Picker("Delegation", selection: Binding(get: { current ?? "normal" }, set: {
            if mode { model.updateMode("delegation", value: .string($0)) }
            else { model.set(.string($0), key: "delegation") }
        })) {
            Text("Normal").tag("normal")
            Text("Eager").tag("eager")
        }
    }

    @ViewBuilder
    private func untilControls(_ mode: JSONValue) -> some View {
        let until = mode["until"] ?? .string("none")
        let kind = until.doubleValue != nil ? "time" : until["reset"] != nil ? "reset" : "none"
        Picker("Ends", selection: Binding(get: { kind }, set: { value in
            let next: JSONValue
            switch value {
            case "time": next = .double(Date().addingTimeInterval(ModSettingsEditor.defaultModeDuration).timeIntervalSince1970 * ModSettingsEditor.millisecondsPerSecond)
            case "reset": next = .object([("reset", .string(resetProviders.first ?? "anthropic"))])
            default: next = .string("none")
            }
            model.updateMode("until", value: next)
        })) {
            Text("No automatic end").tag("none")
            Text("At a time").tag("time")
            Text("At quota reset").tag("reset").disabled(resetProviders.isEmpty)
        }
        if kind == "time", let milliseconds = until.doubleValue {
            DatePicker("End time", selection: Binding(get: {
                Date(timeIntervalSince1970: milliseconds / ModSettingsEditor.millisecondsPerSecond)
            }, set: { date in
                guard date > Date() else { return }
                model.updateMode("until", value: .double(date.timeIntervalSince1970 * ModSettingsEditor.millisecondsPerSecond))
            }), in: Date()..., displayedComponents: [.date, .hourAndMinute])
        }
        if kind == "reset", let current = until["reset"]?.stringValue {
            Picker("Reset provider", selection: Binding(get: { current }, set: {
                var next = until
                next["reset"] = .string($0)
                model.updateMode("until", value: next)
            })) {
                ForEach(resetProviders, id: \.self) { Text($0 == "anthropic" ? "Claude" : $0).tag($0) }
                if !resetProviders.contains(current) { Text("\(current) (reset unavailable)").tag(current) }
            }
        }
        if resetProviders.isEmpty { FormNote("Quota-reset endings need a known future reset from an available account.") }
    }

    private var allowSection: some View {
        Section {
            if model.settings["allow"] != nil {
                ForEach(choices.filter { $0.id != "general-purpose" }) { choice in
                    Toggle(isOn: Binding(get: {
                        ModSettingsEditor.isAllowed(choice, in: model.settings)
                    }, set: { on in model.edit { $0.setAllowed(choice, on: on, choices: choices) } })) {
                        VStack(alignment: .leading, spacing: Metrics.labelGap) {
                            Text(choice.label)
                            Text([choice.provider, choice.billingTitle].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            if !choice.usable {
                                Label(choice.reason ?? "Unavailable now", systemImage: "exclamationmark.triangle")
                                    .font(.caption).foregroundStyle(Theme.warn)
                            }
                        }
                    }
                    .disabled(ModSettingsEditor.isAllowed(choice, in: model.settings)
                              && choices.filter { $0.id != "general-purpose" && ModSettingsEditor.isAllowed($0, in: model.settings) }.count <= 1)
                }
            }
            if choices.isEmpty { FormNote("No model catalog available. Saved models are kept unchanged.") }
        } header: { Text("Models to use") }
        footer: { FormNote("The four workers may run only on ticked models. At least one model stays on. The session model is always available as a fallback.") }
    }

    private var rungSection: some View {
        Section {
            ForEach(ModRung.allCases, id: \.rawValue) { rung in
                WorkersRungView(model: model, rung: rung, choices: choices)
            }
        } header: { Text(model.mode == nil ? "Base workers" : "Mode workers") }
        footer: { FormNote("Use the first available model in order. If the entire list fails, try one worker tier up, then the session model.") }
    }
}

private struct WorkersRungView: View {
    let model: WorkersModel
    let rung: ModRung
    let choices: [ModWorkerChoice]
    private var steps: [JSONValue] { model.rungs[rung.rawValue]?.arrayValue ?? [] }
    private var offered: [ModWorkerChoice] {
        choices.filter { $0.id == "general-purpose" || ModSettingsEditor.isAllowed($0, in: model.settings) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.sectionGap) {
            Text(rung.title).font(.headline)
            ForEach(steps.indices, id: \.self) { index in
                stepRow(index)
            }
            Button("Add model", systemImage: "plus") {
                guard let choice = offered.first else { return }
                let effort = choice.availableEfforts.contains(.medium) ? ModEffort.medium : choice.availableEfforts[0]
                model.editRung(rung, edit: .add(.object([("target", choice.target), ("effort", .string(effort.rawValue))])))
            }
            .buttonStyle(.glass).disabled(offered.isEmpty)
        }
        .padding(.vertical, Metrics.labelGap)
    }

    private func stepRow(_ index: Int) -> some View {
        let step = steps[index]
        let key = ModWorkerChoice.key(for: step["target"])
        let choice = choices.first { $0.id == key }
        let effort = step["effort"]?.stringValue ?? "medium"
        let efforts = choice?.availableEfforts ?? ModEffort.allCases
        return VStack(alignment: .leading, spacing: Metrics.labelGap) {
            Picker("Model \(index + 1)", selection: Binding(get: { key }, set: { next in
                guard let selected = choices.first(where: { $0.id == next }) else { return }
                var updated = step
                // Keep unknown target members while changing the two fields owned by this picker.
                var target = step["target"] ?? .object([])
                target["agent"] = .string(selected.agent)
                target["model"] = selected.model.map(JSONValue.string)
                updated["target"] = target
                if !selected.availableEfforts.contains(where: { $0.rawValue == effort }) {
                    updated["effort"] = .string(selected.availableEfforts[0].rawValue)
                }
                model.editRung(rung, edit: .replace(index, updated))
            })) {
                ForEach(offered) { Text($0.menuTitle).tag($0.id) }
                if !offered.contains(where: { $0.id == key }) { Text("\(choice?.label ?? key) (unavailable)").tag(key) }
            }
            HStack {
                Picker("Effort", selection: Binding(get: { effort }, set: { value in
                    var updated = step
                    updated["effort"] = .string(value)
                    model.editRung(rung, edit: .replace(index, updated))
                })) {
                    ForEach(efforts, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
                    if !efforts.contains(where: { $0.rawValue == effort }) { Text("\(effort) (unavailable)").tag(effort) }
                }
                Spacer()
                Button { model.editRung(rung, edit: .move(index, index - 1)) } label: { Image(systemName: "arrow.up") }
                    .disabled(index == 0).help("Move up").accessibilityLabel("Move \(rung.title) model \(index + 1) up")
                Button { model.editRung(rung, edit: .move(index, index + 1)) } label: { Image(systemName: "arrow.down") }
                    .disabled(index == steps.count - 1).help("Move down").accessibilityLabel("Move \(rung.title) model \(index + 1) down")
                Button(role: .destructive) { model.editRung(rung, edit: .remove(index)) } label: { Image(systemName: "minus.circle") }
                    .disabled(steps.count <= 1).help("Remove model").accessibilityLabel("Remove \(rung.title) model \(index + 1)")
            }
            .buttonStyle(.glass).controlSize(.small)
            if choice?.usable == false {
                Label(choice?.reason ?? "Unavailable now; the next model will be tried.", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(Theme.warn)
            }
        }
    }
}
