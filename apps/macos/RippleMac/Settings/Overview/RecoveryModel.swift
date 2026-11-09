import Observation
import RippleKit
import Foundation

@MainActor
@Observable
final class RecoveryModel {
    /// Keep a pending Desktop restart and action output when navigating away and back.
    static let shared = RecoveryModel()
    /// Match the tray while its window is visible.
    static let doctorInterval: Duration = .seconds(10)
    var doctor: Doctor?
    var checking = false
    var busy = false
    var error: String?
    var doctorError: String?
    var doctorDetails = ""
    var details = ""
    var result: String?
    var restartClaude = false

    enum Action: String, Identifiable {
        case repair, directOn, directOff, restart
        var id: String { rawValue }
        var title: String {
            switch self {
            case .repair: "Repair"
            case .directOn: "Turn direct mode on"
            case .directOff: "Turn direct mode off"
            case .restart: "Restart Claude"
            }
        }
        var confirmation: String {
            switch self {
            case .repair: "Repair can re-register or start the router and correct stale ClaudeRipple proxy settings. Existing healthy router processes are left alone."
            case .directOn: "Claude Desktop and new Claude Code sessions will use Claude's default connection, bypassing ClaudeRipple. Restart Claude Desktop afterwards."
            case .directOff: "Claude will use ClaudeRipple again. This may repair or start the router. Restart Claude Desktop afterwards."
            case .restart: "Claude Desktop will quit and reopen. This ends its open sessions; finish your work first. Closing only its window does not apply new proxy settings."
            }
        }
        var arguments: [String] {
            switch self {
            case .repair: ["repair", "--json"]
            case .directOn: ["direct", "on", "--json"]
            case .directOff: ["direct", "off", "--json"]
            case .restart: []
            }
        }
    }

    func refreshDoctor() async {
        guard !checking, !busy else { return }
        checking = true
        defer { checking = false }
        do {
            let execution = try await CLI.run(["doctor", "--json"], timeout: CLI.doctorTimeout)
            guard !Task.isCancelled else { return }
            doctorDetails = execution.output
            guard execution.ok else {
                doctor = nil
                doctorError = execution.timedOut ? "The connection check timed out." : "The connection check could not run."
                return
            }
            doctor = try execution.decode(Doctor.self)
            doctorError = nil
        } catch {
            guard !Task.isCancelled else { return }
            doctor = nil
            doctorError = error.localizedDescription
        }
    }

    func run(_ action: Action) async {
        guard !busy, !checking else { return }
        busy = true
        error = nil
        result = nil
        details = ""
        do {
            if action == .restart {
                let output = try await ClaudeDesktop.reopen()
                details = output.output
                if output.ok {
                    restartClaude = false
                    result = "Claude Desktop reopened. Start new Claude Code sessions to pick up the connection change."
                } else { error = "Claude Desktop could not be reopened. Quit and reopen it yourself." }
            } else {
                let execution = try await CLI.run(action.arguments)
                details = execution.output
                guard !execution.timedOut, !execution.cancelled else {
                    error = execution.timedOut ? "The action timed out. See Details." : "The action was cancelled."
                    busy = false
                    await refreshDoctor()
                    return
                }
                if action == .repair {
                    let output = try execution.decode(RepairOutput.self)
                    if let doctor = output.doctor { self.doctor = doctor }
                    let lines = output.detailLines
                    if !lines.isEmpty { details = lines.joined(separator: "\n") + "\n\n" + execution.output }
                    if execution.ok && output.ok == true {
                        result = "Repair completed."
                        if output.restartClaude == true { restartClaude = true }
                    } else { error = execution.timedOut ? "Repair timed out." : "Repair did not complete. See Details." }
                } else {
                    let output = try execution.decode(DirectOutput.self)
                    if execution.ok && output.ok == true {
                        result = output.detail ?? "Connection settings changed."
                        if output.requiresClaudeRestart { restartClaude = true }
                    } else { error = execution.timedOut ? "The action timed out." : (output.detail ?? "The connection could not be changed.") }
                }
            }
        } catch { self.error = error.localizedDescription }
        busy = false
        await refreshDoctor()
    }
}

/// This is a Desktop operation, not `clauderipple restart` (which restarts the router).
/// Only called after the view's explicit confirmation; tests never invoke AppleScript.
private enum ClaudeDesktop {
    static let bundleID = "com.anthropic.claudefordesktop"
    /// The tray allows a graceful quit this long before refusing to open a second instance.
    static let quitBudget: TimeInterval = 20
    static let pollInterval: Duration = .milliseconds(500)
    static let queryTimeout: TimeInterval = 10

    static func isRunning() async throws -> Bool {
        let execution = try await CLI.runExecutable("/usr/bin/osascript", arguments: ["-e", "application id \"\(bundleID)\" is running"], timeout: queryTimeout)
        guard execution.ok else { throw DesktopError.queryFailed }
        return execution.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    static func reopen() async throws -> CLIExecution {
        if try await isRunning() {
            let quit = try await CLI.runExecutable("/usr/bin/osascript", arguments: ["-e", "tell application id \"\(bundleID)\" to quit"])
            guard quit.ok else { return quit }
            let deadline = Date().addingTimeInterval(quitBudget)
            while Date() < deadline {
                if try await !isRunning() { break }
                try await Task.sleep(for: pollInterval)
            }
            guard try await !isRunning() else { throw DesktopError.stillRunning }
        }
        let opened = try await CLI.runExecutable("/usr/bin/open", arguments: ["-b", bundleID])
        if opened.ok { return opened }
        return try await CLI.runExecutable("/usr/bin/open", arguments: ["-a", "Claude"])
    }

    enum DesktopError: Error, LocalizedError {
        case queryFailed, stillRunning
        var errorDescription: String? {
            switch self {
            case .queryFailed: "Could not check whether Claude Desktop is running. Quit and reopen it yourself."
            case .stillRunning: "Claude Desktop has not finished quitting. Finish any confirmation in Claude, then try again."
            }
        }
    }
}
