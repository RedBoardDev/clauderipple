import Foundation

/// `GET /api/status`: the router's own summary. Every member the app does not strictly need is
/// optional, so a newer or older router still decodes.
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
    }

    public struct Stats: Decodable, Sendable, Equatable {
        public let inFlight: Int
        public let messagesInFlight: Int?
        public let started: Int?
        public let completed: Int?
        public let failed: Int?
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
            case type, url, reachable, usable, exhaustion, needsLogin, needsVerification, authSource, signedIn, accountCount
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
    }

    public struct Picker: Decodable, Sendable, Equatable {
        public let enabled: Bool
    }

    public struct ProxySettings: Decodable, Sendable, Equatable {
        public let pointsAtRouter: Bool?
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
        func member<T: Decodable>(_ key: String, _ type: T.Type) -> T? {
            try? document[key]?.decode(T.self)
        }
        guard let version = document["version"]?.stringValue else {
            throw AdminError.decoding("missing version")
        }
        self.version = version
        readiness = member("readiness", Readiness.self)
        runtime = member("runtime", Runtime.self)
        stats = member("stats", Stats.self)
        consecutiveUpstreamFailures = document["consecutiveUpstreamFailures"]?.intValue
        routes = document["routes"]?.intValue
        adminPort = document["adminPort"]?.intValue
        cliVersion = document["cliVersion"]?.stringValue
        uiRevision = document["uiRevision"]?.stringValue
        statusMod = document["statusMod"]?.boolValue
        picker = member("picker", Picker.self)
        settings = member("settings", ProxySettings.self)

        providers = (document["providers"]?.objectValue ?? []).compactMap { pair in
            guard var provider = try? pair.value.decode(Provider.self) else { return nil }
            provider.name = pair.key
            return provider
        }
        let chatgpt = document["chatgpt"]
        chatgptAccounts = (chatgpt?["accounts"]?.objectValue ?? []).map { pair in
            (pair.key, (pair.value.arrayValue ?? []).compactMap { try? $0.decode(ChatGptAccount.self) })
        }
        chatgptStale = chatgpt?["stale"]?.boolValue ?? false
        var credentials: [String: [Credential]] = [:]
        for pair in document["credentials"]?.objectValue ?? [] {
            credentials[pair.key] = (pair.value.arrayValue ?? []).compactMap { try? $0.decode(Credential.self) }
        }
        self.credentials = credentials
    }

    public var startedAt: Date? {
        runtime?.startedAt.flatMap { try? Date($0, strategy: .iso8601) }
    }

    /// The router's Claude-subscription provider, if one is configured.
    public var claudeProvider: Provider? { providers.first { $0.type == "anthropic" } }
}
