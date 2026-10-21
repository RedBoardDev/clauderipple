import RippleKit
import SwiftUI

struct ActivityPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @State private var period: ActivityPeriod = .hour
    @State private var customFrom = Date()
    @State private var customTo = Date()
    @State private var provider = ""
    @State private var refreshRevision = 0
    @State private var summary: Loadable<ActivitySummary> = .loading
    @State private var requests: Loadable<[RequestRecord]> = .loading
    @State private var showRouterLog = false

    /// Match the dashboard's status cadence without polling an offscreen pane.
    private static let refreshInterval: Duration = .seconds(5)
    /// Recent rows scroll independently so the full 200-entry tail does not dwarf the summary.
    private static let requestsHeight: CGFloat = 420

    private struct SummaryKey: Equatable {
        let period: ActivityPeriod
        let from: Date
        let to: Date
        let revision: Int
    }

    private struct RequestsKey: Equatable {
        let provider: String
        let revision: Int
    }

    private var selectedProvider: String? { provider.isEmpty ? nil : provider }
    /// The router's ISO 8601 timestamp in the user's own date format; the raw text if it does not parse.
    private static func historyStart(_ iso: String) -> String {
        (try? Date(iso, strategy: .iso8601))?.formatted(date: .abbreviated, time: .shortened) ?? iso
    }

    private var providerNames: [String] {
        var names = Set(summary.value?.summary.providers.keys.map { $0 } ?? [])
        if !provider.isEmpty { names.insert(provider) }
        return names.sorted()
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Activity view", selection: $showRouterLog) {
                Text("Requests").tag(false)
                Text("Router log").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(Metrics.inset)

            if showRouterLog {
                ActivityRouterLog(client: store.client, refreshRevision: refreshRevision)
            } else {
                requestsForm
            }
        }
        .toolbar {
            ToolbarItem {
                Button("Refresh", systemImage: "arrow.clockwise") { refreshRevision += 1 }
                    .help("Refresh activity")
            }
        }
        .task(id: SummaryKey(period: period, from: customFrom, to: customTo, revision: refreshRevision)) {
            summary = .loading
            while !Task.isCancelled {
                await loadSummary()
                do { try await Task.sleep(for: Self.refreshInterval) } catch { return }
            }
        }
        .task(id: RequestsKey(provider: provider, revision: refreshRevision)) {
            requests = .loading
            while !Task.isCancelled {
                await loadRequests()
                do { try await Task.sleep(for: Self.refreshInterval) } catch { return }
            }
        }
    }

    private var requestsForm: some View {
        Form {
            Section {
                Picker("Period", selection: $period) {
                    ForEach(ActivityPeriod.allCases) { Text($0.title).tag($0) }
                }
                if period == .custom {
                    DatePicker("From", selection: $customFrom, in: ...Date(), displayedComponents: .date)
                    DatePicker("Through", selection: $customTo, in: ...Date(), displayedComponents: .date)
                }
                Picker("Provider", selection: $provider) {
                    Text("All providers").tag("")
                    ForEach(providerNames, id: \.self) { Text($0).tag($0) }
                }
            }

            LoadableView(summary, retry: refresh) { activity in
                Section {
                    FormNote(activity.note)
                    if let earliest = activity.summary.earliest {
                        LabeledContent("History starts", value: Self.historyStart(earliest))
                            .textSelection(.enabled)
                    }
                    if activity.periodAvailable {
                        ActivityTotals(bucket: activity.summary.bucket(for: selectedProvider))
                    }
                } header: {
                    Label("Summary · \(period.title)", systemImage: "chart.bar.xaxis")
                }
                if activity.periodAvailable, !activity.summary.models.isEmpty {
                    Section("By model") {
                        ActivityModelsTable(models: activity.summary.models(for: selectedProvider))
                    }
                }
            }

            Section {
                FormNote("Latest 200 message and image requests, newest first. This list is independent of the summary period.")
                LoadableView(requests, retry: refresh) { rows in
                    if rows.isEmpty {
                        ContentUnavailableView("No recent requests", systemImage: "tray")
                    } else {
                        List(rows) { ActivityRequestRow(record: $0) }
                            .listStyle(.inset)
                            .frame(height: Self.requestsHeight)
                    }
                }
            } header: {
                Label("Recent requests", systemImage: "clock.arrow.circlepath")
            }
        }
        .formStyle(.grouped)
    }

    private func refresh() { refreshRevision += 1 }

    private func loadSummary() async {
        let query = ActivityQuery.make(period: period, customFrom: customFrom, customTo: customTo)
        do {
            let value = try await store.client.activitySummary(query: query)
            guard !Task.isCancelled else { return }
            summary = .loaded(value)
        } catch {
            guard !Task.isCancelled else { return }
            summary = .failed(error.asAdminError)
        }
    }

    private func loadRequests() async {
        do {
            let value = try await store.client.recentRequests(provider: selectedProvider)
            guard !Task.isCancelled else { return }
            requests = .loaded(value)
        } catch {
            guard !Task.isCancelled else { return }
            requests = .failed(error.asAdminError)
        }
    }
}
