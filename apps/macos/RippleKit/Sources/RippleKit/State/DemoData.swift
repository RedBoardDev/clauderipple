import Foundation

/// Made-up accounts covering every state the panel draws (active, preferred, a spent 5-hour window,
/// a cooldown, ChatGPT weekly-only), for `--demo`, previews and snapshot checks. No real values.
public enum DemoData {
    private static let hour: TimeInterval = 3600
    private static let day: TimeInterval = 86_400

    public static func accounts(now: Date = Date()) -> [AccountUsage] {
        func window(_ used: Double, minutes: Int, resetsIn: TimeInterval) -> UsageWindowState {
            UsageWindowState(usedPercent: used, windowMinutes: minutes, resetsAt: now.addingTimeInterval(resetsIn))
        }
        func row(_ kind: ProviderKind, _ provider: String, _ id: String, _ label: String, plan: String?, active: Bool = false,
                 preferred: Bool = false, health: AccountHealth = .ready, fiveHour: UsageWindowState?, weekly: UsageWindowState?) -> AccountUsage {
            AccountUsage(kind: kind, provider: provider, accountId: id, label: label, plan: plan, isActive: active,
                         isPreferred: preferred, health: health, fiveHour: fiveHour, weekly: weekly,
                         pace: Pace.compute(for: weekly, now: now), fetchedAt: now.addingTimeInterval(-90))
        }
        return [
            row(.claude, "claude", "demo-work", "Work", plan: "max", active: true,
                fiveHour: window(97, minutes: Quota.fiveHourMinutes, resetsIn: 1 * hour + 12 * 60),
                weekly: window(49, minutes: Quota.weeklyMinutes, resetsIn: 4 * day + 19 * hour)),
            row(.claude, "claude", "demo-personal", "Personal", plan: "max", preferred: true,
                fiveHour: window(7, minutes: Quota.fiveHourMinutes, resetsIn: 3 * hour + 40 * 60),
                weekly: window(2, minutes: Quota.weeklyMinutes, resetsIn: 6 * day + 20 * hour)),
            row(.chatgpt, "chatgpt-subscription", "demo-pro", "Pro account", plan: "prolite", active: true,
                fiveHour: nil, weekly: window(52, minutes: Quota.weeklyMinutes, resetsIn: 6 * day + 16 * hour)),
            row(.chatgpt, "chatgpt-subscription", "demo-spare", "Spare", plan: "plus",
                health: .cooling(until: now.addingTimeInterval(25 * 60)),
                fiveHour: window(100, minutes: Quota.fiveHourMinutes, resetsIn: 25 * 60),
                weekly: window(81, minutes: Quota.weeklyMinutes, resetsIn: 2 * day + 3 * hour)),
        ]
    }

    public static func status() -> RouterStatus? {
        let text = """
        {"version":"0.11.1","readiness":{"ready":true,"problems":[]},"runtime":{"node":"v24.3.0","router":"0.11.1","startedAt":"2026-10-21T06:00:00.000Z"},
        "stats":{"inFlight":2,"messagesInFlight":2,"started":1290,"completed":1288,"failed":0},"routes":6,"adminPort":8791,
        "cliVersion":"0.11.1","statusMod":true,"picker":{"enabled":true,"hosts":[],"last":null},
        "providers":{"claude":{"url":"https://api.anthropic.com","type":"anthropic","reachable":true,"usable":true,"accountCount":2},
        "chatgpt-subscription":{"url":"https://chatgpt.com","type":"chatgpt","reachable":true,"usable":true,"accountCount":2}},
        "chatgpt":{"quota":{},"auth":{},"signedIn":{},"accounts":{}},"credentials":{}}
        """
        return try? RouterStatus(document: JSONValue(string: text))
    }

    public static func today() -> RequestSummary? {
        let text = #"{"total":{"count":1284,"ok":1284,"failed":0,"input":1200000,"cached":18400000,"cacheWrite":900000,"output":640000,"cacheHitPercent":94,"avgMs":4200},"providers":{},"models":[],"earliest":null,"from":0,"to":1}"#
        return try? JSONDecoder().decode(RequestSummary.self, from: Data(text.utf8))
    }

    public static func power() -> PowerStatus? {
        let text = #"{"platform":"darwin","awake":{"mode":"working","applied":true,"reason":"2 requests in flight","setup":"ok","battery":{"percent":84,"onBattery":false},"thermal":"normal","lidClosed":false,"until":null},"tether":{"enabled":false,"network":"wifi","state":"off","pinned":false,"hotspotSsid":"","lastSwitch":null,"lastProbe":null,"hint":null}}"#
        return try? JSONDecoder().decode(PowerStatus.self, from: Data(text.utf8))
    }

    @MainActor
    public static func store(now: Date = Date()) -> RouterStore {
        RouterStore(preview: accounts(now: now), status: status(), today: today(), power: power(), claudeRotation: true, updated: now)
    }
}
