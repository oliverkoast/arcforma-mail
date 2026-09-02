import Foundation

/// Direct fallback: `claude -p` as a subprocess, one turn, JSON output, so
/// Cmd+J works even when the daemon is down. Model chain fable -> opus ->
/// sonnet on "does not support this model".
final class ClaudeCLI {
    static let defaultBinary = "/Users/oliverkorzen/.local/bin/claude"
    static let models = ["claude-fable-5-1", "opus", "sonnet"]
    private let queue = DispatchQueue(label: "ai.arcforma.text.cli", qos: .userInitiated)

    /// Set by the self-test to point at a stub script.
    var binaryOverride: String?

    /// Override via env ARCFORMA_CLAUDE_BIN or `defaults write ai.arcforma.text claudeBin <path>`.
    var binary: String {
        if let binaryOverride, !binaryOverride.isEmpty { return binaryOverride }
        if let env = ProcessInfo.processInfo.environment["ARCFORMA_CLAUDE_BIN"], !env.isEmpty { return env }
        if let d = UserDefaults.standard.string(forKey: "claudeBin"), !d.isEmpty { return d }
        return ClaudeCLI.defaultBinary
    }

    var isInstalled: Bool { FileManager.default.isExecutableFile(atPath: binary) }

    enum ParseError: Error, Equatable {
        case invalidJSON
        case isError(String)
        case missingResult
    }

