import XCTest
@testable import RippleKit

final class JSONValueTests: XCTestCase {
    // WHY: provider order in config.json is routing order. A dictionary round trip shuffles it;
    // a config write from the app must not reorder providers.
    func testObjectKeyOrderSurvivesRoundTrip() throws {
        let text = #"{"providers":{"zeta":{"type":"chatgpt"},"alpha":{"type":"anthropic"},"mid":{"type":"google"}},"listen":{"port":8790}}"#
        let doc = try JSONValue(string: text)
        XCTAssertEqual(doc["providers"]?.keys, ["zeta", "alpha", "mid"])
        XCTAssertEqual(doc.serialized(), text)
    }

    // WHY: numbers are kept as written; 5242880 must not come back as 5242880.0, nor 0.1 drift.
    func testNumberLiteralsAreKept() throws {
        let text = #"{"a":5242880,"b":0.1,"c":-1e3,"d":12.50}"#
        XCTAssertEqual(try JSONValue(string: text).serialized(), text)
    }

    func testSetAppendsNewKeysAndKeepsPositionOfExistingOnes() throws {
        var doc = try JSONValue(string: #"{"a":1,"b":2}"#)
        doc["a"] = .int(9)
        doc["c"] = .bool(true)
        XCTAssertEqual(doc.serialized(), #"{"a":9,"b":2,"c":true}"#)
        doc["b"] = nil
        XCTAssertEqual(doc.serialized(), #"{"a":9,"c":true}"#)
    }

    func testSetAtPathCreatesIntermediateObjects() throws {
        var doc = try JSONValue(string: #"{"cli":{"extraModels":[]}}"#)
        doc.set(.string("gpt-6-1-sol"), at: ["cli", "models", "subagent"])
        XCTAssertEqual(doc.serialized(), #"{"cli":{"extraModels":[],"models":{"subagent":"gpt-6-1-sol"}}}"#)
        XCTAssertEqual(doc.value(at: ["cli", "models", "subagent"])?.stringValue, "gpt-6-1-sol")
    }

    func testStringEscapesRoundTrip() throws {
        let text = #"{"s":"quote \" backslash \\ newline \n tab \t unicode é 😀 \u0001"}"#
        let doc = try JSONValue(string: text)
        XCTAssertEqual(doc["s"]?.stringValue, "quote \" backslash \\ newline \n tab \t unicode é 😀 \u{01}")
        XCTAssertEqual(try JSONValue(string: doc.serialized()), doc)
    }

    func testSurrogatePairEscape() throws {
        XCTAssertEqual(try JSONValue(string: #""😀""#).stringValue, "😀")
    }

    func testRejectsMalformedInput() {
        for bad in ["{", "[1,]", #"{"a" 1}"#, "tru", #""\x""#, "1 2", #"{"a":01x}"#] {
            XCTAssertThrowsError(try JSONValue(string: bad), bad)
        }
    }

    func testDuplicateKeysKeepFirstPositionAndLastValue() throws {
        XCTAssertEqual(try JSONValue(string: #"{"a":1,"b":2,"a":3}"#).serialized(), #"{"a":3,"b":2}"#)
    }

    func testDecodeBridge() throws {
        struct Port: Decodable { let port: Int }
        let doc = try JSONValue(string: #"{"listen":{"port":8790}}"#)
        XCTAssertEqual(try doc["listen"]?.decode(Port.self).port, 8790)
    }
}
