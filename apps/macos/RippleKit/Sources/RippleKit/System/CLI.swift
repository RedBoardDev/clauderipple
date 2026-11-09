import Foundation

public enum CLIError: Error, LocalizedError, Sendable, Equatable {
    case runtimeMissing(String)
    case invalidPaths
    case noJSONObject

    public var errorDescription: String? {
        switch self {
        case let .runtimeMissing(path): "CLI runtime file not found: \(path). Reinstall ClaudeRipple to record its runtime."
        case .invalidPaths: "ClaudeRipple's paths.json must name absolute node and cli paths."
        case .noJSONObject: "The CLI did not return a JSON object. See Details for its output."
        }
    }
}

/// Only the public execution contract is decoded; other installation metadata is ignored.
public struct CLIRuntime: Decodable, Sendable, Equatable {
    public let node: String
    public let env: [String: String]?
    public let cli: String

    public init(node: String, env: [String: String] = [:], cli: String) {
        self.node = node
        self.env = env
        self.cli = cli
    }

    public static func discover(environment: [String: String] = ProcessInfo.processInfo.environment,
                                userHome: URL = FileManager.default.homeDirectoryForCurrentUser,
                                read: (URL) throws -> Data = { try Data(contentsOf: $0) },
                                exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) throws -> CLIRuntime {
        let home = CLI.home(environment: environment, userHome: userHome)
        let paths = home.appending(path: "paths.json")
        guard exists(paths.path) else { throw CLIError.runtimeMissing(paths.path) }
        let recorded = try JSONDecoder().decode(CLIRuntime.self, from: read(paths))
        let runtime = CLIRuntime(node: recorded.node, env: recorded.env ?? [:],
                                 cli: environment["CLAUDERIPPLE_APP_CLI"].flatMap { $0.isEmpty ? nil : $0 } ?? recorded.cli)
        guard runtime.node.hasPrefix("/"), runtime.cli.hasPrefix("/") else { throw CLIError.invalidPaths }
        for file in [runtime.node, runtime.cli] {
            guard exists(file) else { throw CLIError.runtimeMissing(file) }
        }
        return runtime
    }
}

public struct CLIExecution: Sendable, Equatable {
    public let stdout: String
    public let stderr: String
    public let exitCode: Int32
    public let timedOut: Bool
    public let cancelled: Bool
    public var ok: Bool { exitCode == 0 && !timedOut && !cancelled }
    public var output: String {
        [stdout, stderr, timedOut ? "The action timed out." : nil, cancelled ? "The action was cancelled." : nil]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: CLI.lastJSONObject(in: stdout))
    }
}

public enum CLI {
    /// Recovery must give up on a stuck supervisor rather than leave a disabled button forever.
    public static let actionTimeout: TimeInterval = 40
    public static let doctorTimeout: TimeInterval = 15
    /// A terminated child gets a short grace period before SIGKILL.
    private static let terminationGrace: TimeInterval = 1

    public static func home(environment: [String: String] = ProcessInfo.processInfo.environment,
                            userHome: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        if let path = environment["CLAUDERIPPLE_HOME"], !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return userHome.appending(path: ".clauderipple", directoryHint: .isDirectory)
    }

    /// Last JSON-object line wins; pretty-printed whole objects are accepted as a fallback.
    public static func lastJSONObject(in stdout: String) throws -> Data {
        func object(_ text: String) -> Data? {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { return nil }
            return data
        }
        for line in stdout.components(separatedBy: .newlines).reversed() {
            if let data = object(line) { return data }
        }
        if let data = object(stdout) { return data }
        throw CLIError.noJSONObject
    }

    public static func run(_ arguments: [String], timeout: TimeInterval = actionTimeout) async throws -> CLIExecution {
        let environment = ProcessInfo.processInfo.environment
        let runtime = try CLIRuntime.discover(environment: environment)
        var childEnvironment = environment.merging(runtime.env ?? [:]) { _, recorded in recorded }
        childEnvironment["CLAUDERIPPLE_HOME"] = home(environment: environment).path
        return try await runExecutable(runtime.node, arguments: [runtime.cli] + arguments,
                                       environment: childEnvironment, timeout: timeout)
    }

    /// Shared Process plumbing; always an absolute executable and an argument array, never a shell.
    public static func runExecutable(_ executable: String, arguments: [String],
                                     environment: [String: String]? = nil,
                                     timeout: TimeInterval = actionTimeout) async throws -> CLIExecution {
        let child = ChildProcess()
        return try await withTaskCancellationHandler {
            try await Task.detached {
                try child.run(executable, arguments: arguments, environment: environment,
                              timeout: timeout, grace: terminationGrace)
            }.value
        } onCancel: {
            child.cancel()
        }
    }
}

/// Process and pipe handles stay on the worker queue. The lock protects cancellation and captured
/// bytes; stdout and stderr drain concurrently so either pipe can exceed its kernel buffer.
private final class ChildProcess: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var cancelled = false
    private var stdout = Data()
    private var stderr = Data()

    func cancel() {
        lock.withLock {
            cancelled = true
            if let process, process.isRunning { process.terminate() }
        }
    }

    func run(_ executable: String, arguments: [String], environment: [String: String]?,
             timeout: TimeInterval, grace: TimeInterval) throws -> CLIExecution {
        guard executable.hasPrefix("/") else { throw CLIError.invalidPaths }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        try lock.withLock {
            if cancelled { throw CancellationError() }
            try process.run()
            self.process = process
        }
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global().async {
            let data = out.fileHandleForReading.readDataToEndOfFile()
            self.lock.withLock { self.stdout = data }
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global().async {
            let data = err.fileHandleForReading.readDataToEndOfFile()
            self.lock.withLock { self.stderr = data }
            readers.leave()
        }
        let timedOut = finished.wait(timeout: .now() + timeout) == .timedOut
        if timedOut {
            if process.isRunning { process.terminate() }
            if finished.wait(timeout: .now() + grace) == .timedOut, process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                finished.wait()
            }
        }
        readers.wait()
        return lock.withLock {
            self.process = nil
            return CLIExecution(stdout: String(decoding: stdout, as: UTF8.self),
                                stderr: String(decoding: stderr, as: UTF8.self),
                                exitCode: process.terminationStatus, timedOut: timedOut, cancelled: cancelled)
        }
    }
}
