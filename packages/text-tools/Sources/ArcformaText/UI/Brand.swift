import AppKit
import CoreText

/// Brand tokens from arcforma-brand/styles.css, consumed verbatim. No new hex.
/// Light only: NSAppearance.aqua is forced on the app.
enum Brand {
    static let white = color(0xFFFFFF)
    static let mist = color(0xF7F7F8)
    static let ink = color(0x0E0E0F)
    static let ink2 = color(0x3F3F46)
    static let inkSoft = color(0x75757E)
    static let cobalt = color(0x0845AC)
    static let bright = color(0x3B6FE0)   // focus ring only
    static let rule = color(0xE6E6E9)     // interior structure only

    static let cardRadius: CGFloat = 14
    static let pillRadius: CGFloat = 999
    /// Below 120 pt the wordmark waits for the standalone mark (F-02).
    static let wordmarkMinWidth: CGFloat = 120
    static let hoverDuration: TimeInterval = 0.24

    private static func color(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    // MARK: Appearance

    static func forceLightAppearance() {
        NSApp.appearance = NSAppearance(named: .aqua)
    }

    // MARK: Fonts

    enum Family: String {
        case inter = "Inter"
        case mono = "Roboto Mono"
        case button = "Archivo"
    }

    private static var registered = false
    private static var availableFamilies = Set<String>()

    /// Registers the bundled variable fonts for this process. The files keep
    /// their upstream names with brackets (Inter[opsz,wght].ttf); renaming
    /// would only matter for SwiftPM resource handling, which build.sh bypasses.
    static func registerFonts() {
        guard !registered else { return }
        registered = true
        guard let dir = Resources.fontsDirectory,
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            Log.error("fonts: Resources/fonts not found, falling back to system fonts")
            return
        }
        for url in files where url.pathExtension.lowercased() == "ttf" {
            var error: Unmanaged<CFError>?
            if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                Log.write("fonts: registered \(url.lastPathComponent)")
            } else if let error = error?.takeRetainedValue() {
                // Already registered (a relaunch in the same session) is fine.
                Log.write("fonts: \(url.lastPathComponent): \(CFErrorCopyDescription(error) as String? ?? "error")")
            }
        }
        availableFamilies = Set(NSFontManager.shared.availableFontFamilies)
    }

    /// A brand font at a variable weight (100 to 900), with a system fallback
    /// when the family is not registered.
    static func font(_ family: Family, size: CGFloat, weight: CGFloat = 400) -> NSFont {
        registerFonts()
        if availableFamilies.contains(family.rawValue),
           let base = NSFont(descriptor: NSFontDescriptor(fontAttributes: [.family: family.rawValue]), size: size) {
            // Apply the weight axis as a CoreText variation on the base face.
            // Setting kCTFontVariationAttribute on the family descriptor is
            // ignored for Inter (two axes, opsz and wght); the copy route
            // works for all three families.
            let wghtAxis = NSNumber(value: 0x77676874) // 'wght'
            let variation = CTFontDescriptorCreateWithAttributes(
                [kCTFontVariationAttribute: [wghtAxis: weight]] as CFDictionary)
            return CTFontCreateCopyWithAttributes(base as CTFont, size, nil, variation) as NSFont
        }
        let systemWeight: NSFont.Weight = weight >= 600 ? .semibold : weight >= 500 ? .medium : .regular
        return family == .mono
            ? NSFont.monospacedSystemFont(ofSize: size, weight: systemWeight)
            : NSFont.systemFont(ofSize: size, weight: systemWeight)
    }

    /// 11 pt uppercase mono eyebrow at 0.14em tracking, ink-soft.
    static func eyebrow(_ text: String) -> NSAttributedString {
        NSAttributedString(string: text.uppercased(), attributes: [
            .font: font(.mono, size: 11, weight: 500),
            .foregroundColor: inkSoft,
            .kern: 11 * 0.14,
        ])
    }

    // MARK: Wordmark

    /// The ink wordmark file, rendered by NSImage from the SVG data. Never set
    /// as type. Aspect 291.64 x 48.3.
    static func wordmark(width: CGFloat = wordmarkMinWidth) -> NSImage? {
        guard let url = Resources.wordmarkURL, let data = try? Data(contentsOf: url),
              let image = NSImage(data: data) else {
            Log.error("wordmark: arcforma-wordmark-ink.svg not found")
            return nil
        }
        image.size = NSSize(width: width, height: width * 48.3 / 291.64)
        return image
    }
}

// MARK: - Shared panel chrome

/// A borderless non-activating panel: the host app stays frontmost. The
/// shadow is the OS default (`hasShadow` untouched): the brand system defines
/// no shadow, logged as F-MAIL-03, the minimal deviation for a floating panel.
class CardPanel: NSPanel {
    private let keyable: Bool

    init(size: NSSize, keyable: Bool) {
        self.keyable = keyable
        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        level = .floating
        isOpaque = false
        backgroundColor = .clear
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        animationBehavior = .utilityWindow
        appearance = NSAppearance(named: .aqua)

        let card = CardView(frame: NSRect(origin: .zero, size: size))
        card.autoresizingMask = [.width, .height]
        contentView = card
    }

    override var canBecomeKey: Bool { keyable }
    override var canBecomeMain: Bool { false }

    var card: CardView { contentView as! CardView }

    /// Places the panel above `rect` (Cocoa coordinates), or 12 pt above the
    /// mouse when there is no rect, clamped to the screen.
    func place(above rect: CGRect?, gap: CGFloat = 8) {
        let anchor: CGRect = rect ?? {
            let m = NSEvent.mouseLocation
            return CGRect(x: m.x, y: m.y + 12, width: 0, height: 0)
        }()
        let screen = NSScreen.screens.first { $0.frame.contains(CGPoint(x: anchor.midX, y: anchor.midY)) }
            ?? NSScreen.main ?? NSScreen.screens[0]
        let visible = screen.visibleFrame
        var origin = CGPoint(x: anchor.midX - frame.width / 2, y: anchor.maxY + gap)
        if origin.y + frame.height > visible.maxY {
            origin.y = anchor.minY - gap - frame.height
        }
        origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - frame.width - 8)
        origin.y = min(max(origin.y, visible.minY + 8), visible.maxY - frame.height - 8)
        setFrameOrigin(origin)
    }
}

/// White ground, 14 pt radius, 1 pt rule edge.
final class CardView: NSView {
    var cornerRadius: CGFloat = Brand.cardRadius { didSet { needsDisplay = true } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: inset, xRadius: cornerRadius, yRadius: cornerRadius)
        Brand.white.setFill()
        path.fill()
        Brand.rule.setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    override var isFlipped: Bool { false }
}
