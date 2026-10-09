package com.attahamamah.spotkick;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Local Wi-Fi multiplayer for Spot Kick.
 *
 * Host: opens a TCP server and advertises it with Android NSD (Bonjour / mDNS) as "_spotkick._tcp".
 * Client: discovers those services, connects, and exchanges length-prefixed binary frames.
 * Frames cross the JS bridge as base64 strings.
 */
@CapacitorPlugin(name = "LanNet")
public class LanNetPlugin extends Plugin {
    private static final String TAG = "LanNet";
    private static final String SERVICE_TYPE = "_spotkick._tcp.";
    private static final int MAX_FRAME = 1 << 20;

    private NsdManager nsd;
    private WifiManager.MulticastLock multicastLock;

    // Host side
    private ServerSocket server;
    private NsdManager.RegistrationListener registration;
    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private final AtomicInteger nextPeer = new AtomicInteger(1);

    // Client side
    private Peer hostConn;
    private NsdManager.DiscoveryListener discovery;
    private final Map<String, JSObject> games = new ConcurrentHashMap<>();
    private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    private boolean resolving = false;

    private final ExecutorService io = Executors.newCachedThreadPool();

    /** One TCP connection with its own writer thread, so sends never block the UI. */
    private class Peer {
        final String id;
        final Socket socket;
        final DataOutputStream out;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        volatile boolean closed = false;

        Peer(String id, Socket socket) throws IOException {
            this.id = id;
            this.socket = socket;
            socket.setTcpNoDelay(true);
            this.out = new DataOutputStream(socket.getOutputStream());
        }

        void send(byte[] data) {
            if (closed) return;
            writer.execute(() -> {
                try {
                    out.writeInt(data.length);
                    out.write(data);
                    out.flush();
                } catch (IOException e) {
                    close();
                }
            });
        }

        void close() {
            if (closed) return;
            closed = true;
            try {
                socket.close();
            } catch (IOException ignored) {
            }
            writer.shutdown();
        }
    }

    interface FrameHandler {
        void onFrame(byte[] data);
    }

    private void readLoop(Peer peer, FrameHandler onFrame, Runnable onClose) {
        io.execute(() -> {
            try {
                DataInputStream in = new DataInputStream(peer.socket.getInputStream());
                while (!peer.closed) {
                    int len = in.readInt();
                    if (len < 0 || len > MAX_FRAME) break;
                    byte[] buf = new byte[len];
                    in.readFully(buf);
                    onFrame.onFrame(buf);
                }
            } catch (IOException ignored) {
            } finally {
                peer.close();
                onClose.run();
            }
        });
    }

    private static String b64(byte[] data) {
        return Base64.encodeToString(data, Base64.NO_WRAP);
    }

    private static byte[] unb64(String s) {
        return Base64.decode(s, Base64.NO_WRAP);
    }

