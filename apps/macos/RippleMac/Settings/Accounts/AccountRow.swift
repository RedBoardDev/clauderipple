import RippleKit
import SwiftUI

/// One account in a grouped form: name and badges, detail, usage line, and its actions on the right.
struct AccountRow<Actions: View>: View {
    let title: String
    let detail: String?
    let usage: String?
    let badges: [StatusBadge]
    let busy: Bool
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(title).font(.body.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    ForEach(Array(badges.enumerated()), id: \.offset) { $0.element }
                }
                if let detail {
                    Text(detail).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                if let usage {
                    Text(usage).font(.data(11.5)).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if busy { ProgressView().controlSize(.small) }
            HStack(spacing: 6) { actions() }
                .controlSize(.small)
                .disabled(busy)
        }
        .padding(.vertical, 2)
    }
}

/// The "…" menu that holds a row's rename and remove, so destructive acts sit one click away
/// from the row's main buttons.
struct AccountMoreMenu: View {
    let onRename: () -> Void
    let onRemove: () -> Void

    var body: some View {
        Menu {
            Button("Rename…", systemImage: "pencil", action: onRename)
            Divider()
            Button("Remove…", systemImage: "trash", role: .destructive, action: onRemove)
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More")
        .accessibilityLabel("More actions")
    }
}
