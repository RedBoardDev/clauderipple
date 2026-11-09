import Foundation

/// `GET/PUT /api/power`: keep-awake and hotspot tethering (newer routers; 0.9.x lacks the route).
public struct PowerStatus: Decodable, Sendable, Equatable {
    public let platform: String
    public let awake: AwakeStatus
    public let tether: TetherStatus
}

public struct AwakeStatus: Decodable, Sendable, Equatable {
    public enum Mode: String, Codable, Sendable, CaseIterable, Identifiable {
        case off, working, on
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .off: "Off"
            case .working: "Working"
            case .on: "On"
            }
        }
    }

    public struct Battery: Decodable, Sendable, Equatable {
        public let percent: Double?
        public let onBattery: Bool
    }

    public let mode: Mode
    /// Whether the OS assertion is currently held.
    public let applied: Bool
    public let reason: String
    /// "ok", "needs-setup" or "unsupported".
    public let setup: String
    public let battery: Battery?
    public let thermal: String?
    public let lidClosed: Bool?
    /// ISO 8601 deadline, nil for none.
    public let until: String?

    enum CodingKeys: String, CodingKey { case mode, applied, reason, setup, battery, thermal, lidClosed, until }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = try c.decode(Mode.self, forKey: .mode)
        applied = try c.decode(Bool.self, forKey: .applied)
        reason = try c.decode(String.self, forKey: .reason)
        setup = try c.decode(String.self, forKey: .setup)
        // Unknown OS readings and an unset deadline are explicit nulls, never missing keys.
        battery = try c.decode(Battery?.self, forKey: .battery)
        thermal = try c.decode(String?.self, forKey: .thermal)
        lidClosed = try c.decode(Bool?.self, forKey: .lidClosed)
        until = try c.decode(String?.self, forKey: .until)
    }

    public var untilDate: Date? { until.flatMap { try? Date($0, strategy: .iso8601) } }
}

public struct TetherStatus: Decodable, Sendable, Equatable {
    public struct Switch: Decodable, Sendable, Equatable {
        public let at: String
        public let to: String
        public let ok: Bool
        public let reason: String
    }

    public struct Probe: Decodable, Sendable, Equatable {
        public let at: String
        public let ok: Bool
        public let network: String
    }

    public let enabled: Bool
    /// "wifi", "hotspot" or "none".
    public let network: String
    public let state: String
    public let pinned: Bool
    public let hotspotSsid: String
    public let lastSwitch: Switch?
    public let lastProbe: Probe?
    public let hint: String?

    enum CodingKeys: String, CodingKey { case enabled, network, state, pinned, hotspotSsid, lastSwitch, lastProbe, hint }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        network = try c.decode(String.self, forKey: .network)
        state = try c.decode(String.self, forKey: .state)
        pinned = try c.decode(Bool.self, forKey: .pinned)
        hotspotSsid = try c.decode(String.self, forKey: .hotspotSsid)
        // Before the first event (or without a platform hint), the router sends explicit nulls.
        lastSwitch = try c.decode(Switch?.self, forKey: .lastSwitch)
        lastProbe = try c.decode(Probe?.self, forKey: .lastProbe)
        hint = try c.decode(String?.self, forKey: .hint)
    }
}

/// Background job state shared by `/api/power/setup`, `/api/chatgpt-login` and similar routes.
public struct JobState: Decodable, Sendable, Equatable {
    public let running: Bool
    public let startedAt: String?
    public let finishedAt: String?
    public let ok: Bool?
    public let output: String?
}

/// `{ ok, output }` from routes that run the CLI.
public struct CLIResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let output: String?
}
