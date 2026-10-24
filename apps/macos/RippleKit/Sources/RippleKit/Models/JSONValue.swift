import Foundation

/// A JSON document that keeps what Foundation's coders drop: object key order and number literals.
///
/// The router's config is edited by reading the whole file and writing it back (`PUT /api/config`;
/// there is no per-provider endpoint). Provider order in that file is routing order, and a plain
/// `[String: Any]` round trip shuffles it. Numbers are kept as their literal text so `5242880` does
/// not come back as `5242880.0`. Fields this app does not know survive untouched.
public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    /// The number exactly as it appeared (or was written), e.g. "8791", "0.5", "-1e3".
    case number(String)
    case string(String)
    case array([JSONValue])
    /// Key/value pairs in document order.
    case object([(key: String, value: JSONValue)])

    public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): true
        case let (.bool(a), .bool(b)): a == b
        case let (.number(a), .number(b)): a == b || (Double(a) != nil && Double(a) == Double(b))
        case let (.string(a), .string(b)): a == b
        case let (.array(a), .array(b)): a == b
        case let (.object(a), .object(b)):
            a.count == b.count && zip(a, b).allSatisfy { $0.key == $1.key && $0.value == $1.value }
        default: false
        }
    }

    // MARK: Building

    public static func int(_ value: Int) -> JSONValue { .number(String(value)) }

    public static func double(_ value: Double) -> JSONValue {
        value.rounded() == value && abs(value) < 1e15 ? .number(String(Int(value))) : .number(String(value))
    }

    // MARK: Reading

    public var stringValue: String? { if case let .string(s) = self { s } else { nil } }
    public var boolValue: Bool? { if case let .bool(b) = self { b } else { nil } }
    public var doubleValue: Double? { if case let .number(n) = self { Double(n) } else { nil } }
    public var intValue: Int? { doubleValue.map { Int($0) } }
    public var arrayValue: [JSONValue]? { if case let .array(a) = self { a } else { nil } }
    public var objectValue: [(key: String, value: JSONValue)]? { if case let .object(o) = self { o } else { nil } }
    public var isNull: Bool { if case .null = self { true } else { false } }

    /// Keys of an object in document order; empty for anything else.
    public var keys: [String] { objectValue?.map(\.key) ?? [] }

    /// Member lookup and in-place update. Setting a new key appends it; setting nil removes it.
    /// Setting a member on a non-object turns it into an object, so `config["cli"]?["models"]`
    /// style chains can create the path they write to.
    public subscript(key: String) -> JSONValue? {
        get { objectValue?.first { $0.key == key }?.value }
        set {
            var pairs = objectValue ?? []
            if let index = pairs.firstIndex(where: { $0.key == key }) {
                if let newValue { pairs[index].value = newValue } else { pairs.remove(at: index) }
            } else if let newValue {
                pairs.append((key, newValue))
            }
            self = .object(pairs)
        }
    }

    public subscript(index: Int) -> JSONValue? {
        guard let array = arrayValue, array.indices.contains(index) else { return nil }
        return array[index]
    }

    /// Value at a key path, e.g. `value(at: ["providers", "claude", "accountPool"])`.
    public func value(at path: [String]) -> JSONValue? {
        path.reduce(Optional(self)) { $0?[$1] }
    }

    /// Writes `newValue` at a key path, creating intermediate objects. Nil removes the last key.
    public mutating func set(_ newValue: JSONValue?, at path: [String]) {
        guard let head = path.first else {
            self = newValue ?? .null
            return
        }
        if path.count == 1 {
            self[head] = newValue
            return
        }
        var child = self[head] ?? .object([])
        child.set(newValue, at: Array(path.dropFirst()))
        self[head] = child
    }

    // MARK: Bridging to Codable

    /// Decodes a typed view of this value (a sub-tree of a larger document, typically).
    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(serialized().utf8))
    }

    /// Encodes any Encodable into a JSONValue, keeping the encoder's key order (sorted, so the
    /// result is at least deterministic).
    public static func from(_ value: some Encodable) throws -> JSONValue {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try JSONValue(data: encoder.encode(value))
    }
}

// MARK: - Parsing

public struct JSONParseError: Error, Equatable, Sendable {
    public let offset: Int
    public let reason: String
}

public extension JSONValue {
    init(data: Data) throws {
        var parser = Parser(bytes: Array(data))
        self = try parser.parseDocument()
    }

    init(string: String) throws {
        try self.init(data: Data(string.utf8))
    }
}

private struct Parser {
    let bytes: [UInt8]
    var index = 0
    /// Nesting limit: the router's documents are a few levels deep; this only stops a hostile or
    /// corrupt input from overflowing the stack.
    static let maxDepth = 256

    init(bytes: [UInt8]) { self.bytes = bytes }

    mutating func parseDocument() throws -> JSONValue {
        skipWhitespace()
        let value = try parseValue(depth: 0)
        skipWhitespace()
        guard index == bytes.count else { throw error("trailing characters") }
        return value
    }

    func error(_ reason: String) -> JSONParseError { JSONParseError(offset: index, reason: reason) }

    mutating func skipWhitespace() {
        while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
    }

    mutating func parseValue(depth: Int) throws -> JSONValue {
        guard depth < Self.maxDepth else { throw error("nesting too deep") }
        guard index < bytes.count else { throw error("unexpected end") }
        switch bytes[index] {
        case UInt8(ascii: "{"): return try parseObject(depth: depth)
        case UInt8(ascii: "["): return try parseArray(depth: depth)
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"): try expect("true"); return .bool(true)
        case UInt8(ascii: "f"): try expect("false"); return .bool(false)
        case UInt8(ascii: "n"): try expect("null"); return .null
        default: return .number(try parseNumber())
        }
    }

