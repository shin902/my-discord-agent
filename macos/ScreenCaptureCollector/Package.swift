// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ScreenCaptureCollector",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "ScreenCaptureCollector", targets: ["ScreenCaptureCollector"]),
    ],
    targets: [
        .executableTarget(
            name: "ScreenCaptureCollector",
            path: "Sources/ScreenCaptureCollector"
        ),
        .testTarget(
            name: "ScreenCaptureCollectorTests",
            dependencies: ["ScreenCaptureCollector"],
            path: "Tests/ScreenCaptureCollectorTests"
        ),
    ]
)