    @Override
    public void load() {
        nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            multicastLock = wifi.createMulticastLock("spotkick-lan");
            multicastLock.setReferenceCounted(false);
        }
    }

    // ------------------------------------------------------------------ host

    @PluginMethod
    public void startHost(PluginCall call) {
        String name = call.getString("name", "Spot Kick");
        stopHostInternal();
        io.execute(() -> {
            try {
                server = new ServerSocket();
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(0));
                int port = server.getLocalPort();
                acceptLoop(server);

                NsdServiceInfo info = new NsdServiceInfo();
                info.setServiceName(name);
                info.setServiceType(SERVICE_TYPE);
                info.setPort(port);
                registration = new NsdManager.RegistrationListener() {
                    @Override
                    public void onServiceRegistered(NsdServiceInfo s) {
                        Log.i(TAG, "advertising " + s.getServiceName());
                    }

                    @Override
                    public void onRegistrationFailed(NsdServiceInfo s, int err) {
                        Log.w(TAG, "registration failed " + err);
                    }

                    @Override
                    public void onServiceUnregistered(NsdServiceInfo s) {}

                    @Override
                    public void onUnregistrationFailed(NsdServiceInfo s, int err) {}
                };
                if (multicastLock != null) multicastLock.acquire();
                nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
                JSObject ret = new JSObject();
                ret.put("port", port);
                call.resolve(ret);
            } catch (IOException e) {
                call.reject("Could not start the game server: " + e.getMessage());
            }
        });
    }

    private void acceptLoop(ServerSocket s) {
        io.execute(() -> {
            while (!s.isClosed()) {
                try {
                    Socket socket = s.accept();
                    String id = "p" + nextPeer.getAndIncrement();
                    Peer peer = new Peer(id, socket);
                    peers.put(id, peer);
                    JSObject joined = new JSObject();
                    joined.put("peer", id);
                    notifyListeners("peerJoined", joined);
                    readLoop(peer, (data) -> {
                        JSObject ev = new JSObject();
                        ev.put("peer", id);
                        ev.put("data", b64(data));
                        notifyListeners("peerData", ev);
                    }, () -> {
                        if (peers.remove(id) != null) {
                            JSObject left = new JSObject();
                            left.put("peer", id);
                            notifyListeners("peerLeft", left);
                        }
                    });
                } catch (IOException e) {
                    break;
                }
            }
        });
    }

    @PluginMethod
    public void stopHost(PluginCall call) {
        stopHostInternal();
        call.resolve();
    }

    private void stopHostInternal() {
        if (registration != null) {
            try {
                nsd.unregisterService(registration);
            } catch (IllegalArgumentException ignored) {
            }
            registration = null;
        }
        for (Peer p : peers.values()) p.close();
        peers.clear();
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
            }
            server = null;
        }
        if (multicastLock != null && multicastLock.isHeld() && discovery == null) multicastLock.release();
    }

    @PluginMethod
    public void sendToPeer(PluginCall call) {
        Peer p = peers.get(call.getString("peer", ""));
        String data = call.getString("data");
        if (p != null && data != null) p.send(unb64(data));
        call.resolve();
    }

    @PluginMethod
    public void broadcast(PluginCall call) {
        String data = call.getString("data");
        if (data != null) {
            byte[] bytes = unb64(data);
            for (Peer p : peers.values()) p.send(bytes);
        }
        call.resolve();
    }

    // ------------------------------------------------------------------ discovery

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        stopDiscoveryInternal();
        games.clear();
        if (multicastLock != null) multicastLock.acquire();
        discovery = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String type) {}

            @Override
            public void onDiscoveryStopped(String type) {}

            @Override
            public void onStartDiscoveryFailed(String type, int err) {
                Log.w(TAG, "discovery failed " + err);
            }

            @Override
            public void onStopDiscoveryFailed(String type, int err) {}

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                synchronized (resolveQueue) {
                    resolveQueue.add(info);
                }
                resolveNext();
            }

            @Override
            public void onServiceLost(NsdServiceInfo info) {
                if (games.remove(info.getServiceName()) != null) emitGames();
            }
        };
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
        call.resolve();
    }

    /** NsdManager can only resolve one service at a time on older Android versions. */
    @SuppressWarnings("deprecation")
    private void resolveNext() {
        NsdServiceInfo next;
        synchronized (resolveQueue) {
            if (resolving || resolveQueue.isEmpty()) return;
            resolving = true;
            next = resolveQueue.poll();
        }
        nsd.resolveService(next, new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo info, int err) {
                done();
            }

            @Override
            public void onServiceResolved(NsdServiceInfo info) {
                InetAddress addr = info.getHost();
                if (addr != null) {
                    JSObject g = new JSObject();
                    g.put("id", info.getServiceName());
                    g.put("name", info.getServiceName());
                    g.put("host", addr.getHostAddress());
                    g.put("port", info.getPort());
                    games.put(info.getServiceName(), g);
                    emitGames();
                }
                done();
            }

            private void done() {
                synchronized (resolveQueue) {
                    resolving = false;
                }
                resolveNext();
            }
        });
    }

    private void emitGames() {
        JSArray list = new JSArray();
        for (JSObject g : games.values()) list.put(g);
        JSObject ev = new JSObject();
        ev.put("games", list);
        notifyListeners("gamesChanged", ev);
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        stopDiscoveryInternal();
        call.resolve();
    }

    private void stopDiscoveryInternal() {
        if (discovery != null) {
            try {
                nsd.stopServiceDiscovery(discovery);
            } catch (IllegalArgumentException ignored) {
            }
            discovery = null;
        }
        if (multicastLock != null && multicastLock.isHeld() && registration == null) multicastLock.release();
    }

    // ------------------------------------------------------------------ client

    @PluginMethod
    public void connect(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 0);
        disconnectInternal();
        io.execute(() -> {
            try {
                Socket socket = new Socket();
                socket.connect(new InetSocketAddress(host, port), 4000);
                Peer conn = new Peer("host", socket);
                hostConn = conn;
                readLoop(conn, (data) -> {
                    JSObject ev = new JSObject();
                    ev.put("data", b64(data));
                    notifyListeners("hostData", ev);
                }, () -> {
                    if (hostConn == conn) {
                        hostConn = null;
                        JSObject ev = new JSObject();
                        ev.put("reason", "The host left or the connection was lost.");
                        notifyListeners("hostClosed", ev);
                    }
                });
                call.resolve();
            } catch (IOException e) {
                call.reject("Could not connect: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void sendToHost(PluginCall call) {
        Peer c = hostConn;
        String data = call.getString("data");
        if (c != null && data != null) c.send(unb64(data));
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        disconnectInternal();
        call.resolve();
    }

    private void disconnectInternal() {
        Peer c = hostConn;
        hostConn = null;
        if (c != null) c.close();
    }

    @Override
    protected void handleOnDestroy() {
        stopDiscoveryInternal();
        stopHostInternal();
        disconnectInternal();
        io.shutdownNow();
    }
}
