import RippleKit
import SwiftUI

struct ActivityTotals: View {
    let bucket: SummaryBucket?

    /// Match the system body size while keeping live counters stable.
    private static let dataSize: CGFloat = 13

    var body: some View {
        Group {
            LabeledContent("Requests", value: String(bucket?.count ?? 0))
            LabeledContent("OK", value: String(bucket?.ok ?? 0))
            LabeledContent("Failed", value: String(bucket?.failed ?? 0))
            LabeledContent("Input tokens (uncached)", value: Format.tokens(bucket?.input ?? 0))
            LabeledContent("Cached tokens", value: Format.tokens(bucket?.cached ?? 0))
            LabeledContent("Cache-write tokens", value: Format.tokens(bucket?.cacheWrite ?? 0))
            LabeledContent("Output tokens", value: Format.tokens(bucket?.output ?? 0))
            LabeledContent("Cache hit", value: Format.percent(bucket?.cacheHitPercent ?? 0))
            LabeledContent("Average duration", value: "\(Int((bucket?.avgMs ?? 0).rounded())) ms")
        }
        .font(.data(Self.dataSize))
    }
}

struct ActivityModelsTable: View {
    let models: [ModelBucket]

    /// A bounded table keeps the grouped form usable with many model variants.
    private static let tableHeight: CGFloat = 230
    private static let dataSize: CGFloat = 12

    var body: some View {
        Table(models) {
            TableColumn("Provider", value: \.provider)
            TableColumn("Model", value: \.model)
            TableColumn("Requests") { Text(String($0.bucket.count)) }
            TableColumn("Input") { Text(Format.tokens($0.bucket.input + $0.bucket.cached + $0.bucket.cacheWrite)) }
            TableColumn("Output") { Text(Format.tokens($0.bucket.output)) }
            TableColumn("Cache hit") { Text(Format.percent($0.bucket.cacheHitPercent)) }
        }
        .font(.data(Self.dataSize))
        .frame(height: Self.tableHeight)
        .help("Input includes uncached, cached and cache-write tokens.")
        .overlay {
            if models.isEmpty { ContentUnavailableView("No model usage", systemImage: "tray") }
        }
    }
}