    mutating func expect(_ literal: String) throws {
        let utf8 = Array(literal.utf8)
        guard index + utf8.count <= bytes.count, Array(bytes[index..<index + utf8.count]) == utf8 else {
            throw error("expected \(literal)")
        }
        index += utf8.count
    }

    mutating func parseObject(depth: Int) throws -> JSONValue {
        index += 1
        var pairs: [(key: String, value: JSONValue)] = []
        skipWhitespace()
        if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
            index += 1
            return .object(pairs)
        }
        while true {
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw error("expected key") }
            let key = try parseString()
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw error("expected :") }
            index += 1
            skipWhitespace()
            let value = try parseValue(depth: depth + 1)
            // A repeated key keeps its first position and the last value, as JSON.parse does.
            if let existing = pairs.firstIndex(where: { $0.key == key }) {
                pairs[existing].value = value
            } else {
                pairs.append((key, value))
            }
            skipWhitespace()
            guard index < bytes.count else { throw error("unterminated object") }
            if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
            if bytes[index] == UInt8(ascii: "}") { index += 1; return .object(pairs) }
            throw error("expected , or }")
        }
    }

    mutating func parseArray(depth: Int) throws -> JSONValue {
        index += 1
        var items: [JSONValue] = []
        skipWhitespace()
        if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
            index += 1
            return .array(items)
        }
        while true {
            skipWhitespace()
            items.append(try parseValue(depth: depth + 1))
            skipWhitespace()
            guard index < bytes.count else { throw error("unterminated array") }
            if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
            if bytes[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
            throw error("expected , or ]")
        }
    }

    mutating func parseNumber() throws -> String {
        let start = index
        if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
        let digitsStart = index
        while index < bytes.count, isDigit(bytes[index]) { index += 1 }
        guard index > digitsStart else { throw error("invalid number") }
        if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
            index += 1
            let fraction = index
            while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            guard index > fraction else { throw error("invalid fraction") }
        }
        if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
            index += 1
            if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") { index += 1 }
            let exponent = index
            while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            guard index > exponent else { throw error("invalid exponent") }
        }
        return String(decoding: bytes[start..<index], as: UTF8.self)
    }

    func isDigit(_ byte: UInt8) -> Bool { byte >= 0x30 && byte <= 0x39 }

    mutating func parseString() throws -> String {
        index += 1
        var scalars = String.UnicodeScalarView()
        var raw: [UInt8] = []
        func flush() {
            if !raw.isEmpty {
                scalars.append(contentsOf: String(decoding: raw, as: UTF8.self).unicodeScalars)
                raw.removeAll(keepingCapacity: true)
            }
        }
        while index < bytes.count {
            let byte = bytes[index]
            if byte == UInt8(ascii: "\"") {
                index += 1
                flush()
                return String(scalars)
            }
            if byte == UInt8(ascii: "\\") {
                flush()
                index += 1
                guard index < bytes.count else { break }
                let escape = bytes[index]
                index += 1
                switch escape {
                case UInt8(ascii: "\""): scalars.append("\"")
                case UInt8(ascii: "\\"): scalars.append("\\")
                case UInt8(ascii: "/"): scalars.append("/")
                case UInt8(ascii: "b"): scalars.append("\u{08}")
                case UInt8(ascii: "f"): scalars.append("\u{0C}")
                case UInt8(ascii: "n"): scalars.append("\n")
                case UInt8(ascii: "r"): scalars.append("\r")
                case UInt8(ascii: "t"): scalars.append("\t")
                case UInt8(ascii: "u"):
                    let unit = try parseHex4()
                    if (0xD800...0xDBFF).contains(unit) {
                        // A high surrogate must be followed by \u + low surrogate.
                        guard index + 1 < bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") else {
                            throw error("lone surrogate")
                        }
                        index += 2
                        let low = try parseHex4()
                        guard (0xDC00...0xDFFF).contains(low) else { throw error("invalid surrogate pair") }
                        let combined = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                        guard let scalar = Unicode.Scalar(combined) else { throw error("invalid scalar") }
                        scalars.append(scalar)
                    } else {
                        guard let scalar = Unicode.Scalar(unit) else { throw error("invalid scalar") }
                        scalars.append(scalar)
                    }
                default: throw error("invalid escape")
                }
                continue
            }
            guard byte >= 0x20 else { throw error("control character in string") }
            raw.append(byte)
            index += 1
        }
        throw error("unterminated string")
    }

    mutating func parseHex4() throws -> UInt32 {
        guard index + 4 <= bytes.count, let value = UInt32(String(decoding: bytes[index..<index + 4], as: UTF8.self), radix: 16) else {
            throw error("invalid \\u escape")
        }
        index += 4
        return value
    }
}

// MARK: - Serializing

public extension JSONValue {
    /// Compact JSON text in document order.
    func serialized() -> String {
        var out = ""
        write(into: &out)
        return out
    }

    func data() -> Data { Data(serialized().utf8) }

    private func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .number(n): out += n
        case let .string(s): Self.writeString(s, into: &out)
        case let .array(items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                item.write(into: &out)
            }
            out += "]"
        case let .object(pairs):
            out += "{"
            for (i, pair) in pairs.enumerated() {
                if i > 0 { out += "," }
                Self.writeString(pair.key, into: &out)
                out += ":"
                pair.value.write(into: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}
