import RippleKit
import SwiftUI

struct WorkersPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = WorkersModel()

    var body: some View {
        LoadableView(model.loadState, retry: { Task { await model.load(client: store.client) } }) { _ in
            Form {
                if store.status?.statusMod == false {
                    Section {
                        Label("The mod is off. These settings apply when it is enabled in Clients.", systemImage: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                }
                WorkersBasicSections(model: model)
                WorkersRoutingSections(model: model, accounts: store.accounts)
                WorkersOtherSections(model: model)
            }
            .formStyle(.grouped)
            .disabled(model.schemaUnsupported)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: Metrics.labelGap) {
                HStack {
                    if model.saving { ProgressView().controlSize(.mini) }
                    Label(model.status, systemImage: model.saveError == nil ? "checkmark.circle" : "exclamationmark.circle")
                        .font(.callout).foregroundStyle(model.saveError == nil ? Color.secondary : Theme.bad)
                    Spacer()
                    if model.saveError != nil, !model.schemaUnsupported, model.editor?.isDirty == true {
                        Button("Retry save") { Task { await model.save() } }
                            .buttonStyle(.glass).disabled(model.saving)
                    }
                }
                InlineError(model.saveError)
            }
            .padding(Metrics.inset)
            .background(.bar)
        }
        .task { await model.load(client: store.client) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.load(client: store.client) } }
        }
    }
}
