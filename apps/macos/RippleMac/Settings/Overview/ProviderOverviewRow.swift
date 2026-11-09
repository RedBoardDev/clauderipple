import RippleKit
import SwiftUI

struct ProviderOverviewRow: View {
    let provider: RouterStatus.Provider
    /// Exhaustion deadlines are epoch milliseconds, unlike Swift dates.
    private static let millisecondsPerSecond: Double = 1000

    var body: some View {
        DisclosureGroup {
            LabeledContent("Type", value: provider.type)
            LabeledContent("Reachable", value: provider.reachable ? "Yes" : "No")
            LabeledContent("Usable", value: provider.usable ? "Yes" : "No")
            LabeledContent("Needs login", value: provider.needsLogin == true ? "Yes" : "No")
            LabeledContent("Needs verification", value: provider.needsVerification == true ? "Yes" : "No")
            LabeledContent("Authentication source", value: provider.authSource ?? "Not reported")
            LabeledContent("Account count", value: provider.accountCount.map(String.init) ?? "Not reported")
            if let exhaustion = provider.exhaustion {
                LabeledContent("Exhaustion", value: exhaustion.reason.replacingOccurrences(of: "_", with: " "))
                if let until = exhaustion.until {
                    LabeledContent("Until", value: Date(timeIntervalSince1970: until / Self.millisecondsPerSecond).formatted(date: .abbreviated, time: .shortened))
                }
            }
        } label: {
            HStack {
                Text(provider.name).fontWeight(.medium)
                Spacer()
                Text(verdict).foregroundStyle(provider.usable ? Theme.ok : Theme.warn)
            }
        }
    }

    private var verdict: String {
        if provider.exhaustion != nil { return "Exhausted" }
        if provider.needsLogin == true { return "Needs login" }
        if provider.needsVerification == true { return "Needs verification" }
        if provider.usable { return "Usable" }
        return provider.reachable ? "Reachable, not usable" : "Unreachable"
    }
}
