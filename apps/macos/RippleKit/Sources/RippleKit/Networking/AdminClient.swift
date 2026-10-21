import Foundation

/// Why an admin call failed, in the terms the UI needs to say something precise.
public enum AdminError: Error, Equatable, Sendable {
    /// Nothing answered: the router is down, starting, or on another port.
    case offline
    /// The router answered 200 with something that is not JSON. An older router serves its
    /// dashboard page for any path it does not know, so this means "this version lacks the route".
    case routeMissing(path: String)
    /// A non-2xx answer, with the router's own `{error}` text when it sent one.
    case http(status: Int, message: String?)
    /// JSON that does not match the expected shape.
    case decoding(String)

    public var userMessage: String {
        switch self {
        case .offline: "The router isn't answering."
        case let .routeMissing(path): "This router version doesn't offer \(path). Update ClaudeRipple."
        case let .http(status, message): message ?? "The router answered HTTP \(status)."
        case let .decoding(detail): "Unexpected answer from the router (\(detail))."
        }
    }
}

/// Talks to the router's admin API over loopback HTTP.
///
/// The admin API has no bearer token: its boundary is loopback plus Host / Fetch-Metadata / Origin
/// checks (admin.ts). URLSession sends `Host: 127.0.0.1:<port>` from the URL and never adds Origin or
/// `Sec-Fetch-Site`, which is exactly what a native client must send. Nothing here sets them.
public struct AdminClient: Sendable {
    public let baseURL: URL
    private let session: URLSession

    /// Ordinary reads: a local router answers in milliseconds, so a long wait means it is stuck.
    public static let readTimeout: TimeInterval = 8
    /// Writes that run the CLI behind the scenes (picker, mod, Codex toggles) can take a while.
    public static let writeTimeout: TimeInterval = 90

    public init(baseURL: URL = Endpoint.adminURL(), session: URLSession? = nil) {
        self.baseURL = baseURL
        self.session = session ?? Self.makeSession()
    }

    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        // Loopback only: a system proxy must never see admin traffic.
        config.connectionProxyDictionary = [:]
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config)
    }

    // MARK: Requests

    /// GET a JSON route and decode it.
    public func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) async throws -> T {
        let data = try await perform("GET", path, query: query, body: nil, timeout: Self.readTimeout)
        return try decode(T.self, from: data, path: path)
    }

    /// GET a JSON route as an order-preserving document (config, settings).
    public func getDocument(_ path: String, query: [URLQueryItem] = []) async throws -> JSONValue {
        let data = try await perform("GET", path, query: query, body: nil, timeout: Self.readTimeout)
        do { return try JSONValue(data: data) } catch { throw AdminError.decoding("\(error)") }
    }

    /// GET a plain-text route (the router log).
    public func getText(_ path: String, query: [URLQueryItem] = []) async throws -> String {
        let data = try await perform("GET", path, query: query, body: nil, timeout: Self.readTimeout, expectJSON: false)
        return String(decoding: data, as: UTF8.self)
    }

    /// A state-changing call with a JSON body; decodes the answer.
    public func send<T: Decodable>(_ method: String, _ path: String, json body: JSONValue? = nil, as type: T.Type = T.self, timeout: TimeInterval = writeTimeout) async throws -> T {
        let data = try await perform(method, path, query: [], body: body?.data(), timeout: timeout)
        return try decode(T.self, from: data, path: path)
    }

    /// A state-changing call whose answer is only checked for success.
    public func send(_ method: String, _ path: String, json body: JSONValue? = nil, timeout: TimeInterval = writeTimeout) async throws {
        _ = try await perform(method, path, query: [], body: body?.data(), timeout: timeout)
    }

    /// A state-changing call whose answer is kept as a document.
    public func sendDocument(_ method: String, _ path: String, json body: JSONValue? = nil, timeout: TimeInterval = writeTimeout) async throws -> JSONValue {
        let data = try await perform(method, path, query: [], body: body?.data(), timeout: timeout)
        do { return try JSONValue(data: data) } catch { throw AdminError.decoding("\(error)") }
    }

    // MARK: Plumbing

    func request(_ method: String, _ path: String, query: [URLQueryItem], body: Data?, timeout: TimeInterval) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        // Callers percent-encode dynamic segments (`pathSegment`); `path` would encode them twice.
        components.percentEncodedPath = path.hasPrefix("/") ? path : "/" + path
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func perform(_ method: String, _ path: String, query: [URLQueryItem], body: Data?, timeout: TimeInterval, expectJSON: Bool = true) async throws -> Data {
        let request = request(method, path, query: query, body: body, timeout: timeout)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw AdminError.offline
        }
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        let contentType = http?.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        let isJSON = contentType.contains("json")
        guard (200..<300).contains(status) else {
            throw AdminError.http(status: status, message: isJSON ? Self.errorMessage(in: data) : nil)
        }
        // 204 and empty bodies are fine for writes; an HTML page in place of JSON is not.
        if expectJSON, !data.isEmpty, !isJSON, contentType.contains("html") {
            throw AdminError.routeMissing(path: path)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data, path: String) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch let error as DecodingError {
            throw AdminError.decoding(Self.describe(error))
        } catch {
            throw AdminError.decoding("\(error)")
        }
    }

    static func errorMessage(in data: Data) -> String? {
        guard let doc = try? JSONValue(data: data) else { return nil }
        return doc["error"]?.stringValue ?? doc["output"]?.stringValue
    }

    static func describe(_ error: DecodingError) -> String {
        func path(_ context: DecodingError.Context) -> String {
            context.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
        }
        switch error {
        case let .keyNotFound(key, context): return "missing \(path(context)).\(key.stringValue)"
        case let .typeMismatch(_, context): return "wrong type at \(path(context))"
        case let .valueNotFound(_, context): return "null at \(path(context))"
        case let .dataCorrupted(context): return "corrupt at \(path(context))"
        @unknown default: return "\(error)"
        }
    }
}
