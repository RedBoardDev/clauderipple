import Foundation

public enum ProviderKind: String, Sendable, Equatable, CaseIterable {
    case claude, chatgpt

    public var title: String {
        switch self {
        case .claude: "Claude"
        case .chatgpt: "ChatGPT"
        }
    }

    /// The router reports a ChatGPT account's quota as fresh for 10 minutes and Claude's for 5
    /// (feature/limits-view, limits.ts callers). Twice that before the app calls a fallback reading
    /// stale: the router refreshes on read once its TTL passes, so the TTL alone would flicker.
    public var staleAfter: TimeInterval {
        switch self {
        case .claude: 2 * 5 * 60
        case .chatgpt: 2 * 10 * 60
        }
    }
}

/// One usage window, normalized from either API generation.
public struct UsageWindowState: Sendable, Equatable {
    public let usedPercent: Double
    public let windowMinutes: Int
    public let resetsAt: Date?

    public init(usedPercent: Double, windowMinutes: Int, resetsAt: Date?) {
        self.usedPercent = usedPercent
        self.windowMinutes = windowMinutes
        self.resetsAt = resetsAt
    }

    /// Share still available, 0…100. Purchased credits can push usage past 100; nothing is left then.
    public var leftPercent: Double { max(0, 100 - usedPercent) }
    public var isExhausted: Bool { usedPercent >= Self.exhaustedAt }
    public var length: TimeInterval { TimeInterval(windowMinutes * 60) }

    /// At or above this the window refuses requests (providers report 100, sometimes 99.x).
    public static let exhaustedAt: Double = 99.5
}

public enum AccountHealth: Sendable, Equatable {
    case ready
    /// Cooling down after a rate-limit or error answer.
    case cooling(until: Date?)
    case paused
    case needsLogin
    case other(String)

    init(routerState: String?, pausedUntil: Date?) {
        switch routerState {
        case nil, "ready": self = .ready
        case "cooling", "paused-until": self = .cooling(until: pausedUntil)
        case "paused": self = .paused
        case "needs-login", "quarantined": self = .needsLogin
        case let other?: self = .other(other)
        }
    }

    public var isUsable: Bool { self == .ready }
}

/// One Claude or ChatGPT account, as the popover draws it.
public struct AccountUsage: Sendable, Equatable, Identifiable {
    public var id: String { "\(kind.rawValue):\(provider):\(accountId)" }
    public let kind: ProviderKind
    /// The router's provider name (config key), e.g. "chatgpt-subscription".
    public let provider: String
    public let accountId: String
    public let label: String
    public let plan: String?
    public let isActive: Bool
    public let isPreferred: Bool
    public let health: AccountHealth
    public let fiveHour: UsageWindowState?
    public let weekly: UsageWindowState?
    public let fetchedAt: Date?
    public let isStale: Bool

    public init(kind: ProviderKind, provider: String, accountId: String, label: String, plan: String? = nil,
                isActive: Bool = false, isPreferred: Bool = false, health: AccountHealth = .ready,
                fiveHour: UsageWindowState? = nil, weekly: UsageWindowState? = nil,
                fetchedAt: Date? = nil, isStale: Bool = false) {
        self.kind = kind
        self.provider = provider
        self.accountId = accountId
        self.label = label
        self.plan = plan
        self.isActive = isActive
        self.isPreferred = isPreferred
        self.health = health
        self.fiveHour = fiveHour
        self.weekly = weekly
        self.fetchedAt = fetchedAt
        self.isStale = isStale
    }

    public var hasWindows: Bool { fiveHour != nil || weekly != nil }

    /// The binding constraint right now: a spent 5-hour window blocks even with week to spare.
    public var isBlocked: Bool { fiveHour?.isExhausted == true || weekly?.isExhausted == true }
}

/// Builds `AccountUsage` rows from whichever API the router offers. Pure, so both paths are pinned
/// by fixtures instead of by a live router.
public enum UsageBuilder {
    /// From the per-account `/api/limits`. Nil when the router only has the legacy anonymous rows,
    /// so the caller falls back to the account endpoints.
    public static func fromLimits(_ response: LimitsResponse, now: Date) -> [AccountUsage]? {
        var rows: [AccountUsage] = []
        var sawPerAccount = false
        for provider in response.providers {
            guard let kind = kind(forType: provider.type) else { continue }
            for account in provider.accounts where account.isPerAccount {
                sawPerAccount = true
                rows.append(row(kind: kind, provider: provider.provider, account, now: now))
            }
        }
        return sawPerAccount ? rows : nil
    }

