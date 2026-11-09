import SwiftUI

/// Shared building blocks for the settings panes, so every pane loads, fails and retries the same way.

/// Load state of a pane's data.
public enum Loadable<Value> {
    case loading
    case loaded(Value)
    case failed(AdminError)

    public var value: Value? { if case let .loaded(v) = self { v } else { nil } }
}

/// Shows a spinner, the loaded content, or the error with a Retry button.
public struct LoadableView<Value, Content: View>: View {
    let state: Loadable<Value>
    let retry: () -> Void
    @ViewBuilder let content: (Value) -> Content

    public init(_ state: Loadable<Value>, retry: @escaping () -> Void, @ViewBuilder content: @escaping (Value) -> Content) {
        self.state = state
        self.retry = retry
        self.content = content
    }

    public var body: some View {
        switch state {
        case .loading:
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 120)
        case let .loaded(value):
            content(value)
        case let .failed(error):
            ContentUnavailableView {
                Label(error == .offline ? "Router not answering" : "Couldn't load", systemImage: error == .offline ? "bolt.horizontal.circle" : "exclamationmark.triangle")
            } description: {
                Text(error.userMessage)
            } actions: {
                Button("Retry", action: retry).buttonStyle(.glass)
            }
            .frame(maxWidth: .infinity, minHeight: 220)
        }
    }
}

/// Inline error line under a control that failed to apply.
public struct InlineError: View {
    let message: String?

    public init(_ message: String?) { self.message = message }

    public var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.circle.fill")
                .font(.callout)
                .foregroundStyle(Theme.bad)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Section footer text in the grouped-form style.
public struct FormNote: View {
    let text: String

    public init(_ text: String) { self.text = text }

    public var body: some View {
        Text(text).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

public extension Error {
    /// Any error as the admin error the UI knows how to word.
    var asAdminError: AdminError { (self as? AdminError) ?? .decoding(localizedDescription) }
}
