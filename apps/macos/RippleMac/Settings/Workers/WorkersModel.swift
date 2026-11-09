import Foundation
import Observation
import RippleKit

@MainActor
@Observable
final class WorkersModel {
    var loadState: Loadable<Bool> = .loading
    var editor: ModSettingsEditor?
    var options: ModOptions?
    var optionsError: String?
    var saveError: String?
    var saving = false
    var schemaUnsupported = false
    var selectedMode = ""
    var newModeName = ""
    private var client: AdminClient?
    private var debounceTask: Task<Void, Never>?

    var settings: JSONValue { editor?.settings ?? .object([]) }
    var status: String {
        if schemaUnsupported { return "Saving unavailable" }
        if saving || debounceTask != nil { return "Saving…" }
        if saveError != nil { return "Not saved" }
        return editor?.isDirty == true ? "Unsaved changes" : "Saved"
    }

    func load(client: AdminClient) async {
        guard !saving, debounceTask == nil else { return }
        self.client = client
        do {
            async let snapshot = client.modSettings()
            async let optionsResult = fetchOptions(client)
            let fresh = try await snapshot
            if editor != nil { editor?.rebase(on: fresh) } else { editor = ModSettingsEditor(snapshot: fresh) }
            reconcileModeSelection()
            let result = await optionsResult
            options = result.0
            optionsError = result.1
            loadState = .loaded(true)
        } catch { loadState = .failed(error.asAdminError) }
    }

    private func fetchOptions(_ client: AdminClient) async -> (ModOptions?, String?) {
        do { return (try await client.modOptions(), nil) }
        catch { return (nil, "Model choices couldn't load. Existing settings are preserved. \(error.asAdminError.userMessage)") }
    }

    func edit(_ update: (inout ModSettingsEditor) -> Void) {
        guard var editor, !schemaUnsupported else { return }
        update(&editor)
        self.editor = editor
        scheduleSave()
    }

    func set(_ value: JSONValue?, at path: [String]) { edit { $0.set(value, at: path) } }
    func set(_ value: JSONValue?, key: String) { set(value, at: [key]) }

    private func scheduleSave() {
        debounceTask?.cancel()
        saveError = nil
        debounceTask = Task { [weak self] in
            do { try await Task.sleep(for: ModSettingsEditor.debounce) } catch { return }
            guard let self else { return }
            self.debounceTask = nil
            await self.save()
        }
    }

    func save() async {
        guard !schemaUnsupported, !saving, let client, let sent = editor, sent.isDirty else { return }
        saving = true
        saveError = nil
        do {
            let snapshot = try await client.saveModSettings(sent)
            editor?.acknowledge(snapshot, sent: sent.settings)
            reconcileModeSelection()
            saving = false
            if editor?.isDirty == true, debounceTask == nil { scheduleSave() }
        } catch {
            saving = false
            if case ModSaveError.unsupportedSchema = error {
                schemaUnsupported = true
                debounceTask?.cancel()
                debounceTask = nil
            }
            if case let ModSaveError.conflict(snapshot) = error {
                // Match the dashboard: after three moving revisions, adopt the current copy and stop.
                debounceTask?.cancel()
                debounceTask = nil
                editor = ModSettingsEditor(snapshot: snapshot)
                reconcileModeSelection()
            }
            saveError = (error as? LocalizedError)?.errorDescription ?? error.asAdminError.userMessage
        }
    }

    private func reconcileModeSelection() {
        if !selectedMode.isEmpty, mode == nil { selectedMode = "" }
    }

    var modes: [JSONValue] { settings["modes"]?.arrayValue ?? [] }
    var mode: JSONValue? { modes.first { $0["id"]?.stringValue == selectedMode } }
    var rungs: JSONValue {
        mode?["rungs"] ?? settings.value(at: ["rules", "general", "rungs"]) ?? .object([])
    }

    func updateMode(_ key: String, value: JSONValue?) {
        let next = modes.map { mode in
            guard mode["id"]?.stringValue == selectedMode else { return mode }
            var updated = mode
            updated[key] = value
            return updated
        }
        set(.array(next), key: "modes")
    }

    func editRung(_ rung: ModRung, edit operation: ModSettingsEditor.RungEdit) {
        var next = rungs
        next[rung.rawValue] = ModSettingsEditor.editing(next[rung.rawValue] ?? .array([]), operation)
        if mode != nil { updateMode("rungs", value: next) }
        else { set(next, at: ["rules", "general", "rungs"]) }
    }

    func createMode() {
        let name = newModeName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= ModSettingsEditor.maximumNameLength,
              modes.count < ModSettingsEditor.maximumModes else { return }
        let id = "mode-\(UUID().uuidString.lowercased())"
        var mode = JSONValue.object([("id", .string(id)), ("name", .string(name)),
                                     ("rungs", settings.value(at: ["rules", "general", "rungs"]) ?? .object([])),
                                     ("until", .string("none"))])
        // Old routers do not know delegation: never introduce an unsupported field.
        if settings["delegation"] != nil { mode["delegation"] = .string("normal") }
        set(.array(modes + [mode]), key: "modes")
        selectedMode = id
        newModeName = ""
    }

    func activate(_ id: String) {
        edit {
            $0.set(id.isEmpty ? nil : .string(id), at: ["activeMode"])
            $0.set(id.isEmpty ? nil : .double(Date().timeIntervalSince1970 * ModSettingsEditor.millisecondsPerSecond), at: ["activeSince"])
        }
    }

    func removeMode() {
        let id = selectedMode
        edit {
            $0.set(.array(modes.filter { $0["id"]?.stringValue != id }), at: ["modes"])
            if settings["activeMode"]?.stringValue == id {
                $0.set(nil, at: ["activeMode"])
                $0.set(nil, at: ["activeSince"])
            }
        }
        selectedMode = ""
    }
}
