import Foundation

/// Owns the one in-flight model call and the system-wide Escape chord that
/// cancels it. Escape is registered only between `begin` and the matching
/// `end` or `cancel`, and every path releases it.
///
/// `begin` after `end` for the same generation is ignored: an action whose
/// backend fails synchronously (no config, no binary) completes before its
/// handle is handed back, and without the generation check that late
/// registration would arm Escape with nothing to cancel and never release it.
final class InFlightCoordinator {
    private let escapeKey = HotKey()
    private(set) var handle: AIRequestHandle?
    private var generation = 0
    /// Chip and log hook for a cancel.
    var onCancel: (() -> Void)?

    var isEscapeArmed: Bool { escapeKey.isRegistered }
    var isActive: Bool { handle != nil }

    /// A token for one action run. Pass it back to `begin` and `end`.
    func nextGeneration() -> Int {
        generation += 1
        return generation
    }

    /// Registers `handle` for generation `gen`, arming Escape. Ignored when
    /// that generation already ended.
    func begin(_ newHandle: AIRequestHandle, generation gen: Int) {
        guard gen == generation, !ended.contains(gen) else { return }
        handle = newHandle
        escapeKey.register(Chords.escape) { [weak self] in self?.cancel() }
    }

    /// Marks generation `gen` complete (success or failure) and disarms Escape.
    func end(generation gen: Int) {
        ended.insert(gen)
        if ended.count > 64 { ended = ended.filter { $0 > gen - 8 } }
        guard gen == generation else { return }
        handle = nil
        escapeKey.unregister()
    }

    /// Escape: cancel the in-flight call and disarm.
    func cancel() {
        guard let current = handle else { escapeKey.unregister(); return }
        current.cancel()
        handle = nil
        escapeKey.unregister()
        onCancel?()
    }

    /// Quit path.
    func shutdown() {
        handle?.cancel()
        handle = nil
        escapeKey.unregister()
    }

    private var ended = Set<Int>()
}
