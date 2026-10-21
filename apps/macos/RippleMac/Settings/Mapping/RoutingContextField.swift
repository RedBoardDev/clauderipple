import RippleKit
import SwiftUI

/// Keep partial numeric input local; never send an invalid or half-typed window to the router.
struct RoutingContextField: View {
    let value: Int?
    let placeholder: String
    let commit: (Int?) -> Void
    @State private var text = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.labelGap) {
            TextField(placeholder, text: $text)
                .accessibilityLabel("Context window")
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(save)
                .onChange(of: focused) { _, active in if !active { save() } }
            InlineError(error)
        }
        .onAppear { text = value.map(String.init) ?? "" }
        .onChange(of: value) { _, value in if !focused { text = value.map(String.init) ?? "" } }
    }

    private func save() {
        do {
            let parsed = try ConfigEdits.contextWindow(text)
            error = nil
            if parsed != value { commit(parsed) }
        } catch { self.error = error.localizedDescription }
    }
}
