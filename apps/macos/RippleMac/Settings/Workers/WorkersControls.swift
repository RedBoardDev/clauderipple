import RippleKit
import SwiftUI

/// Shared bindings only change fields that this router actually supplied.
@MainActor
struct ModControls {
    let model: WorkersModel
    func string(_ key: String) -> Binding<String> {
        Binding(get: { model.settings[key]?.stringValue ?? "" }, set: { model.set(.string($0), key: key) })
    }
    func bool(_ key: String) -> Binding<Bool> {
        Binding(get: { model.settings[key]?.boolValue ?? false }, set: { model.set(.bool($0), key: key) })
    }
    func integer(_ key: String) -> Binding<Int> {
        Binding(get: { model.settings[key]?.intValue ?? 0 }, set: { model.set(.int($0), key: key) })
    }
}

struct ModStringPicker: View {
    let model: WorkersModel
    let title: String
    let key: String
    let choices: [(String, String)]

    var body: some View {
        if let current = model.settings[key]?.stringValue {
            Picker(title, selection: ModControls(model: model).string(key)) {
                ForEach(choices, id: \.0) { value, label in Text(label).tag(value) }
                if !choices.contains(where: { $0.0 == current }) { Text("\(current) (unavailable)").tag(current) }
            }
        }
    }
}

struct ModNumberPicker: View {
    let model: WorkersModel
    let title: String
    let key: String
    let choices: [Int]
    let label: (Int) -> String

    var body: some View {
        if let current = model.settings[key]?.intValue {
            Picker(title, selection: ModControls(model: model).integer(key)) {
                ForEach(choices, id: \.self) { Text(label($0)).tag($0) }
                if !choices.contains(current) { Text("\(current) (unavailable)").tag(current) }
            }
        }
    }
}

struct ModToggle: View {
    let model: WorkersModel
    let title: String
    let key: String
    var body: some View {
        if model.settings[key]?.boolValue != nil { Toggle(title, isOn: ModControls(model: model).bool(key)) }
    }
}

struct WorkersBasicSections: View {
    let model: WorkersModel

    var body: some View {
        Section {
            ModToggle(model: model, title: "Auto effort", key: "effortAuto")
                .help("Picks per prompt; your own pick turns it off.")
            if model.settings["bias"] != nil {
                Stepper(value: ModControls(model: model).integer("bias"), in: ModSettingsEditor.biasRange) {
                    LabeledContent("Bias", value: model.settings["bias"]?.intValue.map { $0 > 0 ? "+\($0)" : "\($0)" } ?? "0")
                }
                .help("Lower is cheaper, higher is smarter. Tips close calls only.")
            }
            boundPicker("Floor", key: "floor", floor: true)
            boundPicker("Ceiling", key: "ceiling", floor: false)
        } header: {
            Label("Effort", systemImage: "dial.medium")
        } footer: {
            FormNote("How Auto picks the effort for each prompt you send. The floor never exceeds the ceiling.")
        }
    }

    @ViewBuilder
    private func boundPicker(_ title: String, key: String, floor: Bool) -> some View {
        if let current = model.settings[key]?.stringValue {
            Picker(title, selection: Binding(get: { model.settings[key]?.stringValue ?? current }, set: { raw in
                if let effort = ModEffort(rawValue: raw) { model.edit { $0.setEffortBound(effort, floor: floor) } }
            })) {
                ForEach(ModEffort.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
                if ModEffort(rawValue: current) == nil { Text(current).tag(current) }
            }
        }
    }
}

struct WorkersOtherSections: View {
    let model: WorkersModel
    private var controls: ModControls { ModControls(model: model) }

    var body: some View {
        judge
        cache
        handoff
        look
    }

    private var judge: some View {
        Section {
            ModStringPicker(model: model, title: "Judge", key: "judge", choices: [("haiku", "Haiku"), ("jev", "Jev"), ("model", "Router model")])
            if model.settings["judge"]?.stringValue == "model" {
                ModStringPicker(model: model, title: "Model", key: "judgeModel", choices: judgeModels)
                FormNote("Falls back to Haiku if the selected model cannot judge.")
            }
            if model.settings["judge"]?.stringValue == "jev" {
                ModStringPicker(model: model, title: "Jev source", key: "jevSource", choices: [("typesafe", "TypeSafe"), ("zen", "Zen")])
                FormNote("Keys are managed outside this pane. Configure TypeSafe in the Claude Code bar or TYPESAFE_API_KEY; configure Zen in Providers.")
            }
        } header: { Label("Judge", systemImage: "sparkle.magnifyingglass") }
        footer: { FormNote("Who decides: effort for prompts, domain and level for tasks.") }
    }

