import Foundation

public enum ConfigEditError: Error, Sendable, Equatable, LocalizedError {
    case duplicateRoute(String)
    case missingRoute(String)
    case invalidContextWindow

    public var errorDescription: String? {
        switch self {
        case .duplicateRoute(let source): "A mapping for \(source) already exists."
        case .missingRoute(let source): "The mapping for \(source) changed elsewhere. Reload before editing it."
        case .invalidContextWindow: "Enter a positive, whole context window, or leave it empty."
        }
    }
}

/// Small ordered operations rebased onto updateConfig's fresh document, never a replacement config.
public enum RouteEdit: Sendable {
    case add(source: String, provider: String, model: String, effort: String?)
    case change(source: String, field: Field, value: JSONValue?)
    case rename(source: String, destination: String)
    case remove(source: String)

    public enum Field: String, Sendable { case provider, model, effort, contextWindow }
}

public enum ConfigEdits {
    public static func apply(_ edits: [RouteEdit], to config: inout JSONValue) throws {
        // Apply atomically even when the caller also uses this pure function outside updateConfig.
        var next = config
        for edit in edits {
            switch edit {
            case .add(let source, let provider, let model, let effort):
                guard next["routes"]?[source] == nil else { throw ConfigEditError.duplicateRoute(source) }
                var route = JSONValue.object([("provider", .string(provider)), ("model", .string(model))])
                if let effort { route["effort"] = .string(effort) }
                next.set(route, at: ["routes", source])
            case .change(let source, let field, let value):
                guard next["routes"]?[source] != nil else { throw ConfigEditError.missingRoute(source) }
                if field == .contextWindow, let value {
                    guard let number = value.doubleValue, number.isFinite, number > 0, number.rounded() == number else {
                        throw ConfigEditError.invalidContextWindow
                    }
                }
                next.set(value, at: ["routes", source, field.rawValue])
            case .rename(let source, let destination):
                guard source != destination else { continue }
                guard next["routes"]?[destination] == nil else { throw ConfigEditError.duplicateRoute(destination) }
                guard let pairs = next["routes"]?.objectValue, pairs.contains(where: { $0.key == source }) else {
                    throw ConfigEditError.missingRoute(source)
                }
                next["routes"] = .object(pairs.map { ($0.key == source ? destination : $0.key, $0.value) })
            case .remove(let source):
                next.set(nil, at: ["routes", source])
            }
        }
        config = next
    }

    /// Empty is intentional: the router clears an env key only when that slot is present as "".
    public static func setSlot(_ slot: CliModelSlot, model: String, in config: inout JSONValue) {
        config.set(.string(model), at: ["cli", "models", slot.rawValue])
    }

    public static func setLimitWorkerTools(_ enabled: Bool, in config: inout JSONValue) {
        config.set(.bool(enabled), at: ["cli", "limitWorkerTools"])
    }

    public static func setWebSearch(_ backend: SearchBackend?, in config: inout JSONValue) {
        guard let backend else {
            config["webSearch"] = nil
            return
        }
        // maxResults and future options belong to the router, not this model picker.
        config.set(.string(backend.provider), at: ["webSearch", "provider"])
        config.set(.string(backend.model), at: ["webSearch", "model"])
    }

    /// Picker exposure is deduplicated by id. Direct rules are needed only for ambiguous owners;
    /// prefix rules and unticked ambiguous models retain their routing, as on the dashboard.
    public static func setPickerModel(provider: String, model: String, enabled: Bool, in config: inout JSONValue) {
        let projection = RoutingConfiguration(document: config)
        let known = Set(projection.providers.flatMap(\.models).map(\.id))
        guard known.contains(model) else { return }
        let current = projection.extraModels
        let orphans = Set(current.compactMap { $0["model"]?.stringValue }.filter { !known.contains($0) })
        var seen = Set<String>()
        var extras = current.filter { entry in
            guard let id = entry["model"]?.stringValue, known.contains(id), seen.insert(id).inserted else { return false }
            return id != model || enabled
        }
        if enabled, !extras.contains(where: { $0["model"]?.stringValue == model }),
            let entry = projection.providers.first(where: { $0.id == provider })?.models.first(where: { $0.id == model })
        {
            var extra = JSONValue.object([("model", .string(model)), ("name", .string(entry.label))])
            if let window = entry.contextWindow, window > 0 { extra["contextWindow"] = .int(window) }
            extras.append(extra)
        }
        config.set(.array(extras), at: ["cli", "extraModels"])
        let owners: (String) -> [RoutingProvider] = { id in
            projection.providers.filter { $0.models.contains { $0.id == id } }
        }
        var direct = projection.direct.filter { rule in
            guard let prefix = rule["prefix"]?.stringValue else { return true }
            return !orphans.contains(prefix) && (!known.contains(prefix) || owners(prefix).count > 1)
        }
        if enabled, owners(model).count > 1, !direct.contains(where: { $0["prefix"]?.stringValue == model }) {
            direct.append(.object([("prefix", .string(model)), ("provider", .string(provider))]))
        }
        if config["direct"] != nil || !direct.isEmpty { config["direct"] = .array(direct) }
    }

    public static func setPickerContext(model: String, window: Int?, in config: inout JSONValue) throws {
        if let window, window <= 0 { throw ConfigEditError.invalidContextWindow }
        var extras = config.value(at: ["cli", "extraModels"])?.arrayValue ?? []
        for index in extras.indices where extras[index]["model"]?.stringValue == model {
            extras[index]["contextWindow"] = window.map(JSONValue.int)
        }
        config.set(.array(extras), at: ["cli", "extraModels"])
    }

    public static func contextWindow(_ text: String) throws -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        guard let value = Int(trimmed), value > 0 else { throw ConfigEditError.invalidContextWindow }
        return value
    }
}
