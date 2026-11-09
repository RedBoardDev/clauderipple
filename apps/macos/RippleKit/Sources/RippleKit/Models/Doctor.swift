import Foundation

/// Optional fields preserve recovery with an older or newer CLI, as in the tray contract.
public struct Doctor: Decodable, Sendable, Equatable {
    public struct Router: Decodable, Sendable, Equatable {
        public let responding: Bool?
        public let version: String?
        public let pid: Int?
        public let url: String?
        public let adminUrl: String?
    }
    public struct Supervisor: Decodable, Sendable, Equatable {
        public let registered: Bool?
        public let program: String?
        public let programExists: Bool?
        public let state: String?
    }
    public struct Proxy: Decodable, Sendable, Equatable {
        public let proxy: String?
        public let url: String?
    }
    public struct Problem: Decodable, Sendable, Equatable {
        public let code: String?
        public let message: String?
    }
    public let mode: String?
    public let router: Router?
    public let supervisor: Supervisor?
    public let desktop: Proxy?
    public let cli: Proxy?
    public let problems: [Problem]?
}

public struct RepairOutput: Decodable, Sendable, Equatable {
    public struct Step: Decodable, Sendable, Equatable {
        public let name: String?
        public let ok: Bool?
        public let detail: String?
    }
    public let ok: Bool?
    public let steps: [Step]?
    public let doctor: Doctor?
    public let restartClaude: Bool?

    public var detailLines: [String] {
        (steps ?? []).map { "\($0.ok == true ? "OK" : "Failed"): \($0.name ?? "Step")\($0.detail.map { " — \($0)" } ?? "")" }
    }
}

public struct DirectOutput: Decodable, Sendable, Equatable {
    public let ok: Bool?
    public let mode: String?
    public let restartClaude: Bool?
    public let detail: String?
    public var requiresClaudeRestart: Bool { ok == true && restartClaude == true }
}

public struct UpdateCheck: Decodable, Sendable, Equatable {
    public let current: String
    public let latest: String?
    public let newer: Bool
    public let kind: String
    public let running: Bool?
    public let started: Bool?

    public var supportsUpdate: Bool { kind == "script" || kind == "npm" }
    public var canUpdate: Bool { newer && supportsUpdate && running != true && started != true }
    public var installationNote: String? {
        switch kind {
        case "script", "npm": nil
        case "checkout": "This is a source checkout. Update it with git pull."
        case "packaged": "Download the latest standalone release from GitHub."
        default: "Update this installation the same way you installed it; in-app updates are not supported."
        }
    }
}

public extension TetherStatus {
    /// Unknown future states remain visible rather than being misreported as healthy.
    var stateTitle: String { Self.title(for: state) }
    static func title(for state: String) -> String {
        switch state {
        case "off": "Hotspot failover is off"
        case "unsupported": "Hotspot failover is not supported on this platform"
        case "no-wifi-device": "No Wi-Fi adapter found"
        case "watching": "Watching Wi-Fi connectivity"
        case "no-wifi": "No Wi-Fi connection"
        case "outage": "Wi-Fi has no internet connection"
        case "pinned": "Automatic network switching is paused"
        case "joining-hotspot": "Joining the phone hotspot"
        case "on-hotspot": "Connected to the phone hotspot"
        case "returning": "Returning to Wi-Fi"
        case "hotspot-not-visible": "The phone hotspot is not visible"
        case "join-failed": "Could not join the phone hotspot"
        case "needs-setup": "Hotspot setup is required"
        case "no-hotspot-ssid": "Choose a phone hotspot name in setup"
        case "no-hotspot-profile": "Join the hotspot once to save its Wi-Fi profile"
        case "needs-location": "Allow Location access to identify the Wi-Fi network"
        default: state
        }
    }
    var needsSetup: Bool { state == "needs-setup" || state == "no-hotspot-ssid" }
    var networkTitle: String {
        switch network {
        case "wifi": "Wi-Fi"
        case "hotspot": "Phone hotspot"
        case "none": "Not connected"
        default: network
        }
    }
}

public extension JobState {
    var shouldPoll: Bool { running }
}
