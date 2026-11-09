import RippleKit
import SwiftUI

struct ActivityRequestRow: View {
    let record: RequestRecord
    @State private var expanded = false

    /// Small data labels fit alongside long provider and model names in the settings window.
    private static let dataSize: CGFloat = 12
    private var outcome: String {
        if record.resent == true { return "Resent" }
        return record.ok.map { $0 ? "OK" : "Failed" } ?? "Unknown"
    }
    private var symbol: String {
        if record.resent == true { return "arrow.clockwise.circle" }
        return record.ok.map { $0 ? "checkmark.circle.fill" : "xmark.circle.fill" } ?? "questionmark.circle"
    }
    private var tone: Color {
        if record.resent == true { return Theme.warn }
        return record.ok.map { $0 ? Theme.ok : Theme.bad } ?? .secondary
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: Metrics.labelGap) {
                detail("Request", record.id)
                detail("Time", record.at)
                detail("Duration", record.ms.map { "\(Int($0.rounded())) ms" })
                detail("Status", record.status?.text)
                detail("Outcome", outcome)
                detail("Kind", record.kind)
                detail("Source → target", "\(record.source ?? "—") → \(record.target ?? "—")")
                detail("Provider", record.provider)
                detail("Effort", record.effort)
                detail("Requested tier", record.requestedTier)
                detail("Served tier", record.servedTier)
                detail("Stop reason", record.stopReason)
                if let usage = record.usage {
                    detail("Input (uncached)", usage.input.map(Format.tokens))
                    detail("Cached", usage.cached.map(Format.tokens))
                    detail("Cache write", usage.cacheWrite.map(Format.tokens))
                    detail("Output", usage.output.map(Format.tokens))
                } else {
                    detail("Usage", nil)
                }
                detail("Refusal", record.refusal)
                detail("Purpose", record.purpose)
                detail("Note", record.note)
                detail("Session", record.session)
                detail("Streaming", record.stream.map { $0 ? "Yes" : "No" })
                detail("Upstream called", record.upstreamCalled.map { $0 ? "Yes" : "No" })
                detail("Upstream request", record.upstreamRequestId)
                detail("Message", record.messageId)
            }
            .font(.data(Self.dataSize))
            .textSelection(.enabled)
            .padding(.vertical, Metrics.labelGap)
        } label: {
            VStack(alignment: .leading, spacing: Metrics.labelGap) {
                HStack(alignment: .firstTextBaseline) {
                    Text(record.target ?? "Unknown model")
                        .lineLimit(1)
                        .help(record.target ?? "Unknown model")
                    Spacer()
                    Label("\(outcome) \(record.status?.text ?? "—")", systemImage: symbol)
                        .foregroundStyle(tone)
                }
                HStack {
                    Text(record.provider ?? "Unknown provider").lineLimit(1)
                    Spacer()
                    Text(record.date?.formatted(.dateTime.month(.abbreviated).day().hour().minute().second()) ?? record.at ?? "Unknown time")
                    Text(record.ms.map { "\(Int($0.rounded())) ms" } ?? "—")
                }
                .font(.data(Self.dataSize))
                .foregroundStyle(.secondary)
            }
        }
    }

    private func detail(_ title: String, _ value: String?) -> some View {
        LabeledContent(title) {
            Text(value ?? "—").fixedSize(horizontal: false, vertical: true)
        }
    }
}