    static func kind(forType type: String) -> ProviderKind? {
        switch type {
        case "anthropic": .claude
        case "chatgpt": .chatgpt
        default: nil
        }
    }

    static func row(kind: ProviderKind, provider: String, _ a: LimitsAccount, now: Date) -> AccountUsage {
        func state(_ w: LimitsAccount.UsageWindow?) -> UsageWindowState? {
            w.map { UsageWindowState(usedPercent: $0.usedPercent, windowMinutes: $0.windowMinutes, resetsAt: $0.resetAt.map(date(ms:))) }
        }
        let weekly = state(a.usageWindows?.weekly)
        return AccountUsage(
            kind: kind, provider: provider, accountId: a.id ?? String(a.account), label: a.label ?? "Account \(a.account + 1)",
            isActive: a.active ?? false, isPreferred: a.preferred ?? false,
            health: AccountHealth(routerState: a.health?.state, pausedUntil: a.health?.pausedUntil.map(date(ms:))),
            fiveHour: state(a.usageWindows?.fiveHour), weekly: weekly,
            fetchedAt: a.fetchedAt.map(date(ms:)), isStale: a.stale ?? false)
    }

    /// From `/api/claude-accounts` plus `/api/status` (ChatGPT accounts and the Claude pool's
    /// credential states): what a router without per-account limits (0.9.x) offers.
    public static func fromAccounts(claude: ClaudeAccountsResponse?, status: RouterStatus?, now: Date) -> [AccountUsage] {
        var rows: [AccountUsage] = []
        let claudeProvider = status?.claudeProvider?.name ?? "anthropic"
        let poolStates = status?.credentials[claudeProvider] ?? []
        if let current = claude?.current {
            rows.append(fromQuota(kind: .claude, provider: claudeProvider, id: current.id, label: current.label,
                                  plan: nil, active: false, preferred: !(claude?.accounts.contains { $0.preferred } ?? false),
                                  health: .ready, quota: current.quota, now: now))
        }
        for account in claude?.accounts ?? [] {
            let credential = poolStates.first { $0.id == account.id }
            let health: AccountHealth = account.needsReauth
                ? .needsLogin
                : AccountHealth(routerState: credential?.state,
                                pausedUntil: credential?.cooldownSeconds.map { now.addingTimeInterval($0) })
            rows.append(fromQuota(kind: .claude, provider: claudeProvider, id: account.id, label: account.label,
                                  plan: account.quota?.planType, active: false, preferred: account.preferred,
                                  health: health, quota: account.quota, now: now))
        }
        for group in status?.chatgptAccounts ?? [] {
            for account in group.accounts {
                let health: AccountHealth = account.paused
                    ? .paused
                    : account.needsReauth ? .needsLogin
                    : AccountHealth(routerState: account.state?.rawValue,
                                    pausedUntil: account.cooldownSeconds.map { now.addingTimeInterval($0) })
                rows.append(fromQuota(kind: .chatgpt, provider: group.provider, id: account.id,
                                      label: account.label.isEmpty ? (account.email ?? "ChatGPT") : account.label,
                                      plan: account.planType ?? account.quota?.planType, active: account.active,
                                      preferred: false, health: health, quota: account.quota, now: now))
            }
        }
        return rows
    }

    static func fromQuota(kind: ProviderKind, provider: String, id: String, label: String, plan: String?,
                          active: Bool, preferred: Bool, health: AccountHealth, quota: Quota?, now: Date) -> AccountUsage {
        let fetched = quota?.fetchedAt
        func state(_ w: QuotaWindow?, minutes: Int) -> UsageWindowState? {
            w.map { UsageWindowState(usedPercent: $0.usedPercent, windowMinutes: $0.windowMinutes ?? minutes, resetsAt: $0.resetDate(observedAt: fetched)) }
        }
        let weekly = state(quota?.weekly, minutes: Quota.weeklyMinutes)
        let fiveHour = state(quota?.fiveHour, minutes: Quota.fiveHourMinutes)
        let stale = quota?.stale == true || fetched.map { now.timeIntervalSince($0) >= kind.staleAfter } ?? true
        return AccountUsage(kind: kind, provider: provider, accountId: id, label: label, plan: plan,
                            isActive: active, isPreferred: preferred, health: health,
                            fiveHour: fiveHour, weekly: weekly,
                            fetchedAt: fetched, isStale: stale)
    }

    static func date(ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }
}