    /// Parses `--output-format json`: `.result` is the text, `.is_error` flags
    /// a failure whose message is also in `.result`.
    static func parse(_ data: Data) -> Result<String, ParseError> {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure(.invalidJSON)
        }
        let result = json["result"] as? String
        if (json["is_error"] as? Bool) == true {
            return .failure(.isError(result ?? (json["error"] as? String) ?? "unknown error"))
        }
        guard let result else { return .failure(.missingResult) }
        return .success(result)
    }

    static func isModelUnsupported(_ message: String) -> Bool {
        message.lowercased().contains("does not support this model")
    }

    static func isNotLoggedIn(_ message: String) -> Bool {
        let m = message.lowercased()
        return m.contains("not logged in") || m.contains("please run /login") || m.contains("please log in")
            || m.contains("invalid api key") || m.contains("authentication")
    }

    /// The CLI consults the keychain first and can report "not logged in" while a fresh
    /// credential sits in ~/.claude/.credentials.json (seen 2026-09-02). Same order as the daemon:
    /// the long-lived token from ai-daemon.json (claude setup-token), then the credentials file
    /// when its access token is still valid, else nothing and the keychain decides.
    static func headlessToken(now: Date = Date()) -> String? {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        let daemonConfig = URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/Arcforma/ai-daemon.json")
        if let data = try? Data(contentsOf: daemonConfig),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let token = json["claudeOAuthToken"] as? String, !token.isEmpty {
            return token
        }
        let credentials = URL(fileURLWithPath: home).appendingPathComponent(".claude/.credentials.json")
        if let data = try? Data(contentsOf: credentials),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let oauth = json["claudeAiOauth"] as? [String: Any],
           let token = oauth["accessToken"] as? String, !token.isEmpty {
            if let expiresAt = oauth["expiresAt"] as? Double, expiresAt / 1000 - now.timeIntervalSince1970 < 300 { return nil }
            return token
        }
        return nil
    }

    struct Invocation {
        var arguments: [String]
        var environment: [String: String]
    }

    static func invocation(user: String, system: String, model: String) -> Invocation {
        let env = ProcessInfo.processInfo.environment
        var limited: [String: String] = [:]
        limited["HOME"] = env["HOME"] ?? NSHomeDirectory()
        limited["PATH"] = env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin"
        if let token = headlessToken() { limited["CLAUDE_CODE_OAUTH_TOKEN"] = token }
        return Invocation(
            arguments: ["-p", user, "--model", model, "--system-prompt", system,
                        "--output-format", "json", "--max-turns", "1",
                        "--disallowedTools", "*", "--no-session-persistence"],
            environment: limited)
    }

    /// Runs the model chain on a background queue. `timeout` applies per model.
    @discardableResult
    func complete(system: String, user: String, timeout: TimeInterval = 20,
                  completion: @escaping (Result<Completion, AIError>) -> Void) -> AIRequestHandle {
        let handle = AIRequestHandle()
        let lock = NSLock()
        var current: Process?
        handle.setCancel {
            lock.lock(); let p = current; lock.unlock()
            if let p { ClaudeCLI.terminate(p) }
        }
        guard isInstalled else {
            completion(.failure(.cliFailed("claude binary not found at \(binary)")))
            return handle
        }
        queue.async { [binary] in
            var lastError: AIError = .cliFailed("no model attempted")
            for model in ClaudeCLI.models {
                if handle.isCancelled { lastError = .cancelled; break }
                let started = Date()
                let run = ClaudeCLI.run(binary: binary, user: user, system: system, model: model,
                                        timeout: timeout, register: { p in lock.lock(); current = p; lock.unlock() })
                switch run {
                case .success(let text):
                    let ms = Int(Date().timeIntervalSince(started) * 1000)
                    DispatchQueue.main.async { completion(.success(Completion(text: text, model: model, latencyMs: ms))) }
                    return
                case .failure(let error):
                    lastError = error
                    if error == .modelUnsupported {
                        Log.write("claude: \(model) unsupported, trying next model")
                        continue
                    }
                    DispatchQueue.main.async { completion(.failure(error)) }
                    return
                }
            }
            DispatchQueue.main.async { completion(.failure(lastError)) }
        }
        return handle
    }

    /// How long a process gets after SIGTERM before SIGKILL.
    static let killGrace: TimeInterval = 1.0

    private static func run(binary: String, user: String, system: String, model: String,
                            timeout: TimeInterval, register: (Process) -> Void) -> Result<String, AIError> {
        let inv = invocation(user: user, system: system, model: model)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = inv.arguments
        process.environment = inv.environment
        // Without stdin redirected to /dev/null the CLI waits 3 s for stdin.
        process.standardInput = FileHandle.nullDevice
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        // Both pipes drain concurrently. Reading them one after the other
        // deadlocks when the CLI fills the 64 KB stderr buffer before it
        // closes stdout.
        let drained = DispatchGroup()
        let collect = { (handle: FileHandle) -> () -> Data in
            var buffer = Data()
            let lock = NSLock()
            drained.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                let data = handle.readDataToEndOfFile()
                lock.lock(); buffer = data; lock.unlock()
                drained.leave()
            }
            return { lock.lock(); defer { lock.unlock() }; return buffer }
        }

        do { try process.run() } catch {
            return .failure(.cliFailed("launch failed: \(error.localizedDescription)"))
        }
        register(process)
        let stdoutData = collect(out.fileHandleForReading)
        let stderrData = collect(err.fileHandleForReading)

        var timedOut = false
        let timer = DispatchWorkItem {
            if process.isRunning { timedOut = true; ClaudeCLI.terminate(process) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
        process.waitUntilExit()
        timer.cancel()
        // A grandchild can hold the pipes open after the CLI exits; do not
        // wait on it forever.
        if drained.wait(timeout: .now() + 0.5) == .timedOut {
            try? out.fileHandleForReading.close()
            try? err.fileHandleForReading.close()
        }
        let stdout = stdoutData()
        let stderr = stderrData()

        if timedOut { return .failure(.timeout) }
        if process.terminationReason == .uncaughtSignal { return .failure(.cancelled) }

        switch parse(stdout) {
        case .success(let text):
            return .success(text)
        case .failure(.isError(let message)):
            if isModelUnsupported(message) { return .failure(.modelUnsupported) }
            if isNotLoggedIn(message) { return .failure(.notLoggedIn) }
            return .failure(.cliFailed(message))
        case .failure(let parseError):
            let text = String(decoding: stderr.prefix(300), as: UTF8.self)
                + String(decoding: stdout.prefix(300), as: UTF8.self)
            if isModelUnsupported(text) { return .failure(.modelUnsupported) }
            if isNotLoggedIn(text) { return .failure(.notLoggedIn) }
            return .failure(.cliFailed("\(parseError) exit \(process.terminationStatus): \(text.trimmingCharacters(in: .whitespacesAndNewlines))"))
        }
    }

    /// SIGTERM, then SIGKILL after `killGrace` if the process is still up.
    static func terminate(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + killGrace) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    /// `claude --version`, for the status line and the self-test.
    func probe(completion: @escaping (Bool, String) -> Void) {
        guard isInstalled else { completion(false, "claude not found at \(binary)"); return }
        queue.async { [binary] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: binary)
            p.arguments = ["--version"]
            p.standardInput = FileHandle.nullDevice
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            var text = ""
            do {
                try p.run()
                text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                p.waitUntilExit()
            } catch {
                DispatchQueue.main.async { completion(false, error.localizedDescription) }
                return
            }
            let ok = p.terminationStatus == 0
            DispatchQueue.main.async { completion(ok, ok ? text : "exit \(p.terminationStatus)") }
        }
    }
}
