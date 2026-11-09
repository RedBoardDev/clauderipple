import Foundation

/// `GET /api/status`: required router facts fail closed; unknown additive fields are ignored.
public struct RouterStatus: Sendable {
    public struct Readiness: Decodable, Sendable, Equatable {
        public let ready: Bool
        public let problems: [String]
    }

    public struct Runtime: Decodable, Sendable, Equatable {
        public let node: String?
        public let router: String?
        /// ISO 8601.
        public let startedAt: String?

        enum CodingKeys: String, CodingKey { case node, router, startedAt }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            node = try c.decode(String.self, forKey: .node)
            // Node may have no argv[1] when embedded; the router sends an explicit null.
            router = try c.decode(String?.self, forKey: .router)
            startedAt = try c.decode(String.self, forKey: .startedAt)
        }
    }

    public struct Stats: Decodable, Sendable, Equatable {
        public let inFlight: Int
        public let messagesInFlight: Int?
        public let started: Int?
        public let completed: Int?
        public let failed: Int?

        enum CodingKeys: String, CodingKey { case inFlight, messagesInFlight, started, completed, failed }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            inFlight = try c.decode(Int.self, forKey: .inFlight)
            messagesInFlight = try c.decode(Int.self, forKey: .messagesInFlight)
            started = try c.decode(Int.self, forKey: .started)
            completed = try c.decode(Int.self, forKey: .completed)
            failed = try c.decode(Int.self, forKey: .failed)
        }
    }

    public struct Exhaustion: Decodable, Sendable, Equatable {
        public let reason: String
        /// Epoch milliseconds.
        public let until: Double?
    }

    public struct Provider: Decodable, Sendable, Equatable, Identifiable {
        public var id: String { name }
        /// The config key; filled from the enclosing object, not decoded.
        public var name: String = ""
        public let type: String
        public let url: String?
        public let reachable: Bool
        public let usable: Bool
        public let exhaustion: Exhaustion?
        public let needsLogin: Bool?
        public let needsVerification: Bool?
        public let authSource: String?
        public let signedIn: String?
        public let accountCount: Int?

        enum CodingKeys: String, CodingKey {
            case type, url, reachable, usable, exhaustion, needsLogin, needsVerification, authSource, signedIn, accountCount, webSearch, webSearchModels
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            url = try c.decode(String.self, forKey: .url)
            reachable = try c.decode(Bool.self, forKey: .reachable)
            usable = try c.decode(Bool.self, forKey: .usable)
            // Only exhausted providers carry exhaustion; only login-backed providers have login flags.
            exhaustion = try c.decodeIfPresent(Exhaustion.self, forKey: .exhaustion)
            needsLogin = try c.decodeIfPresent(Bool.self, forKey: .needsLogin)
            needsVerification = try c.decodeIfPresent(Bool.self, forKey: .needsVerification)
            // Search capability is omitted for providers/models without a search backend.
            _ = try c.decodeIfPresent(Bool.self, forKey: .webSearch)
            _ = try c.decodeIfPresent([String].self, forKey: .webSearchModels)
            if type == "anthropic" {
                // API-key providers explicitly send null for authSource/signedIn and zero accounts.
                authSource = try c.decode(String?.self, forKey: .authSource)
                signedIn = try c.decode(String?.self, forKey: .signedIn)
                accountCount = try c.decode(Int.self, forKey: .accountCount)
            } else {
                authSource = nil
                signedIn = nil
                accountCount = nil
            }
        }
    }

    /// A pooled credential's runtime state (`status.credentials[provider]`). For the Claude account
    /// pool the ids are the stored Claude account ids.
    public struct Credential: Decodable, Sendable, Equatable {
        public let id: String
        public let label: String?
        public let state: String
        public let cooldownSeconds: Double?
        public let failures: Int?

        enum CodingKeys: String, CodingKey { case id, label, state, cooldownSeconds, failures }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            state = try c.decode(String.self, forKey: .state)
            failures = try c.decode(Int.self, forKey: .failures)
            // Unlabelled keys omit label; credentials outside cooldown omit cooldownSeconds.
            label = try c.decodeIfPresent(String.self, forKey: .label)
            cooldownSeconds = try c.decodeIfPresent(Double.self, forKey: .cooldownSeconds)
        }
    }

    public struct Picker: Decodable, Sendable, Equatable {
        public let enabled: Bool
        struct Last: Decodable {
            let at: String
            let injected: Int
        }
        enum CodingKeys: String, CodingKey { case enabled, last }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            enabled = try c.decode(Bool.self, forKey: .enabled)
            // No bootstrap injection yet is an explicit null.
            _ = try c.decode(Last?.self, forKey: .last)
        }
    }

    public struct ProxySettings: Decodable, Sendable, Equatable {
        public let pointsAtRouter: Bool?

        enum CodingKeys: String, CodingKey { case pointsAtRouter }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pointsAtRouter = try c.decode(Bool.self, forKey: .pointsAtRouter)
        }
    }

    public let version: String
    public let readiness: Readiness?
    public let runtime: Runtime?
    public let stats: Stats?
    public let consecutiveUpstreamFailures: Int?
    public let routes: Int?
    public let adminPort: Int?
    public let cliVersion: String?
    public let uiRevision: String?
    public let statusMod: Bool?
    public let picker: Picker?
    public let settings: ProxySettings?
    /// In config order.
    public let providers: [Provider]
    /// ChatGPT accounts per ChatGPT provider, in config order.
    public let chatgptAccounts: [(provider: String, accounts: [ChatGptAccount])]
    public let chatgptStale: Bool
    public let credentials: [String: [Credential]]

    public init(document: JSONValue) throws {
        let route = "/api/status"
        version = try document.required("version", route: route)
        readiness = try document.required("readiness", route: route, as: Readiness.self)
        runtime = try document.required("runtime", route: route, as: Runtime.self)
        stats = try document.required("stats", route: route, as: Stats.self)
        consecutiveUpstreamFailures = try document.required("consecutiveUpstreamFailures", route: route, as: Int.self)
        routes = try document.required("routes", route: route, as: Int.self)
        adminPort = try document.required("adminPort", route: route, as: Int.self)
        cliVersion = try document.required("cliVersion", route: route, as: String.self)
        uiRevision = try document.required("uiRevision", route: route, as: String.self)
        statusMod = try document.required("statusMod", route: route, as: Bool.self)
        picker = try document.required("picker", route: route, as: Picker.self)
        let _: [String] = try document.required("pickerModels", route: route)
        settings = try document.required("settings", route: route, as: ProxySettings.self)

        let typedProviders: [String: Provider] = try document.required("providers", route: route)
        providers = document["providers"]!.keys.map { key in
            var provider = typedProviders[key]!
            provider.name = key
            return provider
        }
        struct ChatGPT: Decodable {
            let accounts: [String: [ChatGptAccount]]
            // Only a failed quota refresh sets stale; success omits it rather than sending false.
            let stale: Bool?
        }
        let chatgpt: ChatGPT = try document.required("chatgpt", route: route)
        chatgptAccounts = document["chatgpt"]!["accounts"]!.keys.map { ($0, chatgpt.accounts[$0]!) }
        chatgptStale = chatgpt.stale == true
        credentials = try document.required("credentials", route: route)
    }

    public var startedAt: Date? {
        runtime?.startedAt.flatMap { try? Date($0, strategy: .iso8601) }
    }

    /// The router's Claude-subscription provider, if one is configured.
    public var claudeProvider: Provider? { providers.first { $0.type == "anthropic" } }
}
