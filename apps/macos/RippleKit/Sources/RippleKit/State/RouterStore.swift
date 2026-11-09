import Foundation
import Observation

/// Live picture of the local router: status, per-account limits, today's totals, keep-awake.
///
/// Polls on its own from launch (the menu-bar icon needs it while the panel is closed), faster while
/// the panel is on screen. Everything is local HTTP to 127.0.0.1; no call here reaches a provider
/// except what the router itself decides to refresh (its quota caches have their own TTLs).
@MainActor
@Observable
public final class RouterStore {
    public enum Connection: Sendable, Equatable { case connecting, online, offline }

    /// Where the account rows came from.
    public enum LimitsSource: Sendable, Equatable {
        case unknown
        /// `/api/limits` with per-account entries (newer routers).
        case perAccount
        /// `/api/claude-accounts` + `/api/status` (routers without per-account limits).
        case accountEndpoints
    }

    public let client: AdminClient

    public private(set) var connection: Connection = .connecting
    public private(set) var status: RouterStatus?
    public private(set) var accounts: [AccountUsage] = []
    public private(set) var limitsSource: LimitsSource = .unknown
    public private(set) var claudeAccounts: ClaudeAccountsResponse?
    public private(set) var today: RequestSummary?
    public private(set) var power: PowerStatus?
    /// Nil until asked; false when this router version has no `/api/power`.
    public private(set) var powerAvailable: Bool?
    public private(set) var lastUpdated: Date?
    public private(set) var lastError: AdminError?
    public private(set) var isRefreshing = false
    /// When the router stopped answering, for the "router down" notification grace period.
    public private(set) var downSince: Date?
    public private(set) var gauge = MenuBarGauge(mood: .idle, fill: 1)
    public private(set) var drainAdvice: DrainAdvice?

    /// Set by the panel; while true the store polls at the fast cadence.
    public var panelVisible = false {
        didSet { if panelVisible, !oldValue { wake() } }
    }

    // Cadence. The dashboard polls status every 5 s; the panel matches it while open. Closed, the
    // icon only needs a weekly percent, which moves slowly: once a minute is plenty.
    public static let openInterval: Duration = .seconds(5)
    public static let closedInterval: Duration = .seconds(60)
    /// Account quotas change on the router's own cache TTLs (5–10 min), so the open panel re-reads
    /// them every third tick rather than every tick.
    static let accountsEveryTicks = 3
    /// How long the app trusts "this router has no per-account limits" before asking again (an
    /// update may have added the route).
    static let limitsRecheck: TimeInterval = 10 * 60

    private var loop: Task<Void, Never>?
    private var nap: Task<Void, Never>?
    private var tick = 0
    private var perAccountCheckedAt: Date?
    private var knownVersion: String?

    public init(client: AdminClient = AdminClient()) {
        self.client = client
    }

    /// A store frozen on given data, for previews, `--demo` and snapshot rendering. It never polls.
    public init(preview accounts: [AccountUsage], status: RouterStatus?, today: RequestSummary? = nil,
                power: PowerStatus? = nil, claudeRotation: Bool? = nil, updated: Date = Date()) {
        client = AdminClient(baseURL: URL(string: "http://127.0.0.1:1")!)
        self.accounts = accounts
        self.status = status
        self.today = today
        self.power = power
        powerAvailable = power != nil
        self.claudeRotation = claudeRotation
        connection = status == nil ? .offline : .online
        downSince = status == nil ? updated : nil
        lastUpdated = updated
        limitsSource = .perAccount
        recompute()
    }

    // MARK: Lifecycle

