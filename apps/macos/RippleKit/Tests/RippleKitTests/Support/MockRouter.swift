import Foundation
@testable import RippleKit

/// A stand-in admin API for tests: answers requests from a routing closure, records what was sent.
/// Nothing reaches the network, so no test can touch the live router on 127.0.0.1.
final class MockRouter: URLProtocol, @unchecked Sendable {
    struct Response {
        var status: Int = 200
        var contentType: String = "application/json; charset=utf-8"
        var body: Data

        static func json(_ text: String, status: Int = 200) -> Response {
            Response(status: status, body: Data(text.utf8))
        }

        /// What a 0.9.x router answers for a route it does not have: its dashboard page.
        static let dashboardPage = Response(contentType: "text/html; charset=utf-8", body: Data("<!doctype html><html></html>".utf8))
    }

    struct Recorded: Sendable {
        let method: String
        let path: String
        let query: String?
        let headers: [String: String]
        let body: Data?

        var json: JSONValue? { body.flatMap { try? JSONValue(data: $0) } }
    }

    nonisolated(unsafe) static var handler: ((Recorded) -> Response?)?
    nonisolated(unsafe) static var recorded: [Recorded] = []
    private static let lock = NSLock()

    /// A client wired to this mock. Call `reset` in `setUp`.
    static func client(_ handler: @escaping (Recorded) -> Response?) -> AdminClient {
        lock.withLock {
            Self.handler = handler
            Self.recorded = []
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockRouter.self]
        return AdminClient(baseURL: URL(string: "http://127.0.0.1:18791")!, session: URLSession(configuration: config))
    }

    static func requests() -> [Recorded] { lock.withLock { recorded } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let body = request.httpBody ?? request.httpBodyStream.map(Self.drain)
        let recorded = Recorded(method: request.httpMethod ?? "GET", path: url.path, query: url.query,
                                headers: request.allHTTPHeaderFields ?? [:], body: body)
        let handler = Self.lock.withLock { () -> ((Recorded) -> Response?)? in
            Self.recorded.append(recorded)
            return Self.handler
        }
        guard let response = handler?(recorded) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let http = HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": response.contentType])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// Loads a JSON fixture from Tests/RippleKitTests/Fixtures. Fixtures hold made-up labels and ids
/// only, never values copied from a real router.
func fixture(_ name: String) throws -> Data {
    guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
        throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing fixture \(name).json"])
    }
    return try Data(contentsOf: url)
}

func fixtureText(_ name: String) throws -> String {
    String(decoding: try fixture(name), as: UTF8.self)
}
