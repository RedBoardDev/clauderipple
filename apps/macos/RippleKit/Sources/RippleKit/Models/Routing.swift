import Foundation

/// Credential-free projections of the in-memory config. Never persist the source document.
public struct RoutingModel: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String?
    public let effortLevels: [String]?
    public let contextWindow: Int?
    public var label: String { name ?? id }
}

public struct ClaudeModelsResponse: Decodable, Sendable {
    public let models: [RoutingModel]
    public let source: String
}

public struct EffortLevelsResponse: Decodable, Sendable {
    public struct Provider: Decodable, Sendable {
        public let `default`: [String]
        public let models: [String: [String]]?
    }
    public let providers: [String: Provider]

    public func levels(provider: String, model: RoutingModel?) -> [String] {
        if let entry = providers[provider] {
            return model.flatMap { entry.models?[$0.id] } ?? entry.default
        }
        return model?.effortLevels ?? []
    }
}

public struct ContextWindowsResponse: Decodable, Sendable {
    public let windows: [String: Int]
}

public struct RoutingProvider: Sendable, Identifiable {
    public let id: String
    public let type: String
    public let models: [RoutingModel]
}

public struct ModelRoute: Sendable, Identifiable {
    public var id: String { source }
    public let source: String
    public let provider: String
    public let model: String
    public let effort: String?
    public let contextWindow: Int?
}

public struct RoutingConfiguration: Sendable {
    public let providers: [RoutingProvider]
    public let routes: [ModelRoute]
    public let cliSlots: [String: String]
    public let extraModels: [JSONValue]
    public let limitWorkerTools: Bool
    public let webSearch: SearchBackend?
    public let direct: [JSONValue]

    public init(document: JSONValue) {
        providers = (document["providers"]?.objectValue ?? []).compactMap { pair in
            let type = pair.value["type"]?.stringValue ?? ""
            // Ingress-only Claude providers cannot answer routed Claude traffic.
            guard type != "anthropic" || pair.value["accountPool"]?.boolValue == true else { return nil }
            let models = (pair.value["models"]?.arrayValue ?? []).compactMap { try? $0.decode(RoutingModel.self) }
            return RoutingProvider(id: pair.key, type: type, models: models)
        }
        routes = (document["routes"]?.objectValue ?? []).compactMap { pair in
            guard let provider = pair.value["provider"]?.stringValue,
                let model = pair.value["model"]?.stringValue
            else { return nil }
            return ModelRoute(
                source: pair.key, provider: provider, model: model,
                effort: pair.value["effort"]?.stringValue,
                contextWindow: pair.value["contextWindow"]?.intValue)
        }
        cliSlots = Dictionary(
            uniqueKeysWithValues: (document.value(at: ["cli", "models"])?.objectValue ?? []).compactMap { pair in
                pair.value.stringValue.map { (pair.key, $0) }
            })
        extraModels = document.value(at: ["cli", "extraModels"])?.arrayValue ?? []
        limitWorkerTools = document.value(at: ["cli", "limitWorkerTools"])?.boolValue ?? false
        webSearch = document["webSearch"].flatMap(SearchBackend.init)
        direct = document["direct"]?.arrayValue ?? []
    }

    /// One picker checkbox per model id; an existing longest-prefix rule settles duplicate owners.
    public var pickerModels: [PickerModelChoice] {
        var seen = Set<String>()
        return providers.flatMap(\.models).compactMap { model in
            guard seen.insert(model.id).inserted else { return nil }
            let owners = providers.filter { $0.models.contains { $0.id == model.id } }
            let rule = direct.filter { rule in
                rule["prefix"]?.stringValue.map { model.id.hasPrefix($0) } ?? false
            }.max { ($0["prefix"]?.stringValue?.count ?? 0) < ($1["prefix"]?.stringValue?.count ?? 0) }
            let owner = owners.first { $0.id == rule?["provider"]?.stringValue } ?? owners.first
            guard let owner else { return nil }
            return PickerModelChoice(provider: owner.id, model: owner.models.first { $0.id == model.id } ?? model)
        }
    }
}

public struct PickerModelChoice: Sendable, Identifiable {
    public var id: String { model.id }
    public let provider: String
    public let model: RoutingModel
}

public struct SearchBackend: Sendable, Equatable, Hashable {
    public let provider: String
    public let model: String

    public init(provider: String, model: String) {
        self.provider = provider
        self.model = model
    }

    public init?(document: JSONValue) {
        guard let provider = document["provider"]?.stringValue,
            let model = document["model"]?.stringValue
        else { return nil }
        self.init(provider: provider, model: model)
    }
}

/// Additional status fields kept separate from the shared RouterStatus projection.
public struct ClientCapabilities: Sendable {
    public let pickerLastAt: String?
    public let pickerInjected: Int?
    public let pickerModels: [String]
    public let searchProviders: Set<String>
    public let searchModels: [String: Set<String>]

    public init(document: JSONValue) {
        pickerLastAt = document.value(at: ["picker", "last", "at"])?.stringValue
        pickerInjected = document.value(at: ["picker", "last", "injected"])?.intValue
        pickerModels = (document["pickerModels"]?.arrayValue ?? []).compactMap(\.stringValue)
        searchProviders = Set((document["providers"]?.objectValue ?? []).filter { $0.value["webSearch"]?.boolValue == true }.map(\.key))
        searchModels = Dictionary(
            uniqueKeysWithValues: (document["providers"]?.objectValue ?? []).map { pair in
                (pair.key, Set((pair.value["webSearchModels"]?.arrayValue ?? []).compactMap(\.stringValue)))
            })
    }

    public func canSearch(provider: String, model: String) -> Bool {
        searchProviders.contains(provider) || searchModels[provider]?.contains(model) == true
    }
}

public struct CodexIntegration: Decodable, Sendable {
    public let enabled: Bool
    public let codexHome: String
    public let configPath: String
}

public struct ClientCommandResult: Decodable, Sendable {
    public let ok: Bool
    public let output: String
}

public enum CliModelSlot: String, CaseIterable, Sendable {
    case main, smallFast, subagent
}
