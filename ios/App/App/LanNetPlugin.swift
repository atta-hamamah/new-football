import Capacitor
import Foundation
import Network

/// Local Wi-Fi multiplayer for Spot Kick.
///
/// Host: a TCP listener advertised over Bonjour as "_spotkick._tcp".
/// Client: browses for those services and connects to one.
/// Messages are length-prefixed binary frames; they cross the JS bridge as base64.
@objc(LanNetPlugin)
public class LanNetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LanNetPlugin"
    public let jsName = "LanNet"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startHost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopHost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendToPeer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "broadcast", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendToHost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
    ]

    private static let serviceType = "_spotkick._tcp"
    private static let maxFrame = 1 << 20

    private let queue = DispatchQueue(label: "spotkick.lan")
    private var listener: NWListener?
    private var peers: [String: NWConnection] = [:]
    private var nextPeer = 1
    private var browser: NWBrowser?
    private var endpoints: [String: NWEndpoint] = [:]
    private var hostConnection: NWConnection?

    private static func parameters() -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.includePeerToPeer = true
        return params
    }

    // MARK: framing

    private func send(_ data: Data, on conn: NWConnection) {
        var len = UInt32(data.count).bigEndian
        var frame = Data(bytes: &len, count: 4)
        frame.append(data)
        conn.send(content: frame, completion: .contentProcessed { _ in })
    }

    private func receiveFrames(on conn: NWConnection, onFrame: @escaping (Data) -> Void, onClose: @escaping () -> Void) {
        conn.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] header, _, isComplete, error in
            guard let self = self, let header = header, header.count == 4, error == nil else {
                onClose()
                return
            }
            let len = Int(header.withUnsafeBytes { $0.load(as: UInt32.self) }.bigEndian)
            if len < 0 || len > LanNetPlugin.maxFrame {
                onClose()
                return
            }
            if len == 0 {
                onFrame(Data())
                if isComplete { onClose() } else { self.receiveFrames(on: conn, onFrame: onFrame, onClose: onClose) }
                return
            }
            conn.receive(minimumIncompleteLength: len, maximumLength: len) { body, _, done, err in
                guard let body = body, body.count == len, err == nil else {
                    onClose()
                    return
                }
                onFrame(body)
                if done { onClose() } else { self.receiveFrames(on: conn, onFrame: onFrame, onClose: onClose) }
            }
        }
    }

    // MARK: host

    @objc func startHost(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? "Spot Kick"
        queue.async {
            self.stopHostInternal()
            do {
                let listener = try NWListener(using: LanNetPlugin.parameters())
                listener.service = NWListener.Service(name: name, type: LanNetPlugin.serviceType)
                listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
                var resolved = false
                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if !resolved {
                            resolved = true
                            call.resolve(["port": Int(listener.port?.rawValue ?? 0)])
                        }
                    case .failed(let error):
                        if !resolved {
                            resolved = true
                            call.reject("Could not start the game server: \(error)")
                        }
                    default:
                        break
                    }
                }
                self.listener = listener
                listener.start(queue: self.queue)
            } catch {
                call.reject("Could not start the game server: \(error)")
            }
        }
    }

    private func accept(_ conn: NWConnection) {
        let id = "p\(nextPeer)"
        nextPeer += 1
        peers[id] = conn
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.notifyListeners("peerJoined", data: ["peer": id])
            case .failed, .cancelled:
                self?.dropPeer(id)
            default:
                break
            }
        }
        conn.start(queue: queue)
        receiveFrames(on: conn, onFrame: { [weak self] data in
            self?.notifyListeners("peerData", data: ["peer": id, "data": data.base64EncodedString()])
        }, onClose: { [weak self] in
            self?.queue.async { self?.dropPeer(id) }
        })
    }

    private func dropPeer(_ id: String) {
        guard let conn = peers.removeValue(forKey: id) else { return }
        conn.cancel()
        notifyListeners("peerLeft", data: ["peer": id])
    }

    @objc func stopHost(_ call: CAPPluginCall) {
        queue.async {
            self.stopHostInternal()
            call.resolve()
        }
    }

    private func stopHostInternal() {
        listener?.cancel()
        listener = nil
        for conn in peers.values { conn.cancel() }
        peers.removeAll()
    }

    @objc func sendToPeer(_ call: CAPPluginCall) {
        let peer = call.getString("peer") ?? ""
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.resolve()
            return
        }
        queue.async {
            if let conn = self.peers[peer] { self.send(data, on: conn) }
            call.resolve()
        }
    }

    @objc func broadcast(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.resolve()
            return
        }
        queue.async {
            for conn in self.peers.values { self.send(data, on: conn) }
            call.resolve()
        }
    }

    // MARK: discovery

    @objc func startDiscovery(_ call: CAPPluginCall) {
        queue.async {
            self.browser?.cancel()
            self.endpoints.removeAll()
            let browser = NWBrowser(for: .bonjour(type: LanNetPlugin.serviceType, domain: nil), using: LanNetPlugin.parameters())
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                guard let self = self else { return }
                var games: [[String: Any]] = []
                var found: [String: NWEndpoint] = [:]
                for result in results {
                    if case let .service(name, _, _, _) = result.endpoint {
                        found[name] = result.endpoint
                        // iOS connects by Bonjour endpoint, so host/port are placeholders.
                        games.append(["id": name, "name": name, "host": name, "port": 0])
                    }
                }
                self.endpoints = found
                self.notifyListeners("gamesChanged", data: ["games": games])
            }
            self.browser = browser
            browser.start(queue: self.queue)
            call.resolve()
        }
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        queue.async {
            self.browser?.cancel()
            self.browser = nil
            call.resolve()
        }
    }

    // MARK: client

    @objc func connect(_ call: CAPPluginCall) {
        let host = call.getString("host") ?? ""
        let port = call.getInt("port") ?? 0
        queue.async {
            self.hostConnection?.cancel()
            let endpoint: NWEndpoint
            if let ep = self.endpoints[host] {
                endpoint = ep
            } else if port > 0, let p = NWEndpoint.Port(rawValue: UInt16(port)) {
                endpoint = .hostPort(host: NWEndpoint.Host(host), port: p)
            } else {
                call.reject("Game not found")
                return
            }
            let conn = NWConnection(to: endpoint, using: LanNetPlugin.parameters())
            self.hostConnection = conn
            var resolved = false
            conn.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    if !resolved {
                        resolved = true
                        call.resolve()
                    }
                case .failed(let error):
                    if !resolved {
                        resolved = true
                        call.reject("Could not connect: \(error)")
                    } else {
                        self?.hostLost(conn)
                    }
                case .cancelled:
                    self?.hostLost(conn)
                default:
                    break
                }
            }
            conn.start(queue: self.queue)
            self.receiveFrames(on: conn, onFrame: { [weak self] data in
                self?.notifyListeners("hostData", data: ["data": data.base64EncodedString()])
            }, onClose: { [weak self] in
                self?.queue.async { self?.hostLost(conn) }
            })
        }
    }

    private func hostLost(_ conn: NWConnection) {
        guard hostConnection === conn else { return }
        hostConnection = nil
        conn.cancel()
        notifyListeners("hostClosed", data: ["reason": "The host left or the connection was lost."])
    }

    @objc func sendToHost(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.resolve()
            return
        }
        queue.async {
            if let conn = self.hostConnection { self.send(data, on: conn) }
            call.resolve()
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        queue.async {
            let conn = self.hostConnection
            self.hostConnection = nil
            conn?.cancel()
            call.resolve()
        }
    }
}

/// Bridge view controller that registers our in-app plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LanNetPlugin())
    }
}
