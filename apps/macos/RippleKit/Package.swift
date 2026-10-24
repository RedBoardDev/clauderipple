// swift-tools-version: 6.2
import PackageDescription

// macOS 26 floor: a personal menu-bar app built against the current SDK. 26.0 rather than a point
// release because SDK availability (Liquid Glass among it) is annotated against the major version.
let package = Package(
    name: "RippleKit",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "RippleKit", targets: ["RippleKit"]),
    ],
    targets: [
        .target(name: "RippleKit"),
        .testTarget(
            name: "RippleKitTests",
            dependencies: ["RippleKit"],
            resources: [.copy("Fixtures")],
        ),
    ],
    swiftLanguageModes: [.v6],
)
