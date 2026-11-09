import Foundation

/// Schema 2 domains use the same ladder shape; review is not a separate worker format.
/// WHY: validate the editable facts but retain the original JSON document, including unknown fields.
public struct ModDomainLadder: Decodable, Sendable {
    public struct Step: Decodable, Sendable {
        public struct Target: Decodable, Sendable {
            public let agent: String
            // Native general-purpose workers select a model; named workers omit it.
            public let model: String?
        }
        public let target: Target
        public let effort: String
    }
    public let mode: String
    public let rungs: [String: [Step]]
}

struct ModSettingsContract: Decodable {
    struct Domains: Decodable {
        // Absent domains inherit the selected worker set's general ladder.
        let ui: ModDomainLadder?
        let backend: ModDomainLadder?
        let review: ModDomainLadder?
    }
    struct Rules: Decodable { let general: ModDomainLadder }
    struct Mode: Decodable {
        let id: String
        let name: String
        let rungs: [String: [ModDomainLadder.Step]]
        // Modes without domain overrides inherit their general ladder.
        let domainRules: Domains?
    }
    let effortAuto: Bool
    let agentAuto: String
    let bias: Int
    let floor: String
    let ceiling: String
    let judge: String
    let judgeModel: String
    let jevSource: String
    let rules: Rules
    let allow: [String]
    let allowKnown: [String]
    let modes: [Mode]
    let delegation: String
    let keepWarm: Bool
    let keepWarmHours: Int
    let keepWarmMinTokens: Int
    let compactModel: String
    let compactModels: [String]
    let swampAlert: Bool
    let layout: String
    let appearance: String
    let skin: String
    let language: String
    let hide: [String]
    let extras: [String]
    let setupDone: Bool
    // A worker set without overrides uses only rules.general.
    let domainRules: Domains?
}
