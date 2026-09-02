// swift-tools-version:5.9
import PackageDescription

// Arcforma Text: a menu-bar text tool in the clipstack lineage.
// Zero third-party dependencies. Deployment target macOS 14.
//
// Resources (fonts, wordmark) live in ../Resources at the package root and are
// copied into the .app bundle's Contents/Resources by build.sh, not declared
// here. SwiftPM only accepts resources inside the target directory and its
// generated Bundle.module accessor traps when the resource bundle is missing,
// which would take the whole app down on a packaging slip. Resources.swift
// locates the folder at runtime instead (app bundle first, then the package
// checkout for `swift run` and `--selftest`).
let package = Package(
    name: "ArcformaText",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ArcformaText",
            path: "Sources/ArcformaText"
        )
    ]
)