    public func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.poll()
                let interval = self.panelVisible ? Self.openInterval : Self.closedInterval
                // A cancellable nap: `wake()` cancels it so an opened panel refreshes at once.
                let nap = Task { _ = try? await Task.sleep(for: interval) }
                self.nap = nap
                await nap.value
            }
        }
    }

    public func stop() {
        loop?.cancel()
        loop = nil
        nap?.cancel()
    }

    private func wake() { nap?.cancel() }

    /// Explicit refresh (button, ⌘R): asks the router to re-read provider quotas too.
    public func refresh() async {
        await poll(force: true)
    }

    /// Re-read after a change made from the app (an account preferred, paused, removed).
    public func reloadAccounts() async {
        await loadAccounts(force: false)
        recompute()
    }

    // MARK: Polling

    func poll(force: Bool = false) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        tick += 1

        do {
            let status = try await client.status(refresh: force)
            self.status = status
            if status.version != knownVersion {
                // A different router build: forget what the last one lacked.
                knownVersion = status.version
                perAccountCheckedAt = nil
                powerAvailable = nil
            }
            connection = .online
            downSince = nil
            lastError = nil
        } catch let error as AdminError {
            markDown(error)
            return
        } catch {
            markDown(.offline)
            return
        }

        let loadAccountsNow = force || !panelVisible || tick % Self.accountsEveryTicks == 1 || accounts.isEmpty
        async let todayTask: RequestSummary? = try? client.summarySinceMidnight()
        if loadAccountsNow { await loadAccounts(force: force) }
        await loadPower()
        today = await todayTask
        lastUpdated = Date()
        recompute()
    }

    private func markDown(_ error: AdminError) {
        lastError = error
        if case .offline = error {
            connection = .offline
            if downSince == nil { downSince = Date() }
        }
        recompute()
    }

    private func loadAccounts(force: Bool) async {
        let now = Date()
        let mayHaveLimits = limitsSource != .accountEndpoints
            || perAccountCheckedAt.map { now.timeIntervalSince($0) > Self.limitsRecheck } ?? true
        if mayHaveLimits {
            perAccountCheckedAt = now
            if let response = try? await client.limits(refresh: force),
               let rows = UsageBuilder.fromLimits(response, now: now) {
                accounts = rows
                limitsSource = .perAccount
                // The Accounts pane still needs the Claude account list (emails, expiry).
                claudeAccounts = try? await client.claudeAccounts()
                return
            }
        }
        let claude = try? await client.claudeAccounts()
        claudeAccounts = claude
        accounts = UsageBuilder.fromAccounts(claude: claude, status: status, now: now)
        limitsSource = .accountEndpoints
    }

    private func loadPower() async {
        guard powerAvailable != false else { return }
        do {
            power = try await client.power()
            powerAvailable = true
        } catch AdminError.routeMissing, AdminError.http(status: 501, _) {
            power = nil
            powerAvailable = false
        } catch {
            // Transient: keep the last reading.
        }
    }

    /// Keep-awake from the panel. Applies the router's answer, so the control shows what took effect.
    public func setAwake(_ mode: AwakeStatus.Mode) async throws {
        power = try await client.setAwakeMode(mode)
    }

    private func recompute() {
        let online: Bool? = switch connection {
        case .connecting: nil
        case .online: true
        case .offline: false
        }
        let gauge = MenuBarGauge.make(accounts: accounts, online: online)
        if gauge != self.gauge { self.gauge = gauge }
        let advice = ProviderKind.allCases
            .compactMap { kind in DrainAdvisor.advice(for: accounts.filter { $0.kind == kind }, now: Date()) }
            .first { DrainAdvisor.differsFromRouting($0, accounts: accounts) }
        if advice != drainAdvice { drainAdvice = advice }
    }

    // MARK: Derived

    public func accounts(of kind: ProviderKind) -> [AccountUsage] {
        accounts.filter { $0.kind == kind }
    }

    /// Whether the Claude provider rotates accounts. Only known from the config, which the store does
    /// not read; the Accounts pane sets it once it has loaded the config.
    public var claudeRotation: Bool?

    /// Readiness problems the router reports, in its own words (`settings`, `upstream`, `provider:x`).
    public var problems: [String] { status?.readiness?.problems ?? [] }
}
