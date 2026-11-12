package io.github.jaehyukj3.captionhost

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 송출 화면(사이트의 /host)을 그대로 띄우고, 음성인식만 앱이 직접 한다.
 * 방 만들기·암호화·참석자 연결은 웹 송출과 똑같이 화면(자바스크립트)이 맡는다.
 * 인터넷이 없으면 앱에 넣어 둔 같은 화면 파일(assets/site)로 연다: 자막은 이 폰 화면에 보이고, 인터넷이 되면 중계가 저절로 붙는다.
 *
 * 화면 ↔ 앱 연결
 *  - 화면 → 앱: window.CaptionNative.prepare() / start() / stop() / saveFile(이름, 형식, base64) / recentAudio() / version()
 *    폰 내장 음성인식: systemAvailable() / prepareSystem() / startSystem() (멈추기는 stop())
 *  - 앱 → 화면: window.__captionNative.emit({op: ...})
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val site = Uri.parse(BuildConfig.SITE)
    private val models by lazy { ModelStore(this, BuildConfig.SITE) }
    private val engine = SpeechEngine(::emit)
    /** 폰에 들어 있는 기기 안 음성인식 (갤럭시·구글) */
    private val system by lazy { SystemSpeechEngine.create(this, ::emit) }
    /** 마이크 권한을 물은 뒤 어느 방식으로 시작할지 */
    @Volatile private var pendingSystem = false
    /** 모델 준비·마이크 켜고 끄기는 차례대로 (인식 자체는 SpeechEngine의 스레드에서) */
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var preparing = false
    /** 인터넷 없이 같은 와이파이(이 폰의 핫스팟)로 참석자를 받는 서버. 화면이 열어 달라고 할 때 연다 */
    private val lan by lazy {
        LocalServer(
            asset = { path ->
                try {
                    assets.open("site/$path").use { it.readBytes() }
                } catch (_: java.io.IOException) {
                    null
                }
            },
            onOpen = { id -> emit(SpeechEngine.event("lanOpen").put("id", id)) },
            onMessage = { id, data -> emit(SpeechEngine.event("lanMsg").put("id", id).put("data", data)) },
            onClose = { id -> emit(SpeechEngine.event("lanClose").put("id", id)) },
        )
    }
    /** 사이트에 닿지 않아(인터넷 없음·차단) 앱에 넣어 둔 화면 파일로 여는 중 */
    @Volatile private var offline = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 화면이 꺼지면 송출이 멈추므로 켜 둔다
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString CaptionHostApp/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(Bridge(), "CaptionNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (isHostPage(request.url)) return false
                // 참석자 화면 링크 등은 브라우저로 연다 (이 화면에서 벗어나면 송출이 끝나므로)
                openExternal(request.url)
                return true
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val u = request.url
                if (request.method != "GET" || u.host != site.host) return null
                if (!offline && hasInternet()) return null
                return bundled(u.path ?: "/") // 넣어 둔 파일이 없으면(중계 연결 등) 그대로 네트워크로
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // 인터넷은 잡히는데 사이트가 막힌 경우(기관 방화벽 등): 넣어 둔 화면으로 다시 연다
                if (request.isForMainFrame && !offline && isHostPage(request.url)) {
                    offline = true
                    view.post { view.loadUrl(request.url.toString()) }
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                // 화면을 새로 열면(새로고침 등) 이전 화면이 켜 둔 마이크는 끈다
                worker.execute { engine.stop() }
                system?.stop {}
                // 새 화면은 새 방이므로 이전 방의 참석자 연결은 끊는다
                lan.dropAll()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // 화면이 브라우저 방식(기기 안 인식 WebAssembly)을 고른 경우를 위한 마이크 허용
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val wantsMic = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
                    if (wantsMic && request.origin.host == site.host && hasMic()) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    else request.deny()
                }
            }
        }
        web.loadUrl("${BuildConfig.SITE}/host")
        checkUpdate()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) {
            web.goBack()
            return
        }
        AlertDialog.Builder(this)
            .setMessage("앱을 닫을까요? 송출 중이면 자막이 끝납니다.")
            .setPositiveButton("닫기") { _, _ -> finish() }
            .setNegativeButton("취소", null)
            .show()
    }

    override fun onDestroy() {
        lan.stop()
        system?.stop {}
        worker.execute { engine.stop() }
        worker.shutdown()
        web.destroy()
        super.onDestroy()
    }

    /** 실제로 인터넷이 되는지 (와이파이에 붙어 있어도 인터넷이 없는 핫스팟이면 false) */
    private fun hasInternet(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** 앱에 넣어 둔 화면 파일. /host 등 화면 주소는 index.html, 나머지는 같은 경로의 파일 */
    private fun bundled(path: String): WebResourceResponse? {
        val file = when {
            path == "/" || path == "/host" || path.startsWith("/host/") -> "index.html"
            path.startsWith("/assets/") || path == "/version.json" || path.matches(Regex("/[\\w.-]+\\.(svg|png|ico|webmanifest)")) -> path.removePrefix("/")
            else -> return null
        }
        val stream = try {
            assets.open("site/$file")
        } catch (_: java.io.IOException) {
            return null
        }
        val mime = when (file.substringAfterLast('.')) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "ico" -> "image/x-icon"
            "webmanifest" -> "application/manifest+json"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }
        return WebResourceResponse(mime, "utf-8", stream)
    }

    private fun isHostPage(uri: Uri?) =
        uri != null && uri.scheme == site.scheme && uri.host == site.host && (uri.path ?: "").let { it == "/host" || it.startsWith("/host/") }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(this, "열 수 있는 앱이 없습니다: $uri", Toast.LENGTH_LONG).show()
        }
    }

    private fun hasMic() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** 앱 → 화면 알림 */
    private fun emit(event: JSONObject) {
        val js = "window.__captionNative && window.__captionNative.emit($event)"
        web.post { web.evaluateJavascript(js, null) }
    }

    private fun prepare() {
        if (engine.isLoaded) {
            emit(SpeechEngine.event("ready"))
            return
        }
        if (preparing) return
        preparing = true
        worker.execute {
            try {
                var lastPct = -1L
                val model = models.ensure { loaded, total ->
                    val pct = loaded * 100 / total
                    if (pct != lastPct) {
                        lastPct = pct
                        emit(SpeechEngine.event("progress").put("loaded", loaded).put("total", total))
                    }
                }
                emit(SpeechEngine.event("loading"))
                engine.load(model)
                emit(SpeechEngine.event("ready"))
            } catch (e: Throwable) {
                emit(SpeechEngine.event("error").put("where", "prepare").put("message", e.message ?: e.toString()))
            } finally {
                preparing = false
            }
        }
    }

    private fun startMic() {
        worker.execute {
            val err = engine.start()
            if (err == null) emit(SpeechEngine.event("listening"))
            else emit(SpeechEngine.event("micError").put("message", err))
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        if (hasMic()) {
            if (pendingSystem) system?.start() else startMic()
            return
        }
        // 다시 묻지 않음 상태면 설정 화면으로 안내
        val blocked = !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
        emit(
            SpeechEngine.event("micError").put(
                "message",
                if (blocked) "마이크 권한이 꺼져 있습니다. 휴대폰 설정 → 애플리케이션 → 강의 자막 송출 → 권한에서 마이크를 허용해 주세요."
                else "마이크 권한이 거부되었습니다. 다시 ‘마이크 시작’을 누르고 허용해 주세요.",
            ),
        )
        if (blocked) {
            runOnUiThread {
                AlertDialog.Builder(this)
                    .setMessage("마이크 권한이 꺼져 있습니다. 설정에서 허용해 주세요.")
                    .setPositiveButton("설정 열기") { _, _ ->
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                    }
                    .setNegativeButton("취소", null)
                    .show()
            }
        }
    }

    /** 파일을 다운로드 폴더에 저장 (화면의 '자막 저장' 등) */
    private fun save(name: String, mime: String, bytes: ByteArray) {
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("저장 위치를 만들지 못했습니다")
                contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE)
                    error("저장 권한을 허용한 뒤 다시 눌러 주세요")
                }
                dir.mkdirs()
                File(dir, safe).writeBytes(bytes)
            }
            toast("다운로드 폴더에 저장했습니다: $safe")
        } catch (e: Exception) {
            toast("저장하지 못했습니다: ${e.message}")
        }
    }

    private fun toast(message: String) = runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }

    /** 새 버전이 있으면 받기 안내 (사이트의 /app/version.json) */
    private fun checkUpdate() {
        Thread {
            try {
                val conn = URL("${BuildConfig.SITE}/app/version.json").openConnection() as HttpURLConnection
                conn.connectTimeout = 10_000
                conn.readTimeout = 10_000
                conn.useCaches = false
                if (conn.responseCode != 200) return@Thread
                val latest = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                if (latest.optInt("versionCode") <= BuildConfig.VERSION_CODE) return@Thread
                runOnUiThread {
                    AlertDialog.Builder(this)
                        .setTitle("새 버전이 있습니다")
                        .setMessage("${latest.optString("versionName")} 버전을 받아 설치해 주세요. (지금 버전 ${BuildConfig.VERSION_NAME})")
                        .setPositiveButton("받기") { _, _ -> openExternal(Uri.parse("${BuildConfig.SITE}/download/android")) }
                        .setNegativeButton("나중에", null)
                        .show()
                }
            } catch (_: Exception) {
                // 확인 못 해도 그대로 쓴다
            }
        }.start()
    }

    /** 화면(자바스크립트)에서 부르는 함수들. 화면 스레드가 아닌 곳에서 불린다. */
    inner class Bridge {
        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun prepare() = this@MainActivity.prepare()

        @JavascriptInterface
        fun start() {
            pendingSystem = false
            if (hasMic()) {
                startMic()
                return
            }
            runOnUiThread {
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            }
        }

        /** 폰 내장 인식에 미리 알려 줄 이 강의의 용어 (JSON 문자열 배열) */
        @JavascriptInterface
        fun setBiasing(json: String) {
            val terms = try {
                org.json.JSONArray(json).let { a -> (0 until a.length()).map { a.getString(it) } }
            } catch (_: Exception) {
                emptyList()
            }
            system?.setBiasing(terms)
        }

        @JavascriptInterface
        fun systemAvailable(): Boolean = system?.isAvailable == true

        /** 같은 와이파이(핫스팟) 서버를 열고 주소를 알려 준다: {port, addresses} */
        @JavascriptInterface
        fun lanStart(): String {
            val port = try {
                lan.start()
            } catch (_: Exception) {
                0
            }
            return lanInfoJson(port)
        }

        /** 주소 다시 읽기 (핫스팟을 나중에 켠 경우) */
        @JavascriptInterface
        fun lanInfo(): String = lanInfoJson(if (lan.isRunning) lan.port else 0)

        @JavascriptInterface
        fun lanSend(id: Int, data: String) = lan.send(id, data)

        @JavascriptInterface
        fun lanStop() = lan.stop()

        private fun lanInfoJson(port: Int) = JSONObject().put("port", port).put("addresses", org.json.JSONArray(LocalServer.addresses())).toString()

        /** 기기 안 인식 서비스 정보 (JSON, SystemSpeechEngine.serviceInfo) */
        @JavascriptInterface
        fun systemInfo(): String = system?.serviceInfo()?.toString() ?: "{}"

        @JavascriptInterface
        fun prepareSystem() {
            system?.prepare() ?: emit(SpeechEngine.event("error").put("where", "prepare").put("message", "이 폰은 기기 안 음성인식을 지원하지 않습니다 (안드로이드 12 이상 필요)."))
        }

        @JavascriptInterface
        fun startSystem() {
            pendingSystem = true
            if (hasMic()) {
                system?.start() ?: emit(SpeechEngine.event("micError").put("message", "이 폰은 기기 안 음성인식을 지원하지 않습니다."))
                return
            }
            runOnUiThread {
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            }
        }

        /** 어느 방식이든 멈추고, 말하던 문장까지 확정한 뒤 flushed */
        @JavascriptInterface
        fun stop() {
            worker.execute {
                engine.stop()
                val done = java.util.concurrent.CountDownLatch(1)
                system?.stop { done.countDown() } ?: done.countDown()
                done.await(4, java.util.concurrent.TimeUnit.SECONDS)
                emit(SpeechEngine.event("flushed"))
            }
        }

        @JavascriptInterface
        fun saveFile(name: String, mime: String, base64: String) = save(name, mime, Base64.decode(base64, Base64.DEFAULT))

        /** 진단: 최근 10초 소리 (base64, 16kHz 16비트 PCM) */
        @JavascriptInterface
        fun recentAudio(): String = Base64.encodeToString(engine.recentPcm(), Base64.NO_WRAP)
    }

    private companion object {
        const val REQ_MIC = 1
        const val REQ_STORAGE = 2
    }
}
