import RippleKit
import SwiftUI

/// Today's totals from the request log: requests, cache hit, failures.
struct TodayStrip: View {
    @Environment(RouterStore.self) private var store

    var body: some View {
        let total = store.today?.total
        HStack(alignment: .top, spacing: 0) {
            stat("Today", total.map { "\($0.count.formatted()) req" } ?? "—",
                 help: store.today?.isRange == false ? "Since midnight, from the router's in-memory log (last 2,000 requests)." : "Since midnight.")
            stat("Cache hit", total.map { Format.percent($0.cacheHitPercent) } ?? "—",
                 help: "Share of input tokens read from the prompt cache.")
            stat("Failed", total.map { "\($0.failed)" } ?? "—", tone: (total?.failed ?? 0) > 0 ? Theme.warn : nil,
                 help: "Requests that ended in an error today.")
        }
        .padding(.top, 10)
        .overlay(alignment: .top) { Divider() }
    }

    private func stat(_ title: String, _ value: String, tone: Color? = nil, help: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value)
                .font(.data(13, weight: .semibold))
                .foregroundStyle(tone.map(AnyShapeStyle.init) ?? AnyShapeStyle(.primary))
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(help)
    }
}
