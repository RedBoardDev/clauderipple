import Foundation

/// A typed envelope around an untouched, order-preserving settings document.
public struct ModSettingsSnapshot: Sendable, Equatable {
    public let settings: JSONValue
    public let revision: Int
    public let legacy: Bool

    public init(settings: JSONValue, revision: Int, legacy: Bool = false) {
        self.settings = settings
        self.revision = revision
        self.legacy = legacy
    }

    public init(document: JSONValue) throws {
        let route = "/api/mod-settings"
        let _: ModSettingsContract = try document.required("settings", route: route)
        let number: Int = try document.required("revision", route: route)
        guard number >= 0, Double(number) <= ModSettingsEditor.maximumRevision else {
            throw AdminError.incompatible(route: route, codingPath: "revision")
        }
        let _: Bool = try document.required("stored", route: route)
        let _: Int? = try document.required("compactAt", route: route)
        // legacy is only sent when the store contained retired routing rules.
        let legacy = try document["legacy"].map { _ in try document.required("legacy", route: route, as: Bool.self) } ?? false
        self.init(settings: document["settings"]!, revision: number, legacy: legacy)
    }
}

public enum ModEffort: String, CaseIterable, Sendable {
    case low, medium, high, xhigh, max
    public var title: String { rawValue == "xhigh" ? "Extra high" : rawValue.capitalized }
    public var rank: Int { Self.allCases.firstIndex(of: self)! }
}

public enum ModRung: String, CaseIterable, Sendable {
    case light, standard, hard, plan
    public var title: String { rawValue.capitalized }
}

public struct ModOptions: Decodable, Sendable {
    public struct Agent: Decodable, Sendable {
        public let name: String
        public let model: String
        public let provider: String
        public let efforts: [String]?
        public let billing: String?

        enum CodingKeys: String, CodingKey { case name, model, provider, efforts, billing }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            model = try c.decode(String.self, forKey: .model)
            provider = try c.decode(String.self, forKey: .provider)
            efforts = try c.decode([String].self, forKey: .efforts)
            billing = try c.decode(String.self, forKey: .billing)
        }
    }
    public struct Model: Decodable, Sendable {
        public let model: String
        public let provider: String
        public let name: String?
        public let judgeOnly: Bool?

        enum CodingKeys: String, CodingKey { case model, provider, name, judgeOnly }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            model = try c.decode(String.self, forKey: .model)
            provider = try c.decode(String.self, forKey: .provider)
            name = try c.decode(String.self, forKey: .name)
            judgeOnly = try c.decode(Bool.self, forKey: .judgeOnly)
        }
    }
    public struct Provider: Decodable, Sendable {
        public let name: String
        public let type: String
        public let usable: Bool
        public let billing: String?
        public let reason: String?

        enum CodingKeys: String, CodingKey { case name, type, usable, billing, reason }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            type = try c.decode(String.self, forKey: .type)
            usable = try c.decode(Bool.self, forKey: .usable)
            billing = try c.decode(String.self, forKey: .billing)
            // Only exhausted providers carry a reason.
            reason = try c.decodeIfPresent(String.self, forKey: .reason)
        }
    }
    public let agents: [Agent]
    public let models: [Model]
    public let providers: [Provider]
    public let claudeEfforts: [String]?

    enum CodingKeys: String, CodingKey { case agents, models, providers, claudeEfforts }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = try c.decode([Agent].self, forKey: .agents)
        models = try c.decode([Model].self, forKey: .models)
        providers = try c.decode([Provider].self, forKey: .providers)
        claudeEfforts = try c.decode([String].self, forKey: .claudeEfforts)
    }

    public var workerChoices: [ModWorkerChoice] {
        let workers = agents.map { agent in
            let provider = providers.first { $0.name == agent.provider }
            return ModWorkerChoice(agent: agent.name, model: nil, label: agent.model,
                                   provider: agent.provider, billing: agent.billing ?? provider?.billing,
                                   usable: provider?.usable ?? true, reason: provider?.reason,
                                   efforts: agent.efforts ?? [])
        }
        let native = ["haiku", "sonnet", "opus", "fable"].map { model in
            ModWorkerChoice(agent: "general-purpose", model: model, label: "Claude \(model.capitalized)",
                            provider: "anthropic", billing: "subscription", usable: true,
                            reason: nil, efforts: claudeEfforts ?? [])
        }
        return workers + native + [ModWorkerChoice(agent: "general-purpose", model: nil,
            label: "Session model", provider: "", billing: nil, usable: true,
            reason: nil, efforts: claudeEfforts ?? [])]
    }
}

public struct ModWorkerChoice: Sendable, Identifiable {
    public let agent: String
    public let model: String?
    public let label: String
    public let provider: String
    public let billing: String?
    public let usable: Bool
    public let reason: String?
    public let efforts: [String]
    public var id: String { model.map { "\(agent):\($0)" } ?? agent }
    public var target: JSONValue {
        var value = JSONValue.object([("agent", .string(agent))])
        if let model { value["model"] = .string(model) }
        return value
    }
    public var availableEfforts: [ModEffort] {
        let known = efforts.compactMap(ModEffort.init(rawValue:))
        return known.isEmpty ? ModEffort.allCases : known
    }
    public var billingTitle: String? {
        switch billing {
        case "free": "Free"
        case "payg": "Pay per token"
        case "subscription": "Subscription"
        default: billing
        }
    }
    public var menuTitle: String {
        [label, provider.isEmpty ? nil : provider, billingTitle, usable ? nil : "Unavailable now"]
            .compactMap { $0 }.joined(separator: " · ")
    }
    public static func key(for target: JSONValue?) -> String {
        let agent = target?["agent"]?.stringValue ?? ""
        return target?["model"]?.stringValue.map { "\(agent):\($0)" } ?? agent
    }
}
