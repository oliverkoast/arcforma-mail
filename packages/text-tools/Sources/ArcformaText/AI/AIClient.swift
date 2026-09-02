import Foundation

enum AIError: Error, Equatable {
    case notConfigured
    case daemonUnreachable
    case notLoggedIn
    case modelUnsupported
    case http(Int, String)
    case timeout
    case cancelled
    case badResponse
    case cliFailed(String)
    case truncated
    case empty

    var chipText: String {
        switch self {
        case .notLoggedIn: return "Sign in to Claude Code"
        case .timeout: return "Timed out"
        case .cancelled: return "Cancelled"
        case .empty, .truncated: return "No changes"
        case .modelUnsupported: return "Model unavailable"
        case .notConfigured, .daemonUnreachable: return "AI unavailable"
        case .http, .badResponse, .cliFailed: return "AI failed"
        }
    }

    /// One of each case, for the string audit in the self-test.
    static let samples: [AIError] = [.notConfigured, .daemonUnreachable, .notLoggedIn, .modelUnsupported,
                                     .http(500, ""), .timeout, .cancelled, .badResponse, .cliFailed(""),
                                     .truncated, .empty]
}

struct DaemonConfig: Decodable {
    var port: Int
    var token: String

    static let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Arcforma/ai-daemon.json")

    static func load(from url: URL = DaemonConfig.url) -> DaemonConfig? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return parse(data)
    }

    /// The file carries more keys than we use (claudeBin, modelChain, local);
    /// only port and token are required.
    static func parse(_ data: Data) -> DaemonConfig? {
        guard let config = try? JSONDecoder().decode(DaemonConfig.self, from: data),
              config.port > 0, config.port <= 65535, !config.token.isEmpty else { return nil }
        return config
    }
}

struct Completion: Equatable {
    var text: String
    var model: String
    var latencyMs: Int
}

struct DaemonHealth: Decodable {
    var ok: Bool
    var loggedIn: Bool?
    var cliVersion: String?
    var model: String?
    var local: String?
    var inFlight: Int?
}

/// A cancellable in-flight request. `cancel()` runs on the main thread;
/// `isCancelled` is read from URLSession and CLI queues, hence the lock.
final class AIRequestHandle {
    private let lock = NSLock()
    private var cancelAction: (() -> Void)?
    private var cancelled = false

    init(cancel: (() -> Void)? = nil) { cancelAction = cancel }

    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    func setCancel(_ action: @escaping () -> Void) {
        lock.lock(); defer { lock.unlock() }
        cancelAction = action
    }

    func cancel() {
        lock.lock()
        guard !cancelled else { lock.unlock(); return }
        cancelled = true
        let action = cancelAction
        lock.unlock()
        action?()
    }
}

/// Talks to the local AI daemon over loopback with the bearer token from
/// ~/Library/Application Support/Arcforma/ai-daemon.json.
final class AIClient {
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    /// The self-test points this at a temp file or a missing path.
    var configURL: URL = DaemonConfig.url

    private var config: DaemonConfig? { DaemonConfig.load(from: configURL) }

    var isConfigured: Bool { config != nil }

    func request(_ method: String, _ path: String, timeout: TimeInterval) -> URLRequest? {
        guard let config, let url = URL(string: "http://127.0.0.1:\(config.port)\(path)") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return req
    }

