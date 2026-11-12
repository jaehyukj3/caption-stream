package io.github.jaehyukj3.captionhost

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * 인터넷 없이 같은 와이파이(이 폰의 핫스팟 등)로 참석자에게 자막을 보내는 작은 서버.
 * 노트북 프로그램의 '같은 와이파이' 접속과 같은 방식이다:
 *  - GET /view/<방 코드>, /assets/…: 앱에 넣어 둔 참석자 화면 파일
 *  - WebSocket /ws: 참석자 연결. 오가는 글은 화면(자바스크립트)의 방이 처리한다 (onOpen/onMessage/onClose, send)
 * 안드로이드에 기대지 않아(java.net만 씀) 노트북에서도 시험할 수 있다.
 */
class LocalServer(
    /** 화면 파일 (경로 → 내용, 없으면 null) */
    private val asset: (String) -> ByteArray?,
    private val onOpen: (Int) -> Unit,
    private val onMessage: (Int, String) -> Unit,
    private val onClose: (Int) -> Unit,
) {
    private var server: ServerSocket? = null
    private val clients = ConcurrentHashMap<Int, Client>()
    private val nextId = AtomicInteger(1)
    @Volatile private var running = false

    val port: Int get() = server?.localPort ?: 0
    val isRunning: Boolean get() = running

    /** 서버를 연다 (이미 열려 있으면 그대로). 8080이 쓰이고 있으면 아무 빈 번호로. */
    @Synchronized
    fun start(preferredPort: Int = 8080): Int {
        if (running) return port
        val s = ServerSocket()
        s.reuseAddress = true
        try {
            s.bind(InetSocketAddress(preferredPort))
        } catch (_: Exception) {
            s.bind(InetSocketAddress(0))
        }
        server = s
        running = true
        Thread({ acceptLoop(s) }, "lan-accept").apply { isDaemon = true; start() }
        return s.localPort
    }

    @Synchronized
    fun stop() {
        running = false
        try { server?.close() } catch (_: Exception) {}
        server = null
        for (c in clients.values) c.close()
        clients.clear()
    }

    /** 참석자 모두의 연결을 끊는다 (서버는 그대로: 화면을 새로 열었을 때) */
    fun dropAll() {
        for (c in clients.values) c.close()
    }

    fun send(id: Int, text: String) {
        clients[id]?.sendText(text)
    }

    private fun acceptLoop(s: ServerSocket) {
        while (running) {
            val sock = try {
                s.accept()
            } catch (_: Exception) {
                break
            }
            Thread({ handle(sock) }, "lan-conn").apply { isDaemon = true; start() }
        }
    }

    private fun handle(sock: Socket) {
        try {
            sock.tcpNoDelay = true
            sock.soTimeout = 0
            val input = BufferedInputStream(sock.getInputStream())
            val out = sock.getOutputStream()
            val head = readHead(input) ?: return sock.close()
            val lines = head.split("\r\n")
            val parts = lines[0].split(" ")
            if (parts.size < 2 || parts[0] != "GET") return respond(out, 405, "text/plain", "method not allowed".toByteArray()).also { sock.close() }
            val headers = lines.drop(1).mapNotNull { l -> l.indexOf(':').takeIf { it > 0 }?.let { l.substring(0, it).trim().lowercase() to l.substring(it + 1).trim() } }.toMap()
            val path = parts[1].substringBefore('?').substringBefore('#')
            if (path == WS_PATH && headers["upgrade"]?.lowercase() == "websocket") {
                val key = headers["sec-websocket-key"] ?: return sock.close()
                val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + WS_GUID).toByteArray()))
                out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
                out.flush()
                val c = Client(nextId.getAndIncrement(), sock, out)
                clients[c.id] = c
                onOpen(c.id)
                try {
                    c.readLoop(input)
                } finally {
                    clients.remove(c.id)
                    c.close()
                    onClose(c.id)
                }
                return
            }
            serveFile(out, path)
            sock.close()
        } catch (_: Exception) {
            try { sock.close() } catch (_: Exception) {}
        }
    }

    private fun serveFile(out: OutputStream, path: String) {
        val file = when {
            path == "/" || path == "/view" || path.startsWith("/view/") -> "index.html"
            path.startsWith("/assets/") || path == "/version.json" -> path.removePrefix("/")
            else -> null
        }
        val body = file?.takeIf { !it.contains("..") }?.let(asset)
        if (body == null) return respond(out, 404, "text/plain", "not found".toByteArray())
        respond(out, 200, mime(file), body, if (file == "index.html") "no-cache" else "public, max-age=31536000, immutable")
    }

    private fun respond(out: OutputStream, status: Int, type: String, body: ByteArray, cache: String = "no-cache") {
        val reason = mapOf(200 to "OK", 404 to "Not Found", 405 to "Method Not Allowed")[status] ?: "OK"
        out.write("HTTP/1.1 $status $reason\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nCache-Control: $cache\r\nConnection: close\r\n\r\n".toByteArray())
        out.write(body)
        out.flush()
    }

    /** 참석자 한 명의 WebSocket 연결 (RFC 6455, 글 메시지만) */
    private inner class Client(val id: Int, private val sock: Socket, private val out: OutputStream) {
        @Volatile private var closed = false

        fun readLoop(input: InputStream) {
            val message = ByteArrayOutputStream()
            while (!closed) {
                val b0 = input.read()
                if (b0 < 0) return
                val b1 = input.read()
                if (b1 < 0) return
                val fin = b0 and 0x80 != 0
                val op = b0 and 0x0f
                var len = (b1 and 0x7f).toLong()
                if (len == 126L) {
                    val e = readN(input, 2)
                    len = (((e[0].toInt() and 0xff) shl 8) or (e[1].toInt() and 0xff)).toLong()
                } else if (len == 127L) {
                    len = readN(input, 8).fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xff) }
                }
                val mask = if (b1 and 0x80 != 0) readN(input, 4) else null
                if (len > MAX_MESSAGE) return
                val data = readN(input, len.toInt())
                if (mask != null) for (i in data.indices) data[i] = (data[i].toInt() xor mask[i % 4].toInt()).toByte()
                when (op) {
                    0x0, 0x1 -> {
                        message.write(data)
                        if (message.size() > MAX_MESSAGE) return
                        if (fin) {
                            onMessage(id, message.toString(Charsets.UTF_8.name()))
                            message.reset()
                        }
                    }
                    0x8 -> return
                    0x9 -> sendFrame(0xA, data)
                    else -> {}
                }
            }
        }

        fun sendText(text: String) = sendFrame(0x1, text.toByteArray(Charsets.UTF_8))

        @Synchronized
        private fun sendFrame(op: Int, payload: ByteArray) {
            if (closed) return
            try {
                val head = ByteArrayOutputStream()
                head.write(0x80 or op)
                when {
                    payload.size < 126 -> head.write(payload.size)
                    payload.size < 65536 -> { head.write(126); head.write(payload.size shr 8); head.write(payload.size and 0xff) }
                    else -> { head.write(127); for (s in 56 downTo 0 step 8) head.write(((payload.size.toLong() shr s) and 0xff).toInt()) }
                }
                out.write(head.toByteArray())
                out.write(payload)
                out.flush()
            } catch (_: Exception) {
                close()
            }
        }

        fun close() {
            if (closed) return
            closed = true
            try {
                synchronized(this) { out.write(byteArrayOf(0x88.toByte(), 0)); out.flush() }
            } catch (_: Exception) {}
            try { sock.close() } catch (_: Exception) {}
        }
    }

    companion object {
        const val WS_PATH = "/ws"
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val MAX_MESSAGE = 64 * 1024

        private fun readHead(input: InputStream): String? {
            val buf = ByteArrayOutputStream()
            var last4 = 0
            while (buf.size() < 16 * 1024) {
                val b = input.read()
                if (b < 0) return null
                buf.write(b)
                last4 = (last4 shl 8) or b
                if (last4 == 0x0d0a0d0a) return buf.toString(Charsets.ISO_8859_1.name())
            }
            return null
        }

        private fun readN(input: InputStream, n: Int): ByteArray {
            val b = ByteArray(n)
            var o = 0
            while (o < n) {
                val r = input.read(b, o, n - o)
                if (r < 0) throw java.io.EOFException()
                o += r
            }
            return b
        }

        private fun mime(file: String) = when (file.substringAfterLast('.')) {
            "html" -> "text/html; charset=utf-8"
            "js", "mjs" -> "text/javascript; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "json" -> "application/json; charset=utf-8"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }

        /**
         * 참석자가 접속할 이 폰의 주소들 (IPv4). 핫스팟 쪽(ap·swlan·softap)을 맨 앞에, 그다음 접속한 와이파이.
         * 모바일 데이터(rmnet 등)는 같은 와이파이가 아니므로 뺀다.
         */
        fun addresses(): List<String> {
            val list = ArrayList<Pair<Int, String>>()
            try {
                for (ni in NetworkInterface.getNetworkInterfaces()) {
                    if (!ni.isUp || ni.isLoopback) continue
                    val name = ni.name.lowercase()
                    if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("tun") || name.startsWith("dummy")) continue
                    val rank = when {
                        name.startsWith("ap") || name.startsWith("swlan") || name.contains("softap") || name.startsWith("wlan1") -> 0
                        name.startsWith("wlan") -> 1
                        else -> 2
                    }
                    for (a in ni.inetAddresses) if (a is Inet4Address && a.isSiteLocalAddress) list.add(rank to a.hostAddress!!)
                }
            } catch (_: Exception) {}
            return list.sortedBy { it.first }.map { it.second }.distinct()
        }
    }
}
