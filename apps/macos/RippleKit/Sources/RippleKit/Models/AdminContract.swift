import Foundation

/// WHY: document projections must be as strict as Decodable without losing config key order.
extension JSONValue {
    func required<T: Decodable>(_ key: String, route: String, as type: T.Type = T.self) throws -> T {
        guard let value = self[key] else { throw AdminError.incompatible(route: route, codingPath: key) }
        do { return try value.decode(type) } catch let error as DecodingError {
            let child = AdminClient.codingPath(error)
            throw AdminError.incompatible(route: route, codingPath: child == "$document" ? key : "\(key).\(child)")
        }
    }
}

/// Validate the always-present config backbone before projecting it or doing read/modify/write.
/// Optional configuration knobs remain optional: omission is how the router represents defaults.
struct AdminConfiguration: Decodable {
    struct Listen: Decodable {
        let host: String
        let port: Int
    }
    struct Provider: Decodable {
        let type: String
        // Providers without a catalog, login or rotation switch omit the corresponding knob.
        let models: [RoutingModel]?
        let auth: String?
        let accountPool: Bool?
    }
    struct Route: Decodable {
        let provider: String
        let model: String
        // Routes without overrides inherit the request's effort and the model's window.
        let effort: String?
        let contextWindow: Int?
    }
    struct CLI: Decodable {
        let extraModels: [ExtraModel]
        let agentFiles: Bool
        // Unset CLI knobs use the router's defaults and are omitted.
        let models: [String: String]?
        let limitWorkerTools: Bool?
        let autoCompactWindow: Int?
    }
    struct ExtraModel: Decodable {
        let model: String
        // Legacy picker entries select by declared model id and omit provider.
        let provider: String?
        // A picker entry without a custom capacity/name inherits the model's facts.
        let contextWindow: Int?
        let name: String?
    }
    struct Health: Decodable { let maxConsecutiveUpstreamFailures: Int }
    struct Log: Decodable {
        let maxBytes: Int
        let keep: Int
    }
    let listen: Listen
    let upstream: String
    let providers: [String: Provider]
    let routes: [String: Route]
    let direct: [Direct]
    struct Direct: Decodable {
        let prefix: String
        let provider: String
    }
    let aliases: [String: String]
    let effortClamp: [String: String]
    let cli: CLI
    let health: Health
    let log: Log
    let configRevision: String
    // Unset automatic updates and web-search overrides use router defaults.
    let autoUpdate: Bool?
    let webSearch: WebSearch?
    struct WebSearch: Decodable {
        let provider: String
        let model: String
    }

    static func validate(_ document: JSONValue) throws {
        do { _ = try document.decode(Self.self) } catch let error as DecodingError {
            throw AdminError.incompatible(route: "/api/config", codingPath: AdminClient.codingPath(error))
        }
    }
}

/// The recorder writes this resource from the same metadata the Swift contract tests read.
public struct AdminContractMetadata: Decodable, Sendable {
    public let routerVersion: String
    public let modSettingsSchemaVersion: Int

    public static let tested: Self = {
        // A missing build resource is a packaging defect, never an unknown tested version.
        guard let url = Bundle.module.url(forResource: "contract-meta", withExtension: "json"),
            let data = try? Data(contentsOf: url), let meta = try? JSONDecoder().decode(Self.self, from: data)
        else { preconditionFailure("Missing admin contract metadata") }
        return meta
    }()
}