    func health(timeout: TimeInterval = 1.5, completion: @escaping (Result<DaemonHealth, AIError>) -> Void) {
        guard let req = request("GET", "/v1/health", timeout: timeout) else {
            completion(.failure(.notConfigured)); return
        }
        session.dataTask(with: req) { data, response, error in
            let result: Result<DaemonHealth, AIError>
            if error != nil {
                result = .failure(.daemonUnreachable)
            } else if let data, let health = try? JSONDecoder().decode(DaemonHealth.self, from: data) {
                result = .success(health)
            } else {
                result = .failure(.badResponse)
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    /// Maps one /v1/complete exchange to a result. Pure, so the self-test can
    /// drive every branch without a server:
    /// 200 with text is success; 503 not_logged_in is `.notLoggedIn` (final,
    /// no CLI fallback); 503 model_unsupported is `.modelUnsupported`; a
    /// transport error is `.timeout` or `.daemonUnreachable` (connection
    /// refused, the case that falls back to the CLI).
    static func classify(status: Int, data: Data?, error: Error?, cancelled: Bool) -> Result<Completion, AIError> {
        if cancelled { return .failure(.cancelled) }
        if let error = error as NSError? {
            return .failure(error.code == NSURLErrorTimedOut ? .timeout : .daemonUnreachable)
        }
        let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        if status == 200, let json, let text = json["text"] as? String {
            return .success(Completion(text: text, model: json["model"] as? String ?? "",
                                       latencyMs: json["latencyMs"] as? Int ?? 0))
        }
        if status == 503, let code = json?["code"] as? String {
            switch code {
            case "not_logged_in": return .failure(.notLoggedIn)
            case "model_unsupported": return .failure(.modelUnsupported)
            default: return .failure(.http(status, code))
            }
        }
        if status == 0 { return .failure(.daemonUnreachable) }
        let message = data.map { String(decoding: $0.prefix(200), as: UTF8.self) } ?? ""
        return .failure(.http(status, message))
    }

    @discardableResult
    func complete(system: String, user: String, task: String, maxTokens: Int? = nil, timeoutMs: Int,
                  requestId: String = UUID().uuidString,
                  completion: @escaping (Result<Completion, AIError>) -> Void) -> AIRequestHandle {
        let handle = AIRequestHandle()
        guard var req = request("POST", "/v1/complete", timeout: TimeInterval(timeoutMs) / 1000 + 2) else {
            completion(.failure(.notConfigured)); return handle
        }
        var body: [String: Any] = ["system": system, "user": user, "task": task,
                                   "timeoutMs": timeoutMs, "requestId": requestId]
        if let maxTokens { body["maxTokens"] = maxTokens }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let task = session.dataTask(with: req) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let result = AIClient.classify(status: status, data: data, error: error, cancelled: handle.isCancelled)
            DispatchQueue.main.async { completion(result) }
        }
        handle.setCancel { [weak self] in
            task.cancel()
            self?.cancelRequest(requestId)
        }
        task.resume()
        return handle
    }

    func cancelRequest(_ requestId: String) {
        guard let req = request("DELETE", "/v1/complete/\(requestId)", timeout: 2) else { return }
        session.dataTask(with: req).resume()
    }
}

/// Daemon first, direct `claude -p` when the daemon is not configured or not
/// reachable. Login and model errors from the daemon are final: the CLI would
/// fail the same way.
final class AIService {
    static let shared = AIService()
    let daemon = AIClient()
    let cli = ClaudeCLI()
    static let timeoutMs = 20_000

    /// `defaults write ai.arcforma.text aiBackend direct` (or env
    /// ARCFORMA_AI_BACKEND=direct) skips the daemon. The e2e harness uses it
    /// so a stub `claude` binary answers even while a daemon is configured.
    var forceDirectOverride: Bool?
    var forceDirect: Bool {
        if let forceDirectOverride { return forceDirectOverride }
        if ProcessInfo.processInfo.environment["ARCFORMA_AI_BACKEND"] == "direct" { return true }
        return UserDefaults.standard.string(forKey: "aiBackend") == "direct"
    }

    enum Backend: Equatable { case daemon(String), direct, signedOut, unavailable }

    /// Only a transport failure justifies trying the CLI. A daemon that
    /// answered (not logged in, unsupported model, HTTP error, timeout) has
    /// already said what the CLI would say.
    static func shouldFallBack(after error: AIError) -> Bool {
        error == .daemonUnreachable
    }

    /// A short summary for the status menu.
    func health(completion: @escaping (Backend, String) -> Void) {
        if forceDirect {
            cli.probe { available, detail in
                completion(available ? .direct : .unavailable,
                           available ? "AI: direct claude (\(detail))" : "AI: unavailable (\(detail))")
            }
            return
        }
        daemon.health { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let h) where h.ok:
                if h.loggedIn == false { completion(.signedOut, "AI: sign in to Claude Code"); return }
                let model = h.model ?? "unknown model"
                completion(.daemon(model), "AI: daemon ok, \(model)")
            case .success:
                completion(.unavailable, "AI: daemon reports a problem")
            case .failure:
                self.cli.probe { available, detail in
                    if available {
                        completion(.direct, "AI: daemon down, direct claude (\(detail))")
                    } else {
                        completion(.unavailable, "AI: unavailable (\(detail))")
                    }
                }
            }
        }
    }

    @discardableResult
    func complete(system: String, user: String, task: String,
                  completion: @escaping (Result<Completion, AIError>) -> Void) -> AIRequestHandle {
        let handle = AIRequestHandle()
        let timeout = TimeInterval(AIService.timeoutMs) / 1000
        guard daemon.isConfigured, !forceDirect else {
            let inner = cli.complete(system: system, user: user, timeout: timeout, completion: completion)
            handle.setCancel { inner.cancel() }
            return handle
        }
        let inner = daemon.complete(system: system, user: user, task: task, timeoutMs: AIService.timeoutMs) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result, AIService.shouldFallBack(after: error), !handle.isCancelled {
                Log.write("daemon unreachable, falling back to direct claude")
                let fallback = self.cli.complete(system: system, user: user, timeout: timeout, completion: completion)
                handle.setCancel { fallback.cancel() }
                return
            }
            completion(result)
        }
        handle.setCancel { inner.cancel() }
        return handle
    }
}
