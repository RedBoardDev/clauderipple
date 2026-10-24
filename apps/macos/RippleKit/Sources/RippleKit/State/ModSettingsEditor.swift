import Foundation

public enum ModSettingsValidationError: Error, LocalizedError, Equatable, Sendable {
    case invalid(String)
    public var errorDescription: String? { if case let .invalid(message) = self { message } else { nil } }
}

/// Pure editing and three-way merge. Arrays are atomic; objects merge by key path, except rule-mode changes.
public struct ModSettingsEditor: Sendable {
    /// The router's schema and credential-free settings size limit.
    public static let schemaVersion = 1
    public static let maximumBytes = 64 * 1024
    public static let maximumModes = 20
    public static let maximumNameLength = 40
    public static let maximumRevision: Double = 9_007_199_254_740_991
    public static let maximumSaveAttempts = 3
    /// Matches the dashboard's pause before persisting a control change.
    public static let debounce: Duration = .milliseconds(450)
    public static let biasRange = -2...2
    public static let warmHours = [1, 2, 4, 8]
    public static let warmMinimums = [10_000, 30_000, 60_000, 100_000]
    public static let swampThresholds = [40, 50, 60, 70]
    /// Wire dates are epoch milliseconds, not Foundation seconds.
    public static let millisecondsPerSecond: Double = 1000
    public static let defaultModeDuration: TimeInterval = 3 * 60 * 60

    public private(set) var base: ModSettingsSnapshot
    public private(set) var settings: JSONValue
    public var isDirty: Bool { settings != base.settings }

    public init(snapshot: ModSettingsSnapshot) {
        base = snapshot
        settings = snapshot.settings
    }

    public mutating func set(_ value: JSONValue?, at path: [String]) {
        settings.set(value, at: path)
    }

    /// Moving either bound past the other moves that other bound too; an inverted range is never saved.
    public mutating func setEffortBound(_ effort: ModEffort, floor: Bool) {
        settings[floor ? "floor" : "ceiling"] = .string(effort.rawValue)
        let otherKey = floor ? "ceiling" : "floor"
        if let raw = settings[otherKey]?.stringValue, let other = ModEffort(rawValue: raw),
           floor ? effort.rank > other.rank : effort.rank < other.rank {
            settings[otherKey] = .string(effort.rawValue)
        }
    }

    public struct Change: Sendable, Equatable {
        public let path: [String]
        public let value: JSONValue?
    }

    public static func changes(from before: JSONValue?, to after: JSONValue?, path: [String] = []) -> [Change] {
        guard before != after else { return [] }
        if let before, let after, before.objectValue != nil, after.objectValue != nil,
           before["mode"] == after["mode"] {
            let keys = before.keys + after.keys.filter { !before.keys.contains($0) }
            return keys.flatMap { changes(from: before[$0], to: after[$0], path: path + [$0]) }
        }
        return [Change(path: path, value: after)]
    }

    public static func applying(_ changes: [Change], to document: JSONValue) -> JSONValue {
        var result = document
        for change in changes { result.set(change.value, at: change.path) }
        return result
    }

    public mutating func rebase(on snapshot: ModSettingsSnapshot) {
        settings = Self.applying(Self.changes(from: base.settings, to: settings), to: snapshot.settings)
        base = snapshot
    }

    /// A response must not erase edits made while its request was in flight.
    public mutating func acknowledge(_ snapshot: ModSettingsSnapshot, sent: JSONValue) {
        settings = Self.applying(Self.changes(from: sent, to: settings), to: snapshot.settings)
        base = snapshot
    }

    public func putBody() throws -> JSONValue {
        try Self.validate(settings)
        return .object([("schemaVersion", .int(Self.schemaVersion)), ("settings", settings), ("revision", .int(base.revision))])
    }

    public static func validate(_ settings: JSONValue) throws {
        func reject(_ message: String) throws { throw ModSettingsValidationError.invalid(message) }
        guard settings.objectValue != nil else { try reject("Settings must be a JSON object."); return }
        guard settings.data().count <= maximumBytes else { try reject("Settings exceed 64 KiB."); return }
        let forbidden = Set(["key", "apikey", "token", "secret", "password", "passwd", "authorization", "credential", "credentials", "bearer"])
        var pending = [settings]
        while let value = pending.popLast() {
            if let pairs = value.objectValue {
                for (key, child) in pairs {
                    let separated = key.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
                    let last = separated.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.last?.lowercased() ?? ""
                    if forbidden.contains(last) { try reject("Settings must not contain credential fields.") }
                    pending.append(child)
                }
            } else if let array = value.arrayValue { pending.append(contentsOf: array) }
        }
        if let raw = settings["bias"]?.doubleValue, !raw.isFinite || raw.rounded() != raw || !(-2...2).contains(raw) {
            try reject("Effort bias must be an integer from −2 to +2.")
        }
        if let floor = settings["floor"]?.stringValue.flatMap(ModEffort.init(rawValue:)),
           let ceiling = settings["ceiling"]?.stringValue.flatMap(ModEffort.init(rawValue:)), floor.rank > ceiling.rank {
            try reject("The effort floor cannot exceed the ceiling.")
        }
        if let modes = settings["modes"]?.arrayValue {
            if modes.count > maximumModes { try reject("At most 20 operating modes can be saved.") }
            for mode in modes {
                let name = mode["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if name.isEmpty || name.count > maximumNameLength { try reject("Mode names must contain 1–40 characters.") }
            }
        }
    }

    public enum RungEdit: Sendable {
        case add(JSONValue)
        case remove(Int)
        case move(Int, Int)
        case replace(Int, JSONValue)
    }

    public static func editing(_ steps: JSONValue, _ edit: RungEdit) -> JSONValue {
        var items = steps.arrayValue ?? []
        switch edit {
        case let .add(step): items.append(step)
        case let .remove(index):
            if items.count > 1, items.indices.contains(index) { items.remove(at: index) }
        case let .move(index, destination):
            if items.indices.contains(index), items.indices.contains(destination) {
                let step = items.remove(at: index)
                items.insert(step, at: destination)
            }
        case let .replace(index, step):
            if items.indices.contains(index) { items[index] = step }
        }
        return .array(items)
    }

    public static func isAllowed(_ choice: ModWorkerChoice, in settings: JSONValue) -> Bool {
        let allow = settings["allow"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let known = settings["allowKnown"]?.arrayValue?.compactMap(\.stringValue) ?? []
        return allow.isEmpty || allow.contains(choice.id) || allow.contains(choice.provider)
            || (!known.isEmpty && !known.contains(choice.id))
    }

    /// Empty means all, never none. Preserve unknown saved allow entries across catalog changes.
    public mutating func setAllowed(_ choice: ModWorkerChoice, on: Bool, choices: [ModWorkerChoice]) {
        let tickable = choices.filter { $0.id != "general-purpose" }
        var enabled = tickable.filter { Self.isAllowed($0, in: settings) }.map(\.id)
        if on, !enabled.contains(choice.id) { enabled.append(choice.id) }
        if !on { enabled.removeAll { $0 == choice.id } }
        guard !enabled.isEmpty else { return }
        let all = tickable.map(\.id)
        let unknown = (settings["allow"]?.arrayValue?.compactMap(\.stringValue) ?? []).filter { key in
            !all.contains(key) && !tickable.contains { $0.provider == key }
        }
        let allow = enabled.count == all.count ? [] : enabled + unknown
        settings["allow"] = .array(allow.map(JSONValue.string))
        if settings["allowKnown"] != nil { settings["allowKnown"] = .array(allow.isEmpty ? [] : all.map(JSONValue.string)) }
    }
}
