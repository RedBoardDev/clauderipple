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
        guard let settings = document["settings"], settings.objectValue != nil,
              let number = document["revision"]?.doubleValue, number.isFinite,
              number >= 0, number <= ModSettingsEditor.maximumRevision, number.rounded() == number else {
            throw AdminError.decoding("invalid mod settings snapshot")
        }
        self.init(settings: settings, revision: Int(number), legacy: document["legacy"]?.boolValue == true)
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
    }
    public struct Model: Decodable, Sendable {
        public let model: String
        public let provider: String
        public let name: String?
        public let judgeOnly: Bool?
    }
    public struct Provider: Decodable, Sendable {
        public let name: String
        public let type: String
        public let usable: Bool
        public let billing: String?
        public let reason: String?
    }
    public let agents: [Agent]
    public let models: [Model]
    public let providers: [Provider]
    public let claudeEfforts: [String]?

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
