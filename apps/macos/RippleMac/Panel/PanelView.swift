import RippleKit
import SwiftUI

/// How often the open panel re-renders so countdowns stay current. Resets tick in minutes.
private let clockSeconds: TimeInterval = 20
/// Above this the account list scrolls instead of growing the panel past the screen.
private let maxAccountsHeight: CGFloat = 470

/// The menu-bar panel: header, per-account limits, the drain hint, today's totals, keep-awake, footer.
struct PanelView: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        TimelineView(.periodic(from: .now, by: clockSeconds)) { context in
            VStack(alignment: .leading, spacing: 0) {
                PanelHeader()
                    .padding(.horizontal, Metrics.inset)
                    .padding(.top, Metrics.inset)
                    .padding(.bottom, 10)
                content(now: context.date)
                Divider().padding(.top, Metrics.sectionGap)
                PanelFooter(app: app)
            }
        }
        .frame(width: Metrics.panelWidth)
        .background(background)
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if store.connection == .offline {
            RouterDownCard(app: app)
                .padding(.horizontal, Metrics.inset)
        } else if store.accounts.isEmpty {
            EmptyLimits(loading: store.connection == .connecting || store.lastUpdated == nil)
                .padding(.horizontal, Metrics.inset)
        } else {
            ScrollView(.vertical) {
                LimitsSection(now: now)
                    .padding(.horizontal, Metrics.inset)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: maxAccountsHeight)
            .fixedSize(horizontal: false, vertical: true)
            if let advice = store.drainAdvice {
                DrainHint(advice: advice, now: now)
                    .padding(.horizontal, Metrics.inset)
                    .padding(.top, 10)
            }
        }
        if store.connection != .offline {
            TodayStrip()
                .padding(.horizontal, Metrics.inset)
                .padding(.top, Metrics.sectionGap)
            if store.powerAvailable == true, let power = store.power {
                AwakeControl(power: power)
                    .padding(.horizontal, Metrics.inset)
                    .padding(.top, 10)
            }
        }
    }

    /// The system material by default; opaque under Reduce Transparency, where dense figures on
    /// whatever sits behind the menu bar are exactly the legibility problem that setting fixes.
    @ViewBuilder private var background: some View {
        if reduceTransparency {
            Color(nsColor: .windowBackgroundColor)
        }
    }
}

/// Nothing to draw yet: first poll in flight, or no account reports limits.
private struct EmptyLimits: View {
    let loading: Bool

    var body: some View {
        HStack(spacing: 10) {
            if loading { ProgressView().controlSize(.small) }
            Text(loading ? "Reading limits…" : "No Claude or ChatGPT account reports usage yet.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 64)
    }
}

/// Router down: say so, and offer the two ways out the tray offered.
private struct RouterDownCard: View {
    let app: AppController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("The router isn't answering", systemImage: "bolt.horizontal.circle.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.bad)
            Text("Claude can't reach its models until it's back. Repair restarts it; direct mode sends Claude straight to Anthropic meanwhile.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open recovery") { SettingsRoot.open(with: openWindow, pane: .overview) }
                .buttonStyle(.glassProminent)
                .controlSize(.small)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }
}