    private var judgeModels: [(String, String)] {
        var seen = Set<String>()
        return (model.options?.models ?? []).filter { seen.insert($0.model).inserted }.map { entry in
            let provider = model.options?.providers.first { $0.name == entry.provider }
            let billing = provider?.billing == "payg" ? "Pay per token" : provider?.billing?.capitalized
            return (entry.model, [entry.name ?? entry.model, entry.provider, billing,
                                 provider?.usable == false ? (provider?.reason ?? "Unavailable now") : nil].compactMap { $0 }.joined(separator: " · "))
        }
    }

    private var cache: some View {
        Section {
            ModToggle(model: model, title: "Keep cache warm", key: "keepWarm")
            ModNumberPicker(model: model, title: "After each reply", key: "keepWarmHours", choices: ModSettingsEditor.warmHours, label: { "\($0) hours" })
            ModNumberPicker(model: model, title: "Chats starting at", key: "keepWarmMinTokens", choices: ModSettingsEditor.warmMinimums, label: { "\($0 / 1000)k tokens" })
        } header: { Label("Cache", systemImage: "flame") }
        footer: { FormNote("Each ping re-reads the whole chat from cache: about a tenth of its input price, and the same share of plan limits.") }
    }

    private var handoff: some View {
        Section {
            ModStringPicker(model: model, title: "Compact with", key: "compactWith", choices: [("haiku", "Haiku"), ("session", "Session model")])
            ModStringPicker(model: model, title: "After handoff", key: "handoffAfter", choices: [("continue", "Continue"), ("confirm", "Confirm"), ("copy", "Copy")])
            ModStringPicker(model: model, title: "Handoff button", key: "handoffButton", choices: [("advised", "When advised"), ("always", "Always")])
            if model.settings["handoffSkill"] != nil {
                TextField("Handoff skill", text: controls.string("handoffSkill"), prompt: Text("No skill"))
            }
            ModNumberPicker(model: model, title: "Heavy context at", key: "swampAt", choices: ModSettingsEditor.swampThresholds, label: { "\($0)%" })
            ModToggle(model: model, title: "Heavy-context alert", key: "swampAlert")
        } header: { Label("Handoff", systemImage: "arrow.trianglehead.2.clockwise.rotate.90") }
    }

    private var look: some View {
        Section {
            ModStringPicker(model: model, title: "Layout", key: "layout", choices: [("dashboard", "Dashboard"), ("minimal", "Minimal")])
            ModStringPicker(model: model, title: "Appearance", key: "appearance", choices: [("auto", "Automatic"), ("light", "Light"), ("dark", "Dark")])
            ModStringPicker(model: model, title: "Skin", key: "skin", choices: [("deep", "Deep"), ("flat", "Flat")])
            ModStringPicker(model: model, title: "Language", key: "language", choices: [("auto", "Automatic"), ("en", "English"), ("ko", "Korean"), ("zh", "Chinese"), ("ja", "Japanese"), ("es", "Spanish"), ("pt", "Portuguese")])
            visibility("Timer", entry: "timer", key: "hide", inverted: true)
            visibility("Routing", entry: "route", key: "hide", inverted: true)
            visibility("Context", entry: "context", key: "extras", inverted: false)
            visibility("Limits", entry: "limits", key: "extras", inverted: false)
        } header: { Label("Look", systemImage: "paintpalette") }
        footer: { FormNote("These controls change the Claude Code mod, not this app. Controls unsupported by your router version are hidden.") }
    }

    @ViewBuilder
    private func visibility(_ title: String, entry: String, key: String, inverted: Bool) -> some View {
        if model.settings[key]?.arrayValue != nil {
            Toggle("Show \(title.lowercased())", isOn: Binding(get: {
                let contains = model.settings[key]?.arrayValue?.contains(.string(entry)) == true
                return inverted ? !contains : contains
            }, set: { on in
                var values = model.settings[key]?.arrayValue ?? []
                values.removeAll { $0 == .string(entry) }
                if inverted ? !on : on { values.append(.string(entry)) }
                model.set(.array(values), key: key)
            }))
        }
    }
}
